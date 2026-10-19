// SPDX-License-Identifier: Apache-2.0
//! Updates (plan 9.3). A release names the four binaries the node runs and the Debian package lock
//! of its image. The binaries are downloaded into the release's own directory, checked against the
//! digests the page pins, and only then does the `current` link move; the services that run a
//! changed binary restart, and a database never stops for it. The packages change only in a
//! maintenance cycle: the lock says which versions the image has, what differs from the node is
//! installed through apt from the release's snapshot, and the node reboots if the kernel or a
//! core library changed.
use crate::Error;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
};

/// A file Cloudflare pins by digest and size, and where to read it (`FleetPinnedFile`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pinned {
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
}
impl Pinned {
    fn parse(value: &Value) -> Option<Self> {
        Some(Self {
            url: value["url"].as_str()?.to_string(),
            sha256: value["sha256"].as_str()?.to_string(),
            size_bytes: value["size_bytes"].as_u64()?,
        })
    }
}

/// The binaries a release names, each under its file name (`FleetReleaseBinaries`).
pub const AGENT: &str = "pgcf-agent";
pub const GATEWAY: &str = "pgcf-native-gateway";
const BINARIES: [&str; 4] = [AGENT, GATEWAY, "pgcf-archive", "pgcf-wal-fetch"];

/// What the desired page says the node runs (`NodeRelease`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Release {
    pub id: String,
    pub binaries: Vec<(String, Pinned)>,
    /// The Debian snapshot the packages of the image's lock come from.
    pub debian_snapshot: String,
    pub package_lock: Pinned,
}
impl Release {
    /// A release of a page that passed the contract's schema.
    pub fn parse(release: &Value) -> Option<Self> {
        Some(Self {
            id: release["id"].as_str()?.to_string(),
            binaries: BINARIES
                .iter()
                .map(|name| Some((name.to_string(), Pinned::parse(&release["binaries"][name])?)))
                .collect::<Option<_>>()?,
            debian_snapshot: release["os"]["debian_snapshot"].as_str()?.to_string(),
            package_lock: Pinned::parse(&release["os"]["package_lock"])?,
        })
    }
}

/// Which services run a binary that this release changes.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Switched {
    pub agent: bool,
    pub gateway: bool,
}

/// Whether the file is the pinned one: its size and digest.
pub fn is_pinned(path: &Path, pinned: &Pinned) -> bool {
    use sha2::{Digest, Sha256};
    fs::read(path).is_ok_and(|bytes| {
        bytes.len() as u64 == pinned.size_bytes && hex(&Sha256::digest(&bytes)) == pinned.sha256
    })
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The release the `current` link of `bin` names, if it names one.
pub fn current_release(bin: &Path) -> Option<String> {
    let target = fs::read_link(bin.join("current")).ok()?;
    Some(target.file_name()?.to_str()?.to_string())
}

/// Puts the release's four binaries into `bin/<id>/`, each of them checked against its pinned
/// size and digest, and moves `bin/current` to that directory. `fetch` brings one pinned file to
/// a path. A binary already there with the pinned digest is not downloaded again, so a call that
/// went down half way is repeated whole. Nothing moves before all four are there. The directories
/// of releases older than the one that ran before are removed.
pub async fn install_binaries<F, Fut>(
    bin: &Path,
    release: &Release,
    fetch: F,
) -> Result<Switched, Error>
where
    F: Fn(Pinned, PathBuf) -> Fut,
    Fut: std::future::Future<Output = Result<(), Error>>,
{
    let directory = bin.join(&release.id);
    fs::create_dir_all(&directory)?;
    for (name, pinned) in &release.binaries {
        let path = directory.join(name);
        if is_pinned(&path, pinned) {
            continue;
        }
        let part = directory.join(format!(".{name}.part"));
        fetch(pinned.clone(), part.clone()).await?;
        if !is_pinned(&part, pinned) {
            let _ = fs::remove_file(&part);
            return Err("a binary does not match its pin".into());
        }
        fs::set_permissions(&part, fs::Permissions::from_mode(0o755))?;
        fs::rename(&part, &path)?;
    }
    let previous = fs::read_link(bin.join("current")).ok();
    let same = previous.as_deref() == Some(directory.as_path());
    let changed = |name: &str| {
        let (_, pinned) = release.binaries.iter().find(|(binary, _)| binary == name)?;
        let old = previous.as_ref()?.join(name);
        Some(!is_pinned(&old, pinned))
    };
    let switched = if same {
        Switched::default()
    } else {
        Switched {
            // Without a release that ran before, nothing runs that could be told to restart.
            agent: changed(AGENT).unwrap_or(false),
            gateway: changed(GATEWAY).unwrap_or(false),
        }
    };
    if !same {
        let link = bin.join(".current.new");
        let _ = fs::remove_file(&link);
        symlink(&directory, &link)?;
        fs::rename(&link, bin.join("current"))?;
        crate::link::file::sync_directory(bin)?;
    }
    prune(bin, &release.id, previous.as_deref());
    Ok(switched)
}

/// Removes the release directories but the new one and the one that ran before it.
fn prune(bin: &Path, keep: &str, previous: Option<&Path>) {
    let Ok(entries) = fs::read_dir(bin) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_release = entry.file_type().is_ok_and(|kind| kind.is_dir());
        if is_release && entry.file_name() != keep && Some(path.as_path()) != previous {
            let _ = fs::remove_dir_all(path);
        }
    }
}

