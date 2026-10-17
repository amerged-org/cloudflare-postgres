// SPDX-License-Identifier: Apache-2.0
//! The single-writer holder rule of a database volume: one holder file per LV, created only while
//! nothing has the device open, removed only once the device is closed again, and an open device
//! nobody holds is adopted. Every kernel effect goes through `Host`, so the rules are tested on
//! every OS.
use crate::{
    pg_control::Control,
    volume::{VOLUME_GROUP, Volume, lvm_uuid},
};
use pgcf_native_protocol::valid_pattern;
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{ErrorKind, Write},
    os::{fd::OwnedFd, unix::fs::OpenOptionsExt},
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

pub const ADOPTED: &str = "adopted";
pub const MAX_RELEASE_WAIT_MS: u64 = 10_000;

pub trait Host: Send + Sync {
    /// `None`: no such device-mapper device.
    fn device(&self, volume: &Volume) -> Result<Option<Device>, &'static str>;
    fn devices(&self) -> Result<Vec<(String, Device)>, &'static str>;
    /// A detached mount of the volume; its fd lives inside `Mounted`.
    fn mount(&self, volume: &Volume) -> Result<Mounted, &'static str>;
    fn read_control(&self, mounted: &Mounted) -> Result<Control, &'static str>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Device {
    pub open_count: u32,
    pub suspended: bool,
    pub uuid: String,
    pub dev: (u32, u32),
}

/// A detached mount. Dropping it closes its fd.
pub struct Mounted {
    pub fd: OwnedFd,
}

/// How often `release` reads the open count.
const RELEASE_POLL: Duration = Duration::from_millis(20);

pub struct Holders<H: Host> {
    host: H,
    directory: PathBuf,
    volumes: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
/// LVM's UUID text from its 32 characters without dashes.
fn lvm_text(raw: &str) -> String {
    let mut parts = Vec::with_capacity(7);
    let mut at = 0;
    for length in [6, 4, 4, 4, 4, 4, 6] {
        parts.push(&raw[at..at + length]);
        at += length;
    }
    parts.join("-")
}
/// The tenant volume a device-mapper device is, from its name and UUID; `None` for any device
/// that is not a `pgcf` database LV (pools, snapshots, other volume groups).
fn volume_of(name: &str, uuid: &str) -> Option<Volume> {
    let lv_name = name
        .strip_prefix(&format!("{VOLUME_GROUP}-"))?
        .replace("--", "-");
    let raw = uuid.strip_prefix("LVM-")?;
    if raw.len() != 64 || !raw.is_ascii() {
        return None;
    }
    let volume = Volume {
        lv_name,
        lv_uuid: lvm_text(&raw[32..]),
        vg_uuid: lvm_text(&raw[..32]),
    };
    (volume.valid() && volume.dm_name() == name && volume.dm_uuid() == uuid).then_some(volume)
}

impl<H: Host> Holders<H> {
    pub fn new(host: H, directory: PathBuf) -> Self {
        Self {
            host,
            directory,
            volumes: Mutex::new(HashMap::new()),
        }
    }

    /// Records `holder`, the database that runs on the volume; `false` when it held it already.
    pub fn hold(&self, volume: &Volume, holder: &str) -> Result<bool, &'static str> {
        if !volume.valid() || !valid_pattern("database", holder) {
            return Err("invalid");
        }
        let serial = self.serial(&volume.lv_uuid);
        let _serial = lock(&serial);
        match self.read_holder(&volume.lv_uuid)? {
            Some(existing) if existing == holder => return Ok(false),
            Some(_) => return Err("holder_busy"),
            None => {}
        }
        self.usable(volume)?;
        self.create_holder(&volume.lv_uuid, holder)?;
        Ok(true)
    }

