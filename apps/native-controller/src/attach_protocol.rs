// SPDX-License-Identifier: Apache-2.0
//! The attach protocol between the native controller and its node agent `pgcf-attach` (pool
//! design 2026-10-16). Rust only. The controller signs one scoped HMAC token per request with a
//! key derived from the regional route keyring and publishes the derived keyring in Secret
//! pgcf-attach/pgcf-attach-key, which the agent mounts. Plain HTTP/1.1 on the Pod network, port
//! 8081, `POST /v1/<action>`, one JSON body each way.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::Sha256;
use std::{
    collections::{BTreeMap, HashMap},
    net::IpAddr,
    time::Duration,
};

pub const PORT: u16 = 8081;
pub const HEADER: &str = "x-pgcf-attach";
pub const TOKEN_PREFIX: &str = "pa1";
pub const KEY_PURPOSE: &str = "pgcf-attach-key/v1\n";
pub const SIGNING_PURPOSE: &str = "pgcf-attach/v1\n";
pub const MAX_TOKEN_BYTES: usize = 1024;
pub const MAX_BODY_BYTES: usize = 8192;
pub const MAX_LIFETIME_SECONDS: u64 = 30;
pub const NAMESPACE: &str = "pgcf-attach";
pub const KEY_SECRET: &str = "pgcf-attach-key";
pub const KEY_FIELD: &str = "PGCF_ATTACH_KEYS";
pub const POD_NAME_LABEL: &str = "pgcf-attach";
pub const HOLDER_DIRECTORY: &str = "/var/lib/pgcf-attach";
pub const DATA_PATH: &str = "/var/lib/postgresql/data";
pub const CONTROL_PATH: &str = "pgdata/global/pg_control";
pub const VOLUME_GROUP: &str = "pgcf";
pub const PG_CONTROL_VERSION: u32 = 1800;
pub const DB_SHUTDOWNED: i32 = 1;
pub const MAX_RELEASE_WAIT_MS: u64 = 10_000;
pub const ADOPTED: &str = "adopted";
/// Refusal codes an agent answers in `{"error": code}`.
pub const ERRORS: [&str; 18] = [
    "denied",
    "invalid",
    "busy",
    "keys_unavailable",
    "unsupported_platform",
    "holder_busy",
    "holder_mismatch",
    "volume_open",
    "volume_suspended",
    "volume_missing",
    "uuid_mismatch",
    "control_unreadable",
    "control_version",
    "unclean",
    "container_missing",
    "mount_failed",
    "audit_failed",
    "release_timeout",
];
const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Attach,
    Hold,
    Release,
    Inspect,
    Holders,
}
impl Action {
    pub const ALL: [Action; 5] = [
        Self::Attach,
        Self::Hold,
        Self::Release,
        Self::Inspect,
        Self::Holders,
    ];
    pub fn name(self) -> &'static str {
        match self {
            Self::Attach => "attach",
            Self::Hold => "hold",
            Self::Release => "release",
            Self::Inspect => "inspect",
            Self::Holders => "holders",
        }
    }
    pub fn path(self) -> String {
        format!("/v1/{}", self.name())
    }
    pub fn from_path(path: &str) -> Option<Self> {
        let name = path.strip_prefix("/v1/")?;
        Self::ALL.into_iter().find(|action| action.name() == name)
    }
}