/// One package of the image's lock: the version the image has.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Package {
    pub name: String,
    pub version: String,
    pub pinned: Pinned,
}

/// The image's `packages.lock.json`: the packages apt installs from the snapshot, and the extra
/// ones (cloudflared) that are downloaded as files.
#[derive(Debug, PartialEq, Eq)]
pub struct Lock {
    pub packages: Vec<Package>,
    pub extra: Vec<Package>,
}
impl Lock {
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let value: Value = serde_json::from_slice(bytes).ok()?;
        let list = |key: &str| -> Option<Vec<Package>> {
            value[key]
                .as_array()?
                .iter()
                .map(|entry| {
                    Some(Package {
                        name: entry["name"].as_str()?.to_string(),
                        version: entry["version"].as_str()?.to_string(),
                        pinned: Pinned {
                            url: entry["url"].as_str()?.to_string(),
                            sha256: entry["sha256"].as_str()?.to_string(),
                            size_bytes: entry["size"].as_u64()?,
                        },
                    })
                })
                .collect()
        };
        Some(Self {
            packages: list("packages")?,
            extra: list("extra")?,
        })
    }
}

/// What a maintenance cycle installs.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan {
    /// `name=version` for apt, of the packages the node lacks or has in another version.
    pub versions: Vec<String>,
    /// The extra packages to download and install as files.
    pub files: Vec<Package>,
    /// The kernel or a core library changes: the node reboots.
    pub reboot: bool,
}

/// A kernel image (`linux-image-<abi>`), which is not the meta package `linux-image-amd64`.
fn is_kernel_image(name: &str) -> bool {
    name.strip_prefix("linux-image-")
        .is_some_and(|abi| abi.starts_with(|c: char| c.is_ascii_digit()))
}

/// A package whose change takes a reboot: the kernel, and the libraries every process of the node
/// has mapped.
fn needs_reboot(name: &str) -> bool {
    name.starts_with("linux-image-") || matches!(name, "libc6" | "systemd" | "libsystemd0" | "udev")
}

/// What differs between the lock and the node: nothing, once the node has the lock's versions.
pub fn plan(lock: &Lock, installed: &BTreeMap<String, String>) -> Plan {
    let differs = |package: &&Package| installed.get(&package.name) != Some(&package.version);
    let packages: Vec<&Package> = lock.packages.iter().filter(differs).collect();
    let files: Vec<Package> = lock.extra.iter().filter(differs).cloned().collect();
    Plan {
        versions: packages
            .iter()
            .map(|package| format!("{}={}", package.name, package.version))
            .collect(),
        reboot: packages.iter().any(|package| needs_reboot(&package.name))
            || files.iter().any(|package| needs_reboot(&package.name)),
        files,
    }
}

