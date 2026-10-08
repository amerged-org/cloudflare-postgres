//! Local runtime IPC. No path supplied in this message is opened or executed.

pub const MAGIC: &[u8; 8] = b"PGCFSLOT";
pub const VERSION: u16 = 1;
pub const HEADER_BYTES: usize = 44;
pub const MAX_HOSTNAME_BYTES: usize = 63;
pub const MAX_MESSAGE_BYTES: usize = HEADER_BYTES + MAX_HOSTNAME_BYTES;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NamespaceIdentity {
    pub device: u64,
    pub inode: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Assignment<'a> {
    pub slot_id: [u8; 16],
    pub network: NamespaceIdentity,
    pub hostname: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolError {
    Length,
    Version,
    Slot,
    Namespace,
    Hostname,
}

pub fn parse_slot_id(value: &str) -> Result<[u8; 16], ProtocolError> {
    if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ProtocolError::Slot);
    }
    let mut id = [0; 16];
    for (i, byte) in id.iter_mut().enumerate() {
        *byte =
            u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).map_err(|_| ProtocolError::Slot)?;
    }
    if id == [0; 16] {
        return Err(ProtocolError::Slot);
    }
    Ok(id)
}

pub fn decode<'a>(
    wire: &'a [u8],
    expected_slot: &[u8; 16],
) -> Result<Assignment<'a>, ProtocolError> {
    if !(HEADER_BYTES + 1..=MAX_MESSAGE_BYTES).contains(&wire.len()) {
        return Err(ProtocolError::Length);
    }
    if &wire[..8] != MAGIC || u16::from_be_bytes([wire[8], wire[9]]) != VERSION {
        return Err(ProtocolError::Version);
    }
    let hostname_len = u16::from_be_bytes([wire[10], wire[11]]) as usize;
    if hostname_len == 0
        || hostname_len > MAX_HOSTNAME_BYTES
        || wire.len() != HEADER_BYTES + hostname_len
    {
        return Err(ProtocolError::Length);
    }
    let slot_id: [u8; 16] = wire[12..28].try_into().map_err(|_| ProtocolError::Slot)?;
    if &slot_id != expected_slot || slot_id == [0; 16] {
        return Err(ProtocolError::Slot);
    }
    let network = NamespaceIdentity {
        device: u64::from_be_bytes(
            wire[28..36]
                .try_into()
                .map_err(|_| ProtocolError::Namespace)?,
        ),
        inode: u64::from_be_bytes(
            wire[36..44]
                .try_into()
                .map_err(|_| ProtocolError::Namespace)?,
        ),
    };
    if network.inode == 0 {
        return Err(ProtocolError::Namespace);
    }
    let hostname =
        std::str::from_utf8(&wire[HEADER_BYTES..]).map_err(|_| ProtocolError::Hostname)?;
    if !hostname
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || hostname.starts_with('-')
        || hostname.ends_with('-')
    {
        return Err(ProtocolError::Hostname);
    }
    Ok(Assignment {
        slot_id,
        network,
        hostname,
    })
}

pub fn encode(assignment: &Assignment<'_>) -> Result<Vec<u8>, ProtocolError> {
    let mut wire = Vec::with_capacity(HEADER_BYTES + assignment.hostname.len());
    wire.extend_from_slice(MAGIC);
    wire.extend_from_slice(&VERSION.to_be_bytes());
    let length = u16::try_from(assignment.hostname.len()).map_err(|_| ProtocolError::Length)?;
    wire.extend_from_slice(&length.to_be_bytes());
    wire.extend_from_slice(&assignment.slot_id);
    wire.extend_from_slice(&assignment.network.device.to_be_bytes());
    wire.extend_from_slice(&assignment.network.inode.to_be_bytes());
    wire.extend_from_slice(assignment.hostname.as_bytes());
    decode(&wire, &assignment.slot_id)?;
    Ok(wire)
}