fn uuid_text(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}
fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn key_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}
fn node_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-'))
}
/// LVM's UUID text: 6-4-4-4-4-4-6 alphanumerics (contracts StorageLvmUuid).
pub fn lvm_uuid(value: &str) -> bool {
    let groups: Vec<&str> = value.split('-').collect();
    groups.len() == 7
        && groups
            .iter()
            .zip([6, 4, 4, 4, 4, 4, 6])
            .all(|(group, length)| {
                group.len() == length && group.bytes().all(|b| b.is_ascii_alphanumeric())
            })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Claims {
    pub v: u8,
    pub region: String,
    /// The Kubernetes node name the agent runs on.
    pub node: String,
    pub action: Action,
    /// The LV the request is about; empty for `holders`.
    pub lv_uuid: String,
    pub nonce: String,
    pub kid: String,
    pub iat: u64,
    pub exp: u64,
}
fn claims_valid(claims: &Claims) -> bool {
    claims.v == 1
        && pgcf_native_protocol::valid_pattern("region", &claims.region)
        && node_name(&claims.node)
        && (if claims.action == Action::Holders {
            claims.lv_uuid.is_empty()
        } else {
            lvm_uuid(&claims.lv_uuid)
        })
        && uuid_text(&claims.nonce)
        && key_id(&claims.kid)
        && claims.iat <= MAX_SAFE
        && claims.exp <= MAX_SAFE
}

/// The attach keyring: one key per route-keyring kid, HMAC(routeKey, KEY_PURPOSE).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Keys {
    pub region: String,
    pub active: String,
    pub keys: HashMap<String, Vec<u8>>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EncodedKeys {
    region: String,
    active: String,
    keys: BTreeMap<String, String>,
}
impl Keys {
    /// Derives the attach keyring from the regional route keyring (Secret
    /// pgcf-system/pgcf-gateway, the one the controller signs gateway controls with).
    pub fn derive(
        region: &str,
        active: &str,
        route_keys: &HashMap<String, Vec<u8>>,
    ) -> Result<Self, &'static str> {
        let mut keys = HashMap::new();
        for (kid, key) in route_keys {
            if !key_id(kid) || key.len() < 32 {
                return Err("invalid route keyring");
            }
            let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| "invalid key")?;
            mac.update(KEY_PURPOSE.as_bytes());
            keys.insert(kid.clone(), mac.finalize().into_bytes().to_vec());
        }
        if !keys.contains_key(active) || !pgcf_native_protocol::valid_pattern("region", region) {
            return Err("invalid route keyring");
        }
        Ok(Self {
            region: region.into(),
            active: active.into(),
            keys,
        })
    }
    /// The Secret field value `PGCF_ATTACH_KEYS`.
    pub fn encode(&self) -> String {
        serde_json::to_string(&EncodedKeys {
            region: self.region.clone(),
            active: self.active.clone(),
            keys: self
                .keys
                .iter()
                .map(|(kid, key)| (kid.clone(), URL_SAFE_NO_PAD.encode(key)))
                .collect(),
        })
        .expect("attach keyring serializes")
    }
    pub fn decode(text: &str) -> Result<Self, &'static str> {
        if text.len() > 32_768 {
            return Err("invalid attach keyring");
        }
        let encoded: EncodedKeys =
            serde_json::from_str(text).map_err(|_| "invalid attach keyring")?;
        let mut keys = HashMap::new();
        for (kid, key) in encoded.keys {
            let bytes = URL_SAFE_NO_PAD
                .decode(&key)
                .map_err(|_| "invalid attach keyring")?;
            if !key_id(&kid) || bytes.len() != 32 {
                return Err("invalid attach keyring");
            }
            keys.insert(kid, bytes);
        }
        if !keys.contains_key(&encoded.active)
            || !pgcf_native_protocol::valid_pattern("region", &encoded.region)
        {
            return Err("invalid attach keyring");
        }
        Ok(Self {
            region: encoded.region,
            active: encoded.active,
            keys,
        })
    }
}
fn token_mac(key: &[u8], payload: &str) -> Option<Hmac<Sha256>> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).ok()?;
    mac.update(SIGNING_PURPOSE.as_bytes());
    mac.update(payload.as_bytes());
    Some(mac)
}
pub fn sign(
    keys: &Keys,
    node: &str,
    action: Action,
    lv_uuid: &str,
    nonce: &str,
    now_ms: u64,
) -> Result<String, &'static str> {
    let iat = now_ms / 1000;
    let claims = Claims {
        v: 1,
        region: keys.region.clone(),
        node: node.into(),
        action,
        lv_uuid: lv_uuid.into(),
        nonce: nonce.into(),
        kid: keys.active.clone(),
        iat,
        exp: iat + MAX_LIFETIME_SECONDS,
    };
    if !claims_valid(&claims) {
        return Err("invalid claims");
    }
    let key = keys.keys.get(&keys.active).ok_or("active key missing")?;
    let payload =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|_| "invalid claims")?);
    let mac = token_mac(key, &payload).ok_or("invalid key")?;
    Ok(format!(
        "{TOKEN_PREFIX}.{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    ))
}
/// Verifies a token for this agent's node and the requested action. Replay of `nonce` is the
/// agent's to refuse.
pub fn verify(
    token: &str,
    keys: &Keys,
    node: &str,
    action: Action,
    now_ms: u64,
) -> Result<Claims, &'static str> {
    if token.len() > MAX_TOKEN_BYTES {
        return Err("denied");
    }
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 || parts[0] != TOKEN_PREFIX {
        return Err("denied");
    }
    let payload = URL_SAFE_NO_PAD.decode(parts[1]).map_err(|_| "denied")?;
    let signature = URL_SAFE_NO_PAD
        .decode(parts[2])
        .ok()
        .filter(|v| v.len() == 32)
        .ok_or("denied")?;
    let claims: Claims = serde_json::from_slice(&payload).map_err(|_| "denied")?;
    if !claims_valid(&claims) {
        return Err("denied");
    }
    let key = keys.keys.get(&claims.kid).ok_or("denied")?;
    token_mac(key, parts[1])
        .ok_or("denied")?
        .verify_slice(&signature)
        .map_err(|_| "denied")?;
    if claims.exp <= claims.iat
        || claims.exp - claims.iat > MAX_LIFETIME_SECONDS
        || now_ms + 5_000 < claims.iat * 1000
        || now_ms > claims.exp * 1000
        || claims.region != keys.region
        || claims.node != node
        || claims.action != action
    {
        return Err("denied");
    }
    Ok(claims)
}
/// A random request nonce (UUID v4 text).
pub fn nonce() -> Result<String, &'static str> {
    let mut bytes = [0u8; 16];
    rustls::crypto::ring::default_provider()
        .secure_random
        .fill(&mut bytes)
        .map_err(|_| "nonce unavailable")?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

