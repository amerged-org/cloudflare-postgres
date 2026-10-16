// SPDX-License-Identifier: Apache-2.0
//! The decisions of the node attach agent: token and replay checks, the single-writer holder
//! rule, attach order and undo, release, inspection and adoption. Every kernel effect goes through
//! `Host`, so the rules are tested on every OS.
use pgcf_native_controller::attach_protocol::{
    self as protocol, ADOPTED, Action, AttachRequest, AttachResponse, Control, HoldRequest,
    HoldResponse, Holder, HolderEntry, HoldersRequest, HoldersResponse, InspectRequest,
    InspectResponse, Keys, MAX_RELEASE_WAIT_MS, ReleaseRequest, ReleaseResponse, VOLUME_GROUP,
    Volume, lvm_uuid,
};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{File, OpenOptions},
    io::{ErrorKind, Write},
    os::{fd::OwnedFd, unix::fs::OpenOptionsExt},
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant, SystemTime},
};

pub(crate) trait Host: Send + Sync {
    fn boot_id(&self) -> Result<String, &'static str>;
    /// `None`: no such device-mapper device.
    fn device(&self, volume: &Volume) -> Result<Option<Device>, &'static str>;
    fn devices(&self) -> Result<Vec<(String, Device)>, &'static str>;
    /// A detached mount of the volume; the fds live inside `Mounted`.
    fn mount(&self, volume: &Volume) -> Result<Mounted, &'static str>;
    fn read_control(&self, mounted: &Mounted) -> Result<Control, &'static str>;
    fn container_pid(&self, container_id: &str) -> Result<Option<u32>, &'static str>;
    fn move_into(&self, mounted: &Mounted, pid: u32, clone: bool) -> Result<(), &'static str>;
    fn unmount_in(&self, pid: u32) -> Result<(), &'static str>;
    fn mounted_in(&self, pid: u32, dev: (u32, u32)) -> Result<bool, &'static str>;
    /// `pg_control` (when readable) and whether `postmaster.pid` exists, through the container root.
    fn control_in(&self, pid: u32) -> Result<(Option<Control>, bool), &'static str>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Device {
    pub open_count: u32,
    pub suspended: bool,
    pub uuid: String,
    pub dev: (u32, u32),
}

/// A detached mount. Dropping it closes its fds; a mount that was moved stays where it was moved.
pub(crate) struct Mounted {
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fd: Option<OwnedFd>,
    /// A clone of the mount, made inside the namespace it was first moved into, for the next
    /// container.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub clone: Mutex<Option<OwnedFd>>,
    /// Lets a test host see whether the detached mount is still open.
    #[cfg_attr(not(test), allow(dead_code))]
    pub live: Option<Arc<()>>,
}

/// Requests the agent keeps nonces of until they expire; beyond that it answers `busy`.
const REPLAY_ENTRIES: usize = 4096;
/// How often `release` reads the open count.
const RELEASE_POLL: Duration = Duration::from_millis(20);

pub(crate) struct Agent<H: Host> {
    host: H,
    node: String,
    keys_file: PathBuf,
    holders: PathBuf,
    keys: Mutex<Option<(Stamp, Keys)>>,
    nonces: Mutex<HashMap<String, u64>>,
    volumes: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

/// What identifies a version of the mounted keyring file.
#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    modified: Option<SystemTime>,
    length: u64,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
fn parse<T: DeserializeOwned>(body: &[u8]) -> Result<T, &'static str> {
    serde_json::from_slice(body).map_err(|_| "invalid")
}
fn answer<T: Serialize>(value: &T) -> Result<Vec<u8>, &'static str> {
    serde_json::to_vec(value).map_err(|_| "invalid")
}
fn container_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn micros(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX)
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
/// that is not a `pgcf` PVC LV (pools, snapshots, other volume groups).
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

impl<H: Host> Agent<H> {
    pub(crate) fn new(host: H, node: String, keys_file: PathBuf, holders: PathBuf) -> Self {
        Self {
            host,
            node,
            keys_file,
            holders,
            keys: Mutex::new(None),
            nonces: Mutex::new(HashMap::new()),
            volumes: Mutex::new(HashMap::new()),
        }
    }