/// Whether `name` is a Debian package name as the image's lock states one
/// (`infra/node-image/lock.ts`): at least two characters of lower-case letters, digits, `+`, `-`
/// and `.`, the first a letter or a digit. Such a name is neither an option nor a pattern when it
/// is a word of a command line.
pub fn is_package_name(name: &str) -> bool {
    name.len() >= 2
        && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.')
        })
}

/// The installed packages that the lock does not name, which the cycle purges so that the node has
/// the lock's packages and no others (the digest of its hello then equals the release's). Never a
/// kernel image: Debian keeps the previous kernel for the boot menu, the digest leaves idle ones
/// out, and the running one cannot go. Never a name that is not a package name. A lock that names
/// no kernel image is not the lock of an image, which always boots one: it purges nothing.
pub fn purgeable(lock: &Lock, installed: &BTreeMap<String, String>) -> Vec<String> {
    let named = |name: &str| {
        lock.packages
            .iter()
            .chain(&lock.extra)
            .any(|p| p.name == name)
    };
    if !lock
        .packages
        .iter()
        .any(|package| is_kernel_image(&package.name))
    {
        return Vec::new();
    }
    installed
        .keys()
        .filter(|name| !named(name) && !is_kernel_image(name) && is_package_name(name))
        .cloned()
        .collect()
}

/// `names` without the packages that `dpkg-query -W -f '${Package}\t${Essential}\t${Protected}\n'`
/// says are essential or protected: dpkg refuses to remove them (Debian marks `login`, `libgcc-s1`
/// and `systemd-sysv` protected without making them essential), and removing one would end the
/// node.
pub fn without_protected(names: Vec<String>, dpkg: &str) -> Vec<String> {
    let refused: std::collections::BTreeSet<&str> = dpkg
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let name = fields.next()?;
            fields.any(|field| field.trim() == "yes").then_some(name)
        })
        .collect();
    names
        .into_iter()
        .filter(|name| !refused.contains(name.as_str()))
        .collect()
}

/// The installed packages and their versions, from `dpkg-query -W -f '${db:Status-Abbrev}\t${Package}\t${Version}\n'`.
pub fn installed_packages(output: &str) -> BTreeMap<String, String> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let (status, name, version) = (fields.next()?, fields.next()?, fields.next()?);
            (status.trim() == "ii").then(|| (name.to_string(), version.to_string()))
        })
        .collect()
}

/// The packages that count for the node's digest (`packages_sha256` of the contract): of the kernel
/// images (`linux-image-<abi>`) only the running one's. Debian keeps the previous kernel after an
/// update, for the boot menu, while the release's lock holds the one kernel it installs.
pub fn without_idle_kernels(
    mut installed: BTreeMap<String, String>,
    kernel_release: &str,
) -> BTreeMap<String, String> {
    installed.retain(|name, _| match name.strip_prefix("linux-image-") {
        Some(abi) if is_kernel_image(name) => abi == kernel_release,
        _ => true,
    });
    installed
}

/// The digest of a set of installed packages, as the contract states it (`packagesSha256`): sha256
/// over the lines `name=version\n`, sorted as whole lines, bytewise, in lowercase hex.
pub fn packages_digest(installed: &BTreeMap<String, String>) -> String {
    use sha2::{Digest, Sha256};
    let mut lines: Vec<String> = installed
        .iter()
        .map(|(name, version)| format!("{name}={version}\n"))
        .collect();
    lines.sort();
    let mut digest = Sha256::new();
    for line in &lines {
        digest.update(line.as_bytes());
    }
    hex(&digest.finalize())
}