/// The tenant LV, as the database's storage receipt recorded it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Volume {
    /// The PV volume handle, `pvc-<uuid>`; OpenEBS names the LV after it.
    pub lv_name: String,
    /// The receipt's `lvUuid`.
    pub lv_uuid: String,
    /// The database's `storage.volume_group_uuid`.
    pub vg_uuid: String,
}
impl Volume {
    pub fn valid(&self) -> bool {
        self.lv_name.strip_prefix("pvc-").is_some_and(uuid_text)
            && lvm_uuid(&self.lv_uuid)
            && lvm_uuid(&self.vg_uuid)
    }
    /// The device-mapper name: VG and LV with every `-` doubled, joined by `-`.
    pub fn dm_name(&self) -> String {
        format!(
            "{}-{}",
            VOLUME_GROUP.replace('-', "--"),
            self.lv_name.replace('-', "--")
        )
    }
    /// The device-mapper UUID LVM gives the LV.
    pub fn dm_uuid(&self) -> String {
        format!(
            "LVM-{}{}",
            self.vg_uuid.replace('-', ""),
            self.lv_uuid.replace('-', "")
        )
    }
}
/// Who holds a volume. Recorded as `slot:<pod uid>:<boot id>`, `cnpg:<database>` or `adopted`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Holder {
    Slot { pod_uid: String },
    Cnpg { database: String },
}
impl Holder {
    pub fn valid(&self) -> bool {
        match self {
            Self::Slot { pod_uid } => uuid_text(pod_uid),
            Self::Cnpg { database } => pgcf_native_protocol::valid_pattern("database", database),
        }
    }
    pub fn record(&self, boot_id: &str) -> String {
        match self {
            Self::Slot { pod_uid } => format!("slot:{pod_uid}:{boot_id}"),
            Self::Cnpg { database } => format!("cnpg:{database}"),
        }
    }
}