    /// One request: keyring, token, replay, body, then the action under its volume's lock.
    pub(crate) fn handle(
        &self,
        action: Action,
        token: &str,
        body: &[u8],
        now_ms: u64,
    ) -> Result<Vec<u8>, &'static str> {
        let keys = self.keys()?;
        let claims = protocol::verify(token, &keys, &self.node, action, now_ms)?;
        self.remember(&claims.nonce, claims.exp, now_ms)?;
        let volume = |volume: &Volume| {
            if volume.lv_uuid == claims.lv_uuid {
                Ok(())
            } else {
                Err("denied")
            }
        };
        match action {
            Action::Attach => {
                let request: AttachRequest = parse(body)?;
                if !request.valid() {
                    return Err("invalid");
                }
                volume(&request.volume)?;
                let serial = self.serial(&request.volume.lv_uuid);
                let _serial = lock(&serial);
                answer(&self.attach(&request)?)
            }
            Action::Hold => {
                let request: HoldRequest = parse(body)?;
                if !request.volume.valid() || !request.holder.valid() {
                    return Err("invalid");
                }
                volume(&request.volume)?;
                let serial = self.serial(&request.volume.lv_uuid);
                let _serial = lock(&serial);
                answer(&self.hold(&request)?)
            }
            Action::Release => {
                let request: ReleaseRequest = parse(body)?;
                if !request.volume.valid()
                    || !request.holder.valid()
                    || request.wait_ms > MAX_RELEASE_WAIT_MS
                {
                    return Err("invalid");
                }
                volume(&request.volume)?;
                let serial = self.serial(&request.volume.lv_uuid);
                let _serial = lock(&serial);
                answer(&self.release(&request)?)
            }
            Action::Inspect => {
                let request: InspectRequest = parse(body)?;
                if !request.volume.valid()
                    || request
                        .postgres_container
                        .as_deref()
                        .is_some_and(|id| !container_id(id))
                {
                    return Err("invalid");
                }
                volume(&request.volume)?;
                let serial = self.serial(&request.volume.lv_uuid);
                let _serial = lock(&serial);
                answer(&self.inspect(&request)?)
            }
            Action::Holders => {
                let _request: HoldersRequest = parse(body)?;
                answer(&HoldersResponse {
                    boot_id: self.host.boot_id()?,
                    holders: self.holder_files()?,
                })
            }
        }
    }

    /// The background pass (at start and every 2 s): adopt open devices nobody holds, drop
    /// adopted holders and slot holders of an earlier boot once their device is closed.
    pub(crate) fn tick(&self) {
        if let Err(code) = self.adopt() {
            eprintln!(r#"{{"event":"attach_tick_failed","reason":"{code}"}}"#);
        }
    }

    fn adopt(&self) -> Result<(), &'static str> {
        let boot = self.host.boot_id()?;
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
        for entry in self.holder_files()? {
            let serial = self.serial(&entry.lv_uuid);
            let _serial = lock(&serial);
            let Some(holder) = self.read_holder(&entry.lv_uuid)? else {
                continue;
            };
            let stale_slot = holder
                .strip_prefix("slot:")
                .and_then(|rest| rest.rsplit_once(':'))
                .is_some_and(|(_, holder_boot)| holder_boot != boot);
            if holder != ADOPTED && !stale_slot {
                continue;
            }
            let closed = match known.get(&entry.lv_uuid) {
                Some(volume) => self
                    .host
                    .device(volume)?
                    .is_none_or(|device| device.open_count == 0),
                None => true,
            };
            if closed {
                self.remove_holder(&entry.lv_uuid)?;
            }
        }
        Ok(())
    }

    fn attach(&self, request: &AttachRequest) -> Result<AttachResponse, &'static str> {
        let started = Instant::now();
        let mut steps = BTreeMap::new();
        self.usable(&request.volume)?;
        steps.insert("status".to_string(), micros(started));
        let holder = Holder::Slot {
            pod_uid: request.pod_uid.clone(),
        }
        .record(&self.host.boot_id()?);
        self.create_holder(&request.volume.lv_uuid, &holder)?;
        steps.insert("holder".to_string(), micros(started));
        // Step 3: nothing of this request has the device open yet, so a recheck that refuses
        // takes the holder it just made away again; kept, only a release of the slot would
        // remove it.
        if let Err(code) = self.usable(&request.volume) {
            let _ = self.remove_holder(&request.volume.lv_uuid);
            return Err(code);
        }
        let mut moved = Vec::new();
        match self.attach_held(request, &mut moved, &mut steps, started) {
            Ok(control) => {
                steps.insert("total".to_string(), micros(started));
                Ok(AttachResponse {
                    holder,
                    control,
                    attached: request.containers.clone(),
                    steps_us: steps,
                })
            }
            Err(code) => {
                // Undo: unmount what was moved (never lazily), newest first; the holder goes
                // only when every unmount worked and the device reads closed.
                let mut unmounted = true;
                for pid in moved.iter().rev() {
                    unmounted &= self.host.unmount_in(*pid).is_ok();
                }
                let closed = matches!(
                    self.host.device(&request.volume),
                    Ok(None) | Ok(Some(Device { open_count: 0, .. }))
                );
                if unmounted && closed {
                    let _ = self.remove_holder(&request.volume.lv_uuid);
                }
                Err(code)
            }
        }
    }

    /// Attach steps 4-7, after the holder exists and the recheck passed. `moved` lists the PIDs
    /// whose namespace got the volume, for the undo.
    fn attach_held(
        &self,
        request: &AttachRequest,
        moved: &mut Vec<u32>,
        steps: &mut BTreeMap<String, u64>,
        started: Instant,
    ) -> Result<Control, &'static str> {
        let mounted = self.host.mount(&request.volume)?;
        steps.insert("fsmount".to_string(), micros(started));
        let control = self.host.read_control(&mounted)?;
        if !control.shut_down() {
            return Err("unclean");
        }
        steps.insert("control".to_string(), micros(started));
        let mut pids = Vec::with_capacity(request.containers.len());
        for id in &request.containers {
            pids.push(self.host.container_pid(id)?.ok_or("container_missing")?);
        }
        for (index, pid) in pids.iter().enumerate() {
            self.host.move_into(&mounted, *pid, index > 0)?;
            moved.push(*pid);
            steps.insert(format!("move_{index}"), micros(started));
        }
        drop(mounted);
        let device = self
            .host
            .device(&request.volume)
            .ok()
            .flatten()
            .ok_or("audit_failed")?;
        if device.open_count != 1
            || !pids
                .iter()
                .all(|pid| self.host.mounted_in(*pid, device.dev) == Ok(true))
        {
            return Err("audit_failed");
        }
        steps.insert("audit".to_string(), micros(started));
        Ok(control)
    }

    fn hold(&self, request: &HoldRequest) -> Result<HoldResponse, &'static str> {
        let holder = request.holder.record(&self.host.boot_id()?);
        match self.read_holder(&request.volume.lv_uuid)? {
            Some(existing) if existing == holder => {
                return Ok(HoldResponse {
                    holder,
                    created: false,
                });
            }
            Some(_) => return Err("holder_busy"),
            None => {}
        }
        self.usable(&request.volume)?;
        self.create_holder(&request.volume.lv_uuid, &holder)?;
        Ok(HoldResponse {
            holder,
            created: true,
        })
    }

    fn release(&self, request: &ReleaseRequest) -> Result<ReleaseResponse, &'static str> {
        let holder = request.holder.record(&self.host.boot_id()?);
        match self.read_holder(&request.volume.lv_uuid)? {
            None => {
                return Ok(ReleaseResponse {
                    released: false,
                    waited_ms: 0,
                });
            }
            Some(existing) if existing != holder => return Err("holder_mismatch"),
            Some(_) => {}
        }
        let started = Instant::now();
        let wait = Duration::from_millis(request.wait_ms.min(MAX_RELEASE_WAIT_MS));
        loop {
            let open = self
                .host
                .device(&request.volume)?
                .map_or(0, |device| device.open_count);
            if open == 0 {
                self.remove_holder(&request.volume.lv_uuid)?;
                return Ok(ReleaseResponse {
                    released: true,
                    waited_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                });
            }
            if started.elapsed() + RELEASE_POLL > wait {
                return Err("release_timeout");
            }
            std::thread::sleep(RELEASE_POLL);
        }
    }

    fn inspect(&self, request: &InspectRequest) -> Result<InspectResponse, &'static str> {
        let device = self.host.device(&request.volume)?;
        if device
            .as_ref()
            .is_some_and(|device| device.uuid != request.volume.dm_uuid())
        {
            return Err("uuid_mismatch");
        }
        let (control, postmaster_running) = match &request.postgres_container {
            Some(id) => {
                let pid = self.host.container_pid(id)?.ok_or("container_missing")?;
                let (control, running) = self.host.control_in(pid)?;
                (control, Some(running))
            }
            None => (None, None),
        };
        Ok(InspectResponse {
            exists: device.is_some(),
            open_count: device.as_ref().map_or(0, |device| device.open_count),
            suspended: device.as_ref().is_some_and(|device| device.suspended),
            holder: self.read_holder(&request.volume.lv_uuid)?,
            control,
            postmaster_running,
        })
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

    fn keys(&self) -> Result<Keys, &'static str> {
        let mut cached = lock(&self.keys);
        let Ok(metadata) = std::fs::metadata(&self.keys_file) else {
            *cached = None;
            return Err("keys_unavailable");
        };
        let stamp = Stamp {
            modified: metadata.modified().ok(),
            length: metadata.len(),
        };
        if let Some((known, keys)) = cached.as_ref()
            && *known == stamp
        {
            return Ok(keys.clone());
        }
        let text = std::fs::read_to_string(&self.keys_file).map_err(|_| "keys_unavailable")?;
        let keys = Keys::decode(&text).map_err(|_| "keys_unavailable")?;
        *cached = Some((stamp, keys.clone()));
        Ok(keys)
    }

    fn remember(&self, nonce: &str, exp: u64, now_ms: u64) -> Result<(), &'static str> {
        let mut nonces = lock(&self.nonces);
        if nonces.contains_key(nonce) {
            return Err("denied");
        }
        if nonces.len() >= REPLAY_ENTRIES {
            nonces.retain(|_, until| until.saturating_mul(1000) >= now_ms);
            if nonces.len() >= REPLAY_ENTRIES {
                return Err("busy");
            }
        }
        nonces.insert(nonce.to_string(), exp);
        Ok(())
    }

    fn serial(&self, lv_uuid: &str) -> Arc<Mutex<()>> {
        lock(&self.volumes)
            .entry(lv_uuid.to_string())
            .or_default()
            .clone()
    }

    fn sync_holders(&self) -> Result<(), &'static str> {
        File::open(&self.holders)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| "io_failed")
    }

    fn create_holder(&self, lv_uuid: &str, holder: &str) -> Result<(), &'static str> {
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.holders.join(lv_uuid))
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
        match std::fs::remove_file(self.holders.join(lv_uuid)) {
            Ok(()) => self.sync_holders(),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(_) => Err("io_failed"),
        }
    }

    fn read_holder(&self, lv_uuid: &str) -> Result<Option<String>, &'static str> {
        match std::fs::read_to_string(self.holders.join(lv_uuid)) {
            Ok(text) => Ok(Some(text.trim_end_matches('\n').to_string())),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(_) => Err("io_failed"),
        }
    }

    fn holder_files(&self) -> Result<Vec<HolderEntry>, &'static str> {
        let mut result = Vec::new();
        for entry in std::fs::read_dir(&self.holders).map_err(|_| "io_failed")? {
            let name = entry.map_err(|_| "io_failed")?.file_name();
            let Some(lv_uuid) = name.to_str().filter(|name| lvm_uuid(name)) else {
                continue;
            };
            if let Some(holder) = self.read_holder(lv_uuid)? {
                result.push(HolderEntry {
                    lv_uuid: lv_uuid.to_string(),
                    holder,
                });
            }
        }
        result.sort_by(|a, b| a.lv_uuid.cmp(&b.lv_uuid));
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pgcf_native_controller::attach_protocol::{Keys, nonce, sign};
    use serde_json::{Value, json};
    use std::{
        collections::{HashMap, HashSet, VecDeque},
        os::unix::fs::PermissionsExt,
        path::Path,
        sync::{
            Mutex, Weak,
            atomic::{AtomicUsize, Ordering},
        },
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    const NODE: &str = "eu1-node-1";
    const BOOT: &str = "6b1e3c55-6f0a-4d3e-9a51-2a8d9b0c7e11";
    const POD: &str = "0f1e2d3c-4b5a-4968-8776-655443322110";
    const PG: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const SIDECAR: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    fn volume(n: u8) -> Volume {
        Volume {
            lv_name: format!("pvc-0b1c2d3e-4f50-4617-8899-aabbccddee{n:02x}"),
            lv_uuid: format!("aB3dE9-x1y2-Z3w4-v5u6-t7s8-r9q0-P1o2{n:02}"),
            vg_uuid: "Vg0001-a1b2-c3d4-e5f6-g7h8-i9j0-k1l2m3".into(),
        }
    }
    fn clean() -> Control {
        Control {
            state: 1,
            system_identifier: "7431215993172011234".into(),
            timeline: 2,
        }
    }

    #[derive(Default)]
    struct State {
        /// Base device per dm name; the open count adds 1 while any mount of it exists.
        devices: HashMap<String, Device>,
        /// Open counts handed out before the computed one, one per `device` call.
        script: VecDeque<u32>,
        control: Option<Result<Control, &'static str>>,
        pids: HashMap<String, u32>,
        live: Vec<Weak<()>>,
        in_namespace: HashSet<u32>,
        moves: Vec<(u32, bool)>,
        unmounts: Vec<u32>,
        mounts: usize,
        audit: bool,
        unmount_fails: bool,
        holder_seen: Vec<bool>,
        delay: Duration,
        container_state: Option<(Option<Control>, bool)>,
    }
    struct FakeHost {
        state: Mutex<State>,
        holders: PathBuf,
        inside: AtomicUsize,
        most: AtomicUsize,
    }
    impl FakeHost {
        fn new(holders: &Path) -> Self {
            let mut state = State {
                control: Some(Ok(clean())),
                audit: true,
                ..State::default()
            };
            state.pids.insert(PG.into(), 100);
            state.pids.insert(SIDECAR.into(), 200);
            Self {
                state: Mutex::new(state),
                holders: holders.into(),
                inside: AtomicUsize::new(0),
                most: AtomicUsize::new(0),
            }
        }
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
        fn opened(state: &State) -> u32 {
            let detached = state.live.iter().any(|weak| weak.strong_count() > 0);
            u32::from(detached || !state.in_namespace.is_empty())
        }
    }
    impl Host for FakeHost {
        fn boot_id(&self) -> Result<String, &'static str> {
            Ok(BOOT.into())
        }
        fn device(&self, volume: &Volume) -> Result<Option<Device>, &'static str> {
            let now = self.inside.fetch_add(1, Ordering::SeqCst) + 1;
            self.most.fetch_max(now, Ordering::SeqCst);
            let delay = self.state.lock().unwrap().delay;
            std::thread::sleep(delay);
            self.inside.fetch_sub(1, Ordering::SeqCst);
            let mut state = self.state.lock().unwrap();
            let held = self.holders.join(&volume.lv_uuid).exists();
            state.holder_seen.push(held);
            let scripted = state.script.pop_front();
            let opened = Self::opened(&state);
            Ok(state.devices.get(&volume.dm_name()).cloned().map(|mut d| {
                d.open_count = scripted.unwrap_or(d.open_count + opened);
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
            let live = Arc::new(());
            self.with(|s| {
                s.mounts += 1;
                s.live.push(Arc::downgrade(&live));
            });
            Ok(Mounted {
                fd: None,
                clone: Mutex::default(),
                live: Some(live),
            })
        }
        fn read_control(&self, mounted: &Mounted) -> Result<Control, &'static str> {
            assert!(mounted.live.is_some());
            self.state.lock().unwrap().control.clone().unwrap()
        }
        fn container_pid(&self, container_id: &str) -> Result<Option<u32>, &'static str> {
            Ok(self.state.lock().unwrap().pids.get(container_id).copied())
        }
        fn move_into(&self, _mounted: &Mounted, pid: u32, clone: bool) -> Result<(), &'static str> {
            self.with(|s| {
                s.moves.push((pid, clone));
                s.in_namespace.insert(pid);
            });
            Ok(())
        }
        fn unmount_in(&self, pid: u32) -> Result<(), &'static str> {
            let mut state = self.state.lock().unwrap();
            state.unmounts.push(pid);
            if state.unmount_fails {
                return Err("mount_failed");
            }
            state.in_namespace.remove(&pid);
            Ok(())
        }
        fn mounted_in(&self, pid: u32, dev: (u32, u32)) -> Result<bool, &'static str> {
            let state = self.state.lock().unwrap();
            Ok(state.audit && dev == (253, 7) && state.in_namespace.contains(&pid))
        }
        fn control_in(&self, _pid: u32) -> Result<(Option<Control>, bool), &'static str> {
            Ok(self
                .state
                .lock()
                .unwrap()
                .container_state
                .clone()
                .unwrap_or((None, false)))
        }
    }

    struct Fixture {
        agent: Agent<FakeHost>,
        keys: Keys,
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
            "pgcf-attach-agent-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let holders = root.join("holders");
        std::fs::create_dir_all(&holders).unwrap();
        let route = HashMap::from([("k1".to_string(), vec![7u8; 32])]);
        let keys = Keys::derive("eu-dev", "k1", &route).unwrap();
        let keys_file = root.join("PGCF_ATTACH_KEYS");
        std::fs::write(&keys_file, keys.encode()).unwrap();
        Fixture {
            agent: Agent::new(FakeHost::new(&holders), NODE.into(), keys_file, holders),
            keys,
            root,
        }
    }
    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }
    impl Fixture {
        fn host(&self) -> &FakeHost {
            &self.agent.host
        }
        fn token(&self, action: Action, lv: &str) -> String {
            sign(&self.keys, NODE, action, lv, &nonce().unwrap(), now()).unwrap()
        }
        fn call(&self, action: Action, lv: &str, body: Value) -> Result<Value, &'static str> {
            let token = self.token(action, lv);
            let bytes = serde_json::to_vec(&body).unwrap();
            self.agent
                .handle(action, &token, &bytes, now())
                .map(|out| serde_json::from_slice(&out).unwrap())
        }
        fn holder(&self, volume: &Volume) -> Option<String> {
            std::fs::read_to_string(self.agent.holders.join(&volume.lv_uuid)).ok()
        }
        fn put_holder(&self, volume: &Volume, record: &str) {
            std::fs::write(
                self.agent.holders.join(&volume.lv_uuid),
                format!("{record}\n"),
            )
            .unwrap();
        }
        fn attach(&self, volume: &Volume, containers: &[&str]) -> Result<Value, &'static str> {
            self.call(
                Action::Attach,
                &volume.lv_uuid,
                json!({"volume": volume, "pod_uid": POD, "containers": containers}),
            )
        }
    }
    fn slot_record() -> String {
        format!("slot:{POD}:{BOOT}")
    }

    #[test]
    fn attach_refuses_an_open_device_before_creating_a_holder() {
        let f = fixture();
        let v = volume(1);
        f.host().add(&v, 1);
        assert_eq!(f.attach(&v, &[PG, SIDECAR]), Err("volume_open"));
        assert_eq!(f.holder(&v), None);
        assert_eq!(f.host().state.lock().unwrap().mounts, 0);
    }

    #[test]
    fn attach_refuses_a_suspended_device_and_a_foreign_dm_uuid() {
        let f = fixture();
        let v = volume(1);
        assert_eq!(f.attach(&v, &[PG]), Err("volume_missing"));
        f.host().add(&v, 0);
        f.host().with(|s| {
            s.devices.get_mut(&v.dm_name()).unwrap().suspended = true;
        });
        assert_eq!(f.attach(&v, &[PG]), Err("volume_suspended"));
        f.host().with(|s| {
            let device = s.devices.get_mut(&v.dm_name()).unwrap();
            device.suspended = false;
            device.uuid = volume(2).dm_uuid();
        });
        assert_eq!(f.attach(&v, &[PG]), Err("uuid_mismatch"));
        assert_eq!(f.holder(&v), None);
        assert_eq!(f.host().state.lock().unwrap().mounts, 0);
    }

    #[test]
    fn attach_refuses_holder_busy_when_any_holder_file_exists() {
        let f = fixture();
        let v = volume(1);
        f.host().add(&v, 0);
        f.put_holder(&v, "cnpg:d0123456789abcdef012");
        assert_eq!(f.attach(&v, &[PG]), Err("holder_busy"));
        f.put_holder(&v, &slot_record());
        assert_eq!(f.attach(&v, &[PG]), Err("holder_busy"));
        assert_eq!(f.holder(&v), Some(format!("{}\n", slot_record())));
        assert_eq!(f.host().state.lock().unwrap().mounts, 0);
    }

    #[test]
    fn attach_creates_the_holder_only_after_open_count_zero_and_rechecks_it() {
        let f = fixture();
        let v = volume(1);
        f.host().add(&v, 0);
        // Someone opens the device between the first check and the holder.
        f.host().with(|s| s.script = VecDeque::from([0, 1, 1]));
        assert_eq!(f.attach(&v, &[PG]), Err("volume_open"));
        let state = f.host().state.lock().unwrap();
        assert_eq!(state.holder_seen[..2], [false, true]);
        assert_eq!(state.mounts, 0);
        drop(state);
        // Nothing of the request opened the device, so the holder it made goes again: kept, it
        // would block the volume for good, as only a release of that slot removes it.
        assert_eq!(f.holder(&v), None);
    }

    #[test]
    fn attach_moves_postgres_first_then_a_clone_into_the_sidecar() {
        let f = fixture();
        let v = volume(1);
        f.host().add(&v, 0);
        let out = f.attach(&v, &[PG, SIDECAR]).unwrap();
        assert_eq!(out["holder"], slot_record());
        assert_eq!(out["attached"], json!([PG, SIDECAR]));
        assert_eq!(out["control"], serde_json::to_value(clean()).unwrap());
        let steps: Vec<&str> = out["steps_us"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        for step in [
            "status", "holder", "fsmount", "control", "move_0", "move_1", "audit", "total",
        ] {
            assert!(steps.contains(&step), "{step}");
        }
        let state = f.host().state.lock().unwrap();
        assert_eq!(state.moves, [(100, false), (200, true)]);
        assert!(state.unmounts.is_empty());
        drop(state);
        assert_eq!(f.holder(&v), Some(format!("{}\n", slot_record())));
        let mode = std::fs::metadata(f.agent.holders.join(&v.lv_uuid))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn an_unclean_pg_control_undoes_the_mount_and_removes_the_holder() {
        let f = fixture();
        let v = volume(1);
        f.host().add(&v, 0);
        f.host().with(|s| {
            s.control = Some(Ok(Control {
                state: 6,
                ..clean()
            }))
        });
        assert_eq!(f.attach(&v, &[PG, SIDECAR]), Err("unclean"));
        let state = f.host().state.lock().unwrap();
        assert!(state.moves.is_empty());
        assert_eq!(FakeHost::opened(&state), 0);
        drop(state);
        assert_eq!(f.holder(&v), None);
        f.host().with(|s| s.control = Some(Err("control_version")));
        assert_eq!(f.attach(&v, &[PG]), Err("control_version"));
        f.host().with(|s| {
            s.control = Some(Ok(clean()));
            s.pids.remove(SIDECAR);
        });
        assert_eq!(f.attach(&v, &[PG, SIDECAR]), Err("container_missing"));
        assert!(f.host().state.lock().unwrap().moves.is_empty());
        assert_eq!(f.holder(&v), None);
    }

    #[test]
    fn an_audit_failure_unmounts_without_lazy_detach_and_removes_the_holder_at_zero() {
        let f = fixture();
        let v = volume(1);
        f.host().add(&v, 0);
        f.host().with(|s| s.audit = false);
        assert_eq!(f.attach(&v, &[PG, SIDECAR]), Err("audit_failed"));
        let state = f.host().state.lock().unwrap();
        assert_eq!(state.unmounts, [200, 100]);
        assert!(state.in_namespace.is_empty());
        drop(state);
        assert_eq!(f.holder(&v), None);
    }

    #[test]
    fn a_failed_unmount_keeps_the_holder() {
        let f = fixture();
        let v = volume(1);
        f.host().add(&v, 0);
        f.host().with(|s| {
            s.audit = false;
            s.unmount_fails = true;
        });
        assert_eq!(f.attach(&v, &[PG, SIDECAR]), Err("audit_failed"));
        assert_eq!(f.host().state.lock().unwrap().unmounts, [200, 100]);
        assert_eq!(f.holder(&v), Some(format!("{}\n", slot_record())));
    }

    #[test]
    fn hold_is_idempotent_for_the_same_holder_and_refuses_another() {
        let f = fixture();
        let v = volume(1);
        f.host().add(&v, 0);
        let cnpg = json!({"kind": "cnpg", "database": "d0123456789abcdef012"});
        let hold = |holder: &Value| {
            f.call(
                Action::Hold,
                &v.lv_uuid,
                json!({"volume": v, "holder": holder}),
            )
        };
        assert_eq!(
            hold(&cnpg).unwrap(),
            json!({"holder": "cnpg:d0123456789abcdef012", "created": true})
        );
        assert_eq!(f.holder(&v), Some("cnpg:d0123456789abcdef012\n".into()));
        // The database runs on it now; the same holder is still answered as held.
        f.host().add(&v, 1);
        assert_eq!(hold(&cnpg).unwrap()["created"], false);
        let other = json!({"kind": "cnpg", "database": "e0123456789abcdef012"});
        assert_eq!(hold(&other), Err("holder_busy"));
        let w = volume(2);
        f.host().add(&w, 1);
        assert_eq!(
            f.call(
                Action::Hold,
                &w.lv_uuid,
                json!({"volume": w, "holder": cnpg})
            ),
            Err("volume_open")
        );
        assert_eq!(f.holder(&w), None);
    }

    #[test]
    fn release_waits_for_open_count_zero_and_refuses_a_holder_mismatch() {
        let f = fixture();
        let v = volume(1);
        f.host().add(&v, 0);
        let release = |database: &str| {
            f.call(
                Action::Release,
                &v.lv_uuid,
                json!({"volume": v, "holder": {"kind": "cnpg", "database": database}, "wait_ms": 1000}),
            )
        };
        assert_eq!(
            release("d0123456789abcdef012").unwrap(),
            json!({"released": false, "waited_ms": 0})
        );
        f.put_holder(&v, "cnpg:d0123456789abcdef012");
        assert_eq!(release("e0123456789abcdef012"), Err("holder_mismatch"));
        f.host().with(|s| s.script = VecDeque::from([1, 1, 0]));
        let out = release("d0123456789abcdef012").unwrap();
        assert_eq!(out["released"], true);
        assert!(out["waited_ms"].as_u64().unwrap() >= 40, "{out}");
        assert_eq!(f.holder(&v), None);
    }

    #[test]
    fn release_times_out_and_keeps_the_holder_while_the_device_stays_open() {
        let f = fixture();
        let v = volume(1);
        f.host().add(&v, 1);
        f.put_holder(&v, &slot_record());
        let release = |wait_ms: u64| {
            f.call(
                Action::Release,
                &v.lv_uuid,
                json!({"volume": v, "holder": {"kind": "slot", "pod_uid": POD}, "wait_ms": wait_ms}),
            )
        };
        assert_eq!(release(100), Err("release_timeout"));
        assert_eq!(f.holder(&v), Some(format!("{}\n", slot_record())));
        assert_eq!(release(10_001), Err("invalid"));
    }

    #[test]
    fn adoption_marks_open_devices_without_a_holder_and_drops_them_at_zero() {
        let f = fixture();
        let (v, w) = (volume(1), volume(2));
        f.host().add(&v, 1);
        f.host().add(&w, 0);
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
        f.agent.tick();
        assert_eq!(f.holder(&v), Some("adopted\n".into()));
        assert_eq!(f.holder(&w), None);
        assert_eq!(
            std::fs::read_dir(&f.agent.holders).unwrap().count(),
            1,
            "only the tenant LV is adopted"
        );
        f.agent.tick();
        assert_eq!(f.holder(&v), Some("adopted\n".into()));
        f.host().add(&v, 0);
        f.agent.tick();
        assert_eq!(f.holder(&v), None);
    }

    #[test]
    fn a_slot_holder_of_another_boot_is_dropped_at_zero_and_one_of_this_boot_is_kept() {
        let f = fixture();
        let (old, current, open, cnpg) = (volume(1), volume(2), volume(3), volume(4));
        for v in [&old, &current, &cnpg] {
            f.host().add(v, 0);
        }
        f.host().add(&open, 1);
        let stale = format!("slot:{POD}:0e1e3c55-6f0a-4d3e-9a51-2a8d9b0c7e11");
        f.put_holder(&old, &stale);
        f.put_holder(&current, &slot_record());
        f.put_holder(&open, &stale);
        f.put_holder(&cnpg, "cnpg:d0123456789abcdef012");
        f.agent.tick();
        assert_eq!(f.holder(&old), None);
        assert_eq!(f.holder(&current), Some(format!("{}\n", slot_record())));
        assert_eq!(f.holder(&open), Some(format!("{stale}\n")));
        assert_eq!(f.holder(&cnpg), Some("cnpg:d0123456789abcdef012\n".into()));
        let holders = f.call(Action::Holders, "", json!({})).unwrap();
        assert_eq!(holders["boot_id"], BOOT);
        assert_eq!(holders["holders"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn a_replayed_nonce_is_denied() {
        let f = fixture();
        let v = volume(1);
        f.host().add(&v, 0);
        let token = f.token(Action::Inspect, &v.lv_uuid);
        let body = serde_json::to_vec(&json!({"volume": v, "postgres_container": null})).unwrap();
        let first = f
            .agent
            .handle(Action::Inspect, &token, &body, now())
            .unwrap();
        let first: Value = serde_json::from_slice(&first).unwrap();
        assert_eq!(
            first,
            json!({"exists": true, "open_count": 0, "suspended": false, "holder": null,
                   "control": null, "postmaster_running": null})
        );
        assert_eq!(
            f.agent.handle(Action::Inspect, &token, &body, now()),
            Err("denied")
        );
        // A token for one LV does not cover another, and a missing keyring is not a denial.
        let other =
            serde_json::to_vec(&json!({"volume": volume(2), "postgres_container": null})).unwrap();
        let token = f.token(Action::Inspect, &v.lv_uuid);
        assert_eq!(
            f.agent.handle(Action::Inspect, &token, &other, now()),
            Err("denied")
        );
        std::fs::remove_file(&f.agent.keys_file).unwrap();
        let token = f.token(Action::Inspect, &v.lv_uuid);
        assert_eq!(
            f.agent.handle(Action::Inspect, &token, &body, now()),
            Err("keys_unavailable")
        );
    }

    #[test]
    fn requests_on_one_volume_run_one_at_a_time() {
        let f = fixture();
        let (v, w) = (volume(1), volume(2));
        f.host().add(&v, 0);
        f.host().add(&w, 0);
        f.host().with(|s| s.delay = Duration::from_millis(60));
        let inspect = |volume: &Volume| {
            f.call(
                Action::Inspect,
                &volume.lv_uuid,
                json!({"volume": volume, "postgres_container": null}),
            )
            .unwrap()
        };
        std::thread::scope(|scope| {
            scope.spawn(|| inspect(&v));
            scope.spawn(|| inspect(&v));
        });
        assert_eq!(f.host().most.load(Ordering::SeqCst), 1);
        std::thread::scope(|scope| {
            scope.spawn(|| inspect(&v));
            scope.spawn(|| inspect(&w));
        });
        assert_eq!(f.host().most.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn inspect_reads_pg_control_and_postmaster_through_the_postgres_container() {
        let f = fixture();
        let v = volume(1);
        f.host().add(&v, 1);
        f.put_holder(&v, &slot_record());
        f.host()
            .with(|s| s.container_state = Some((Some(clean()), false)));
        let out = f
            .call(
                Action::Inspect,
                &v.lv_uuid,
                json!({"volume": v, "postgres_container": PG}),
            )
            .unwrap();
        assert_eq!(out["holder"], slot_record());
        assert_eq!(out["control"], serde_json::to_value(clean()).unwrap());
        assert_eq!(out["postmaster_running"], false);
        assert_eq!(
            f.call(
                Action::Inspect,
                &v.lv_uuid,
                json!({"volume": v, "postgres_container": "3".repeat(64)}),
            ),
            Err("container_missing")
        );
    }
}
