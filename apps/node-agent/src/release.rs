// SPDX-License-Identifier: Apache-2.0
//! What the agent knows about the image it runs from: the version the image was built as, which the
//! enrollment token is bound to, and the release whose binaries run (plan 8, 9.1). The image's
//! builder writes the first as `IMAGE_VERSION` of `os-release`, and the second is the directory
//! `/var/lib/pgcf/bin/current` links to.
use crate::node_link::schema_valid;
use serde_json::json;
use std::path::Path;

/// `IMAGE_VERSION` of an `os-release` file, if it has one.
pub fn image_version(os_release: &str) -> Option<String> {
    os_release.lines().find_map(|line| {
        let value = line.strip_prefix("IMAGE_VERSION=")?.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        (!value.is_empty()).then(|| value.to_string())
    })
}

/// The image version of this node.
pub fn this_image_version() -> Option<String> {
    image_version(&std::fs::read_to_string("/etc/os-release").ok()?)
}

/// The release the `current` link names: the name of the directory it points at, if it is a
/// release identifier of the contract (the hello of the link names it).
pub fn release_id(current: &Path) -> Option<String> {
    let target = std::fs::read_link(current).ok()?;
    let name = target.file_name()?.to_str()?;
    schema_valid("FleetReleaseId", &json!(name)).then(|| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_image_version_is_read_with_or_without_quotes() {
        let text = "ID=debian\nIMAGE_ID=pgcf-node\nIMAGE_VERSION=25\nVERSION_ID=13\n";
        assert_eq!(image_version(text).as_deref(), Some("25"));
        assert_eq!(
            image_version("IMAGE_VERSION=\"2026.10.1\"\n").as_deref(),
            Some("2026.10.1")
        );
        assert_eq!(image_version("IMAGE_VERSION=\n"), None);
        assert_eq!(image_version("ID=debian\nIMAGE_ID=pgcf-node\n"), None);
    }

    #[test]
    fn the_release_is_the_directory_the_current_link_names() {
        let directory = crate::link::test_server::tempdir();
        let bin = &*directory;
        std::fs::create_dir_all(bin.join("r25")).unwrap();
        std::os::unix::fs::symlink(bin.join("r25"), bin.join("current")).unwrap();
        assert_eq!(release_id(&bin.join("current")).as_deref(), Some("r25"));
        // Nothing there, or not a link, or not a release's name: no release.
        assert_eq!(release_id(&bin.join("missing")), None);
        assert_eq!(release_id(&bin.join("r25")), None);
        std::fs::create_dir_all(bin.join("Not A Release")).unwrap();
        std::os::unix::fs::symlink(bin.join("Not A Release"), bin.join("odd")).unwrap();
        assert_eq!(release_id(&bin.join("odd")), None);
    }
}