/// `pg_control` as the agent read it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Control {
    /// PostgreSQL's DBState: 1 is "shut down".
    pub state: i32,
    pub system_identifier: String,
    /// `checkPointCopy.ThisTimeLineID`.
    pub timeline: u32,
}
impl Control {
    pub fn shut_down(&self) -> bool {
        self.state == DB_SHUTDOWNED
    }
}
/// Parses the first bytes of a PostgreSQL 18 `pg_control`.
pub fn parse_control(bytes: &[u8]) -> Result<Control, &'static str> {
    if bytes.len() < 52 {
        return Err("control_unreadable");
    }
    let word = |offset: usize| {
        u32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ])
    };
    let mut identifier = [0u8; 8];
    identifier.copy_from_slice(&bytes[..8]);
    if word(8) != PG_CONTROL_VERSION {
        return Err("control_version");
    }
    let state = word(16) as i32;
    let timeline = word(48);
    if !(0..=6).contains(&state) || timeline == 0 {
        return Err("control_unreadable");
    }
    Ok(Control {
        state,
        system_identifier: u64::from_le_bytes(identifier).to_string(),
        timeline,
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachRequest {
    pub volume: Volume,
    /// The slot Pod; the holder is `slot:<pod_uid>:<boot id>`.
    pub pod_uid: String,
    /// containerd IDs: the `postgres` container first, then `plugin-barman-cloud`.
    pub containers: Vec<String>,
}
impl AttachRequest {
    pub fn valid(&self) -> bool {
        self.volume.valid()
            && uuid_text(&self.pod_uid)
            && (1..=2).contains(&self.containers.len())
            && self.containers.iter().all(|id| lower_hex(id, 64))
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachResponse {
    pub holder: String,
    pub control: Control,
    pub attached: Vec<String>,
    /// Microseconds per step: status, holder, fsmount, control, move_<n>, audit, total.
    pub steps_us: BTreeMap<String, u64>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HoldRequest {
    pub volume: Volume,
    pub holder: Holder,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HoldResponse {
    pub holder: String,
    /// False when the same holder already held the volume.
    pub created: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseRequest {
    pub volume: Volume,
    pub holder: Holder,
    /// How long the agent waits for the device's open count to reach 0 (≤ MAX_RELEASE_WAIT_MS).
    pub wait_ms: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseResponse {
    /// False when no holder file existed.
    pub released: bool,
    pub waited_ms: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InspectRequest {
    pub volume: Volume,
    /// When set, `pg_control` and `postmaster.pid` are read through this container's root.
    pub postgres_container: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InspectResponse {
    pub exists: bool,
    pub open_count: u32,
    pub suspended: bool,
    pub holder: Option<String>,
    pub control: Option<Control>,
    pub postmaster_running: Option<bool>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HoldersRequest {}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HolderEntry {
    pub lv_uuid: String,
    pub holder: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HoldersResponse {
    pub boot_id: String,
    pub holders: Vec<HolderEntry>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ErrorBody {
    pub error: String,
}

/// The agent Pod on one node.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Agent {
    pub node: String,
    pub address: IpAddr,
}
/// The agent a Pod object names: a Ready `pgcf-attach` Pod in its namespace with a private IP.
pub fn agent_of(pod: &serde_json::Value) -> Option<Agent> {
    let ready = pod["status"]["conditions"]
        .as_array()?
        .iter()
        .any(|condition| condition["type"] == "Ready" && condition["status"] == "True");
    if pod["metadata"]["namespace"] != NAMESPACE
        || pod["metadata"]["labels"]["app.kubernetes.io/name"] != POD_NAME_LABEL
        || pod["status"]["phase"] != "Running"
        || !pod["metadata"]["deletionTimestamp"].is_null()
        || !ready
    {
        return None;
    }
    let node = pod["spec"]["nodeName"].as_str().filter(|v| node_name(v))?;
    let address: IpAddr = pod["status"]["podIP"].as_str()?.parse().ok()?;
    let private = match address {
        IpAddr::V4(ip) => ip.is_private(),
        IpAddr::V6(ip) => ip.is_unique_local(),
    };
    private.then(|| Agent {
        node: node.into(),
        address,
    })
}
#[derive(Debug, PartialEq, Eq)]
pub enum CallError {
    /// The agent answered with one of ERRORS.
    Refused(String),
    /// No answer, a malformed answer or a transport failure.
    Unavailable,
}
/// The controller's client. One call per request; nothing is retried here.
#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
}
impl Client {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn call<B: Serialize, R: DeserializeOwned>(
        &self,
        keys: &Keys,
        agent: &Agent,
        action: Action,
        lv_uuid: &str,
        body: &B,
        timeout: Duration,
        now_ms: u64,
    ) -> Result<R, CallError> {
        let nonce = nonce().map_err(|_| CallError::Unavailable)?;
        let token = sign(keys, &agent.node, action, lv_uuid, &nonce, now_ms)
            .map_err(|_| CallError::Unavailable)?;
        let host = match agent.address {
            IpAddr::V4(ip) => ip.to_string(),
            IpAddr::V6(ip) => format!("[{ip}]"),
        };
        let response = self
            .http
            .post(format!("http://{host}:{PORT}{}", action.path()))
            .header(HEADER, token)
            .json(body)
            .timeout(timeout)
            .send()
            .await
            .map_err(|_| CallError::Unavailable)?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|_| CallError::Unavailable)?;
        if bytes.len() > MAX_BODY_BYTES {
            return Err(CallError::Unavailable);
        }
        if status.is_success() {
            return serde_json::from_slice(&bytes).map_err(|_| CallError::Unavailable);
        }
        match serde_json::from_slice::<ErrorBody>(&bytes) {
            Ok(body) if ERRORS.contains(&body.error.as_str()) => {
                Err(CallError::Refused(body.error))
            }
            _ => Err(CallError::Unavailable),
        }
    }
}