/// The image's apt sources (deb822) with the snapshot of the release: the `URIs:` of the Debian
/// snapshot archives name the snapshot's time. `None` if the file has no such line.
pub fn apt_sources(text: &str, snapshot: &str) -> Option<String> {
    let mut found = false;
    let lines: Vec<String> = text
        .lines()
        .map(|line| {
            let Some(rest) = line.strip_prefix("URIs: https://snapshot.debian.org/archive/") else {
                return line.to_string();
            };
            let Some((archive, _)) = rest.rsplit_once('/') else {
                return line.to_string();
            };
            found = true;
            format!("URIs: https://snapshot.debian.org/archive/{archive}/{snapshot}")
        })
        .collect();
    found.then(|| lines.join("\n") + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::link::test_server::vector;
    use sha2::{Digest, Sha256};

    fn lock() -> Lock {
        let package = |name: &str, version: &str| Package {
            name: name.into(),
            version: version.into(),
            pinned: Pinned {
                url: format!("https://snapshot.example/{name}_{version}.deb"),
                sha256: "a".repeat(64),
                size_bytes: 10,
            },
        };
        Lock {
            packages: vec![
                package("bash", "5.2"),
                package("linux-image-6.12.99-amd64", "6.12.99-1"),
                package("postgresql-18", "18.7-1"),
            ],
            extra: vec![package("cloudflared", "2026.10.1")],
        }
    }
    fn installed(list: &[(&str, &str)]) -> BTreeMap<String, String> {
        list.iter()
            .map(|(name, version)| (name.to_string(), version.to_string()))
            .collect()
    }

    #[test]
    fn a_release_of_the_page_names_four_binaries_the_snapshot_and_the_lock() {
        let page = vector("NodeDesiredPage", "full-page");
        let release = Release::parse(&page["release"]).unwrap();
        assert_eq!(release.id, "release-25");
        assert_eq!(
            release
                .binaries
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            [AGENT, GATEWAY, "pgcf-archive", "pgcf-wal-fetch"]
        );
        assert_eq!(release.binaries[0].1.size_bytes, 1000);
        assert_eq!(release.debian_snapshot, "20261016T000000Z");
        assert_eq!(release.package_lock.size_bytes, 2000);
        assert_eq!(Release::parse(&Value::Null), None);
    }

    #[test]
    fn the_lock_of_the_image_is_read_as_the_builder_writes_it() {
        let lock = Lock::parse(
            br#"{"debian":{"snapshot":"20261016T000000Z"},"extra":[{"name":"cloudflared","version":"2026.10.0",
            "architecture":"amd64","url":"https://github.example/c.deb","sha256":"1111111111111111111111111111111111111111111111111111111111111111","size":19316284}],
            "packages":[{"name":"adduser","version":"3.152","architecture":"all","url":"https://snapshot.example/a.deb",
            "sha256":"2222222222222222222222222222222222222222222222222222222222222222","size":100}]}"#,
        )
        .unwrap();
        assert_eq!(lock.extra[0].pinned.size_bytes, 19_316_284);
        assert_eq!(lock.packages[0].name, "adduser");
        assert_eq!(Lock::parse(b"{}"), None);
        assert_eq!(Lock::parse(b"not json"), None);
    }

    #[test]
    fn only_what_differs_from_the_node_is_installed_and_a_kernel_takes_a_reboot() {
        let current = installed(&[
            ("bash", "5.2"),
            ("linux-image-6.12.99-amd64", "6.12.99-1"),
            ("postgresql-18", "18.7-1"),
            ("cloudflared", "2026.10.1"),
        ]);
        assert_eq!(plan(&lock(), &current), Plan::default());
        // A minor version of PostgreSQL: installed, no reboot (each database picks it up at its
        // next start).
        let older = installed(&[
            ("bash", "5.2"),
            ("linux-image-6.12.99-amd64", "6.12.99-1"),
            ("postgresql-18", "18.6-1"),
            ("cloudflared", "2026.10.0"),
        ]);
        let planned = plan(&lock(), &older);
        assert_eq!(planned.versions, ["postgresql-18=18.7-1"]);
        assert_eq!(planned.files[0].name, "cloudflared");
        assert!(!planned.reboot);
        // A kernel the node does not have yet: its package is new, and the node reboots.
        let without = installed(&[("bash", "5.2"), ("postgresql-18", "18.7-1")]);
        let planned = plan(&lock(), &without);
        assert_eq!(planned.versions, ["linux-image-6.12.99-amd64=6.12.99-1"]);
        assert!(planned.reboot);
    }

    #[test]
    fn what_the_lock_does_not_name_is_purged_but_no_kernel_image_and_no_name_apt_could_take_as_an_option()
     {
        let node = installed(&[
            ("bash", "5.2"),
            ("postgresql-18", "18.7-1"),
            ("cloudflared", "2026.10.1"),
            ("linux-image-6.12.99-amd64", "6.12.99-1"),
            // The previous kernel stays for the boot menu, and a running one is never removed.
            ("linux-image-6.12.88-amd64", "6.12.88-1"),
            ("libdropped1", "1.0"),
            ("libdropped++2", "1.0"),
            ("-rf", "1"),
            ("X", "1"),
            ("Upper", "1"),
        ]);
        assert_eq!(purgeable(&lock(), &node), ["libdropped++2", "libdropped1"]);
        // The node has what the lock names and nothing else: nothing to purge.
        assert_eq!(
            purgeable(&lock(), &plan_installed(&lock())),
            [] as [&str; 0]
        );
        // A lock without a kernel image is not the lock of an image, which boots one: it purges
        // nothing, however little it names.
        let kernelless = Lock {
            packages: lock()
                .packages
                .into_iter()
                .filter(|package| package.name == "bash")
                .collect(),
            extra: vec![],
        };
        assert_eq!(purgeable(&kernelless, &node), [] as [&str; 0]);
        assert_eq!(
            purgeable(
                &Lock {
                    packages: vec![],
                    extra: vec![]
                },
                &node
            ),
            [] as [&str; 0]
        );
    }

    /// The packages a node that runs `lock` has.
    fn plan_installed(lock: &Lock) -> BTreeMap<String, String> {
        lock.packages
            .iter()
            .chain(&lock.extra)
            .map(|package| (package.name.clone(), package.version.clone()))
            .collect()
    }

    #[test]
    fn dpkg_says_which_packages_are_essential_or_protected_and_those_are_never_purged() {
        let names: Vec<String> = ["libdropped1", "bash", "netbase", "login", "libgcc-s1"]
            .map(String::from)
            .into();
        // `dpkg-query -W -f '${Package}\t${Essential}\t${Protected}\n'`: a field is empty or "no"
        // for most packages. Debian marks `login` and `libgcc-s1` protected, not essential.
        let output =
            "libdropped1\t\t\nbash\tyes\tno\nnetbase\tno\t\nlogin\tno\tyes\nlibgcc-s1\t\tyes\n";
        assert_eq!(without_protected(names, output), ["libdropped1", "netbase"]);
    }

    #[test]
    fn dpkg_lists_the_packages_that_are_installed_and_no_others() {
        let output =
            "ii \tbash\t5.2\nrc \told\t1.0\nii \tlibc6\t2.41-1\nhi \theld\t2\nbroken line\n";
        assert_eq!(
            installed_packages(output),
            installed(&[("bash", "5.2"), ("libc6", "2.41-1")])
        );
    }

    #[test]
    fn the_installed_packages_have_the_digest_the_contract_computes() {
        use crate::link::test_server::package_vectors;
        for vector in package_vectors() {
            let (name, dpkg) = (&vector["name"], vector["dpkg"].as_str().unwrap());
            let stated: BTreeMap<String, String> = vector["packages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|package| {
                    (
                        package["name"].as_str().unwrap().to_string(),
                        package["version"].as_str().unwrap().to_string(),
                    )
                })
                .collect();
            let kernel = vector["kernel_release"].as_str().unwrap();
            // A package dpkg lists as removed with its configuration kept ('rc') is not installed.
            let installed = installed_packages(dpkg);
            assert!(!installed.contains_key("oldpkg"), "{name}");
            let counted = without_idle_kernels(installed, kernel);
            assert_eq!(counted, stated, "{name}");
            assert_eq!(
                packages_digest(&counted),
                vector["sha256"].as_str().unwrap(),
                "{name}"
            );
        }
        // One package more, one version more: another set.
        let digest = packages_digest(&installed(&[("bash", "5.2")]));
        let more = installed(&[("bash", "5.2"), ("libc6", "2.41-1")]);
        assert_ne!(packages_digest(&more), digest);
        assert_ne!(packages_digest(&installed(&[("bash", "5.3")])), digest);
    }

    #[test]
    fn of_the_kernel_images_only_the_running_one_counts_for_the_digest() {
        let node = installed(&[
            ("bash", "5.2"),
            ("linux-image-6.12.111+deb13-amd64", "6.12.111-1"),
            ("linux-image-6.12.113+deb13-amd64", "6.12.113-1"),
            ("linux-image-amd64", "6.12.113-1"),
            ("linux-libc-dev", "6.12.113-1"),
        ]);
        // After the reboot into the new kernel the previous one is idle; before it, the new one is.
        assert_eq!(
            without_idle_kernels(node.clone(), "6.12.113+deb13-amd64"),
            installed(&[
                ("bash", "5.2"),
                ("linux-image-6.12.113+deb13-amd64", "6.12.113-1"),
                ("linux-image-amd64", "6.12.113-1"),
                ("linux-libc-dev", "6.12.113-1"),
            ])
        );
        assert_eq!(
            without_idle_kernels(node, "6.12.111+deb13-amd64").len(),
            4,
            "the meta package and the other packages stay"
        );
    }

    #[test]
    fn the_snapshot_of_the_apt_sources_is_the_releases() {
        let sources = "Types: deb\nURIs: https://snapshot.debian.org/archive/debian/20261016T000000Z\nSuites: trixie\n\nTypes: deb\nURIs: https://snapshot.debian.org/archive/debian-security/20261016T000000Z\nSuites: trixie-security\n\nTypes: deb\nURIs: https://apt-archive.postgresql.org/pub/repos/apt\nSuites: trixie-pgdg-archive\n";
        let rewritten = apt_sources(sources, "20261101T000000Z").unwrap();
        assert!(
            rewritten
                .contains("URIs: https://snapshot.debian.org/archive/debian/20261101T000000Z\n")
        );
        assert!(rewritten.contains(
            "URIs: https://snapshot.debian.org/archive/debian-security/20261101T000000Z\n"
        ));
        assert!(rewritten.contains("URIs: https://apt-archive.postgresql.org/pub/repos/apt\n"));
        assert!(!rewritten.contains("20261016"));
        // A file that names no snapshot is not the image's: nothing to rewrite.
        assert_eq!(
            apt_sources(
                "Types: deb\nURIs: https://example.org\n",
                "20261101T000000Z"
            ),
            None
        );
    }

    fn release(id: &str, files: &[(&str, &[u8])]) -> Release {
        Release {
            id: id.into(),
            binaries: files
                .iter()
                .map(|(name, bytes)| {
                    (
                        name.to_string(),
                        Pinned {
                            url: format!("https://releases.example/{id}/{name}"),
                            sha256: hex(&Sha256::digest(bytes)),
                            size_bytes: bytes.len() as u64,
                        },
                    )
                })
                .collect(),
            debian_snapshot: "20261016T000000Z".into(),
            package_lock: Pinned {
                url: String::new(),
                sha256: String::new(),
                size_bytes: 0,
            },
        }
    }
    /// A fetcher that writes what the test serves under the URL, and counts its downloads.
    fn serving(
        files: Vec<(String, Vec<u8>)>,
        count: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    ) -> impl Fn(Pinned, PathBuf) -> std::future::Ready<Result<(), Error>> {
        move |pinned, path| {
            count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let served = files.iter().find(|(url, _)| *url == pinned.url);
            std::future::ready(match served {
                Some((_, bytes)) => fs::write(&path, bytes).map_err(Into::into),
                None => Err("not served".into()),
            })
        }
    }
    fn names() -> [&'static str; 4] {
        [AGENT, GATEWAY, "pgcf-archive", "pgcf-wal-fetch"]
    }

    #[tokio::test]
    async fn the_binaries_are_in_place_and_checked_before_the_link_moves_and_older_releases_go() {
        let bin = crate::link::test_server::tempdir();
        let old: Vec<(&str, &[u8])> = names().iter().map(|n| (*n, b"old".as_slice())).collect();
        let (first, second) = (release("r1", &old), {
            // The agent and the archive client change; the gateway stays as it was.
            release(
                "r2",
                &[
                    (AGENT, b"new agent".as_slice()),
                    (GATEWAY, b"old"),
                    ("pgcf-archive", b"new archive"),
                    ("pgcf-wal-fetch", b"old"),
                ],
            )
        });
        let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let served = |release: &Release, bodies: &[&[u8]]| -> Vec<(String, Vec<u8>)> {
            release
                .binaries
                .iter()
                .zip(bodies)
                .map(|((_, pinned), body)| (pinned.url.clone(), body.to_vec()))
                .collect()
        };
        // The node runs r1.
        let switched = install_binaries(
            &bin,
            &first,
            serving(
                served(&first, &[b"old", b"old", b"old", b"old"]),
                count.clone(),
            ),
        )
        .await
        .unwrap();
        assert_eq!(switched, Switched::default(), "nothing ran before it");
        assert_eq!(current_release(&bin).as_deref(), Some("r1"));
        // r2: a binary that does not match its pin stops the update before anything moves.
        let wrong = serving(
            served(&second, &[b"new agent", b"old", b"tampered!!!", b"old"]),
            count.clone(),
        );
        assert!(install_binaries(&bin, &second, wrong).await.is_err());
        assert_eq!(current_release(&bin).as_deref(), Some("r1"));
        // With the right bytes it moves, and names what changed. The two that did not change are
        // downloaded again, since they were not in r2's directory.
        let before = count.load(std::sync::atomic::Ordering::Relaxed);
        let switched = install_binaries(
            &bin,
            &second,
            serving(
                served(&second, &[b"new agent", b"old", b"new archive", b"old"]),
                count.clone(),
            ),
        )
        .await
        .unwrap();
        assert_eq!(
            switched,
            Switched {
                agent: true,
                gateway: false
            }
        );
        assert_eq!(current_release(&bin).as_deref(), Some("r2"));
        assert!(count.load(std::sync::atomic::Ordering::Relaxed) > before);
        for (name, body) in [(AGENT, "new agent"), ("pgcf-archive", "new archive")] {
            let path = bin.join("current").join(name);
            assert_eq!(fs::read_to_string(&path).unwrap(), body);
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
        // Asked again, with the files in place, nothing is downloaded and nothing restarts.
        let calm = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let switched = install_binaries(&bin, &second, serving(vec![], calm.clone()))
            .await
            .unwrap();
        assert_eq!(switched, Switched::default());
        assert_eq!(calm.load(std::sync::atomic::Ordering::Relaxed), 0);
        // r3 leaves r2 as the release before it and removes r1.
        let third = release("r3", &old);
        install_binaries(
            &bin,
            &third,
            serving(served(&third, &[b"old", b"old", b"old", b"old"]), count),
        )
        .await
        .unwrap();
        let mut left: Vec<String> = fs::read_dir(&*bin)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["current", "r2", "r3"]);
    }
}