    /// Removes `holder` once the device reads closed, waiting at most `wait_ms`; `None` when
    /// nothing held the volume, else the milliseconds it waited.
    pub fn release(
        &self,
        volume: &Volume,
        holder: &str,
        wait_ms: u64,
    ) -> Result<Option<u64>, &'static str> {
        if wait_ms > MAX_RELEASE_WAIT_MS || !volume.valid() || !valid_pattern("database", holder) {
            return Err("invalid");
        }
        let serial = self.serial(&volume.lv_uuid);
        let _serial = lock(&serial);
        match self.read_holder(&volume.lv_uuid)? {
            None => return Ok(None),
            Some(existing) if existing != holder => return Err("holder_mismatch"),
            Some(_) => {}
        }
        let started = Instant::now();
        let wait = Duration::from_millis(wait_ms);
        loop {
            let open = self
                .host
                .device(volume)?
                .map_or(0, |device| device.open_count);
            if open == 0 {
                self.remove_holder(&volume.lv_uuid)?;
                return Ok(Some(
                    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                ));
            }
            if started.elapsed() + RELEASE_POLL > wait {
                return Err("release_timeout");
            }
            std::thread::sleep(RELEASE_POLL);
        }
    }

    /// The background pass: adopt open devices nobody holds, and drop adopted holders once their
    /// device is closed.
    pub fn adopt(&self) -> Result<(), &'static str> {
        let mut known = HashMap::new();
        for (name, device) in self.host.devices()? {
            if let Some(volume) = volume_of(&name, &device.uuid) {
                known.insert(volume.lv_uuid.clone(), volume);
            }
        }
        for volume in known.values() {
            let serial = self.serial(&volume.lv_uuid);
            let _serial = lock(&serial);
            let open = self
                .host
                .device(volume)?
                .is_some_and(|device| device.open_count > 0);
            if open && self.read_holder(&volume.lv_uuid)?.is_none() {
                match self.create_holder(&volume.lv_uuid, ADOPTED) {
                    Ok(()) | Err("holder_busy") => {}
                    Err(code) => return Err(code),
                }
            }
        }
        for (lv_uuid, _) in self.holders()? {
            let serial = self.serial(&lv_uuid);
            let _serial = lock(&serial);
            if self.read_holder(&lv_uuid)?.as_deref() != Some(ADOPTED) {
                continue;
            }
            let closed = match known.get(&lv_uuid) {
                Some(volume) => self
                    .host
                    .device(volume)?
                    .is_none_or(|device| device.open_count == 0),
                None => true,
            };
            if closed {
                self.remove_holder(&lv_uuid)?;
            }
        }
        Ok(())
    }

    /// Every holder file, as (LV UUID, holder), ordered by LV UUID.
    pub fn holders(&self) -> Result<Vec<(String, String)>, &'static str> {
        let mut result = Vec::new();
        for entry in std::fs::read_dir(&self.directory).map_err(|_| "io_failed")? {
            let name = entry.map_err(|_| "io_failed")?.file_name();
            let Some(lv_uuid) = name.to_str().filter(|name| lvm_uuid(name)) else {
                continue;
            };
            if let Some(holder) = self.read_holder(lv_uuid)? {
                result.push((lv_uuid.to_string(), holder));
            }
        }
        result.sort();
        Ok(result)
    }

    /// The device exists, is this LV, is not suspended and nothing has it open.
    fn usable(&self, volume: &Volume) -> Result<Device, &'static str> {
        let device = self.host.device(volume)?.ok_or("volume_missing")?;
        if device.uuid != volume.dm_uuid() {
            return Err("uuid_mismatch");
        }
        if device.suspended {
            return Err("volume_suspended");
        }
        if device.open_count != 0 {
            return Err("volume_open");
        }
        Ok(device)
    }

    fn serial(&self, lv_uuid: &str) -> Arc<Mutex<()>> {
        lock(&self.volumes)
            .entry(lv_uuid.to_string())
            .or_default()
            .clone()
    }

    fn sync_holders(&self) -> Result<(), &'static str> {
        File::open(&self.directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| "io_failed")
    }

    fn create_holder(&self, lv_uuid: &str, holder: &str) -> Result<(), &'static str> {
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.directory.join(lv_uuid))
        {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => return Err("holder_busy"),
            Err(_) => return Err("io_failed"),
        };
        file.write_all(format!("{holder}\n").as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|_| "io_failed")?;
        self.sync_holders()
    }

    fn remove_holder(&self, lv_uuid: &str) -> Result<(), &'static str> {
        match std::fs::remove_file(self.directory.join(lv_uuid)) {
            Ok(()) => self.sync_holders(),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(_) => Err("io_failed"),
        }
    }

    fn read_holder(&self, lv_uuid: &str) -> Result<Option<String>, &'static str> {
        match std::fs::read_to_string(self.directory.join(lv_uuid)) {
            Ok(text) => Ok(Some(text.trim_end_matches('\n').to_string())),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(_) => Err("io_failed"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        path::Path,
        sync::atomic::{AtomicUsize, Ordering},
    };

    const HOLDER: &str = "d0123456789abcdef012";

    fn volume(n: u8) -> Volume {
        Volume {
            lv_name: format!("pvc-0b1c2d3e-4f50-4617-8899-aabbccddee{n:02x}"),
            lv_uuid: format!("aB3dE9-x1y2-Z3w4-v5u6-t7s8-r9q0-P1o2{n:02}"),
            vg_uuid: "Vg0001-a1b2-c3d4-e5f6-g7h8-i9j0-k1l2m3".into(),
        }
    }

    #[derive(Default)]
    struct State {
        devices: HashMap<String, Device>,
        /// Open counts handed out before the stored one, one per `device` call.
        script: VecDeque<u32>,
    }
    struct FakeHost {
        state: Mutex<State>,
    }
    impl FakeHost {
        fn with(&self, change: impl FnOnce(&mut State)) {
            change(&mut self.state.lock().unwrap());
        }
        fn add(&self, volume: &Volume, open_count: u32) {
            self.with(|s| {
                s.devices.insert(
                    volume.dm_name(),
                    Device {
                        open_count,
                        suspended: false,
                        uuid: volume.dm_uuid(),
                        dev: (253, 7),
                    },
                );
            });
        }
    }
    impl Host for FakeHost {
        fn device(&self, volume: &Volume) -> Result<Option<Device>, &'static str> {
            let mut state = self.state.lock().unwrap();
            let scripted = state.script.pop_front();
            Ok(state.devices.get(&volume.dm_name()).cloned().map(|mut d| {
                d.open_count = scripted.unwrap_or(d.open_count);
                d
            }))
        }
        fn devices(&self) -> Result<Vec<(String, Device)>, &'static str> {
            let state = self.state.lock().unwrap();
            Ok(state
                .devices
                .iter()
                .map(|(name, device)| (name.clone(), device.clone()))
                .collect())
        }
        fn mount(&self, _volume: &Volume) -> Result<Mounted, &'static str> {
            Err("mount_failed")
        }
        fn read_control(&self, _mounted: &Mounted) -> Result<Control, &'static str> {
            Err("control_unreadable")
        }
    }

    struct Fixture {
        holders: Holders<FakeHost>,
        root: PathBuf,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    fn fixture() -> Fixture {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "pgcf-node-holders-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let directory = root.join("holders");
        std::fs::create_dir_all(&directory).unwrap();
        Fixture {
            holders: Holders::new(
                FakeHost {
                    state: Mutex::default(),
                },
                directory,
            ),
            root,
        }
    }
    impl Fixture {
        fn host(&self) -> &FakeHost {
            &self.holders.host
        }
        fn holder(&self, volume: &Volume) -> Option<String> {
            std::fs::read_to_string(self.directory().join(&volume.lv_uuid)).ok()
        }
        fn put_holder(&self, volume: &Volume, record: &str) {
            std::fs::write(
                self.directory().join(&volume.lv_uuid),
                format!("{record}\n"),
            )
            .unwrap();
        }
        fn directory(&self) -> &Path {
            &self.holders.directory
        }
    }

    #[test]
    fn hold_is_idempotent_for_the_same_holder_and_refuses_another() {
        let f = fixture();
        let v = volume(1);
        assert_eq!(f.holders.hold(&v, HOLDER), Err("volume_missing"));
        // Only a database holds a volume, and only a tenant LV is held.
        assert_eq!(f.holders.hold(&v, ADOPTED), Err("invalid"));
        assert_eq!(f.holders.hold(&v, "d0123456789abcdef012\n"), Err("invalid"));
        let mut other = v.clone();
        other.lv_name = "thinpool".into();
        assert_eq!(f.holders.hold(&other, HOLDER), Err("invalid"));
        f.host().add(&v, 0);
        f.host().with(|s| {
            s.devices.get_mut(&v.dm_name()).unwrap().suspended = true;
        });
        assert_eq!(f.holders.hold(&v, HOLDER), Err("volume_suspended"));
        f.host().with(|s| {
            let device = s.devices.get_mut(&v.dm_name()).unwrap();
            device.suspended = false;
            device.uuid = volume(2).dm_uuid();
        });
        assert_eq!(f.holders.hold(&v, HOLDER), Err("uuid_mismatch"));
        f.host().add(&v, 0);
        assert_eq!(f.holders.hold(&v, HOLDER), Ok(true));
        assert_eq!(f.holder(&v), Some(format!("{HOLDER}\n")));
        // The database runs on it now; the same holder is still answered as held.
        f.host().add(&v, 1);
        assert_eq!(f.holders.hold(&v, HOLDER), Ok(false));
        assert_eq!(
            f.holders.hold(&v, "e0123456789abcdef012"),
            Err("holder_busy")
        );
        let w = volume(2);
        f.host().add(&w, 1);
        assert_eq!(f.holders.hold(&w, HOLDER), Err("volume_open"));
        assert_eq!(f.holder(&w), None);
    }

    #[test]
    fn release_waits_for_open_count_zero_and_refuses_a_holder_mismatch() {
        let f = fixture();
        let v = volume(1);
        f.host().add(&v, 0);
        assert_eq!(f.holders.release(&v, HOLDER, 1000), Ok(None));
        f.put_holder(&v, HOLDER);
        assert_eq!(
            f.holders.release(&v, "e0123456789abcdef012", 1000),
            Err("holder_mismatch")
        );
        f.host().with(|s| s.script = VecDeque::from([1, 1, 0]));
        let waited = f.holders.release(&v, HOLDER, 1000).unwrap().unwrap();
        assert!(waited >= 40, "{waited}");
        assert_eq!(f.holder(&v), None);
    }

    #[test]
    fn release_times_out_and_keeps_the_holder_while_the_device_stays_open() {
        let f = fixture();
        let v = volume(1);
        f.host().add(&v, 1);
        f.put_holder(&v, HOLDER);
        assert_eq!(f.holders.release(&v, HOLDER, 100), Err("release_timeout"));
        assert_eq!(f.holder(&v), Some(format!("{HOLDER}\n")));
        assert_eq!(f.holders.release(&v, HOLDER, 10_001), Err("invalid"));
        assert_eq!(f.holders.release(&v, ADOPTED, 100), Err("invalid"));
        assert_eq!(f.holder(&v), Some(format!("{HOLDER}\n")));
    }

    #[test]
    fn adoption_marks_open_devices_without_a_holder_and_drops_them_at_zero() {
        let f = fixture();
        let (v, w, held) = (volume(1), volume(2), volume(3));
        f.host().add(&v, 1);
        f.host().add(&w, 0);
        f.host().add(&held, 0);
        f.put_holder(&held, HOLDER);
        f.host().with(|s| {
            s.devices.insert(
                "pgcf-thinpool-tpool".into(),
                Device {
                    open_count: 3,
                    suspended: false,
                    uuid: "LVM-pool".into(),
                    dev: (253, 1),
                },
            );
        });
        f.holders.adopt().unwrap();
        assert_eq!(f.holder(&v), Some("adopted\n".into()));
        assert_eq!(f.holder(&w), None);
        assert_eq!(
            f.holders.holders().unwrap(),
            [
                (v.lv_uuid.clone(), ADOPTED.to_string()),
                (held.lv_uuid.clone(), HOLDER.to_string())
            ],
            "only the tenant LV is adopted, and a database's holder stays"
        );
        f.holders.adopt().unwrap();
        assert_eq!(f.holder(&v), Some("adopted\n".into()));
        f.host().add(&v, 0);
        f.holders.adopt().unwrap();
        assert_eq!(f.holder(&v), None);
        assert_eq!(f.holder(&held), Some(format!("{HOLDER}\n")));
    }
}
