// SPDX-License-Identifier: Apache-2.0
pub use pgcf_native_protocol::generated::{
    MAX_FRAME_BYTES, MAX_PAYLOAD_BYTES, MAX_STARTUP_BUFFER_BYTES,
};
use std::{
    collections::{HashMap, VecDeque},
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpStream,
};
/// How often the gateway says that more databases hold memory than its reserve covers.
const REPORT_WINDOW: Duration = Duration::from_secs(60);
#[derive(Default)]
struct Used {
    total: usize,
    /// The databases that hold memory, and how much.
    databases: HashMap<String, usize>,
    /// Whether more databases hold memory than the reserve covers.
    outgrown: bool,
    reported: Option<Instant>,
}
impl Used {
    /// The number of holders, when the reserve no longer covers the guaranteed share of every
    /// database that holds memory and that has not been said for [`REPORT_WINDOW`].
    fn outgrown(&mut self, covered: usize, now: Instant) -> Option<usize> {
        let holders = self.databases.len();
        if holders <= covered {
            self.outgrown = false;
            return None;
        }
        if std::mem::replace(&mut self.outgrown, true) {
            return None;
        }
        if self
            .reported
            .is_some_and(|at| now.duration_since(at) < REPORT_WINDOW)
        {
            return None;
        }
        self.reported = Some(now);
        Some(holders)
    }
}
/// Why a configuration of the byte budgets cannot be served, naming the variable to change.
pub fn check_bounds(
    maximum: usize,
    database_maximum: usize,
    reserve: usize,
    guaranteed: usize,
) -> Result<(), String> {
    if database_maximum > maximum {
        return Err(format!(
            "PGCF_GATEWAY_DATABASE_MEMORY_BYTES ({database_maximum}) must not exceed PGCF_GATEWAY_MEMORY_BYTES ({maximum})"
        ));
    }
    if reserve >= maximum {
        return Err(format!(
            "PGCF_GATEWAY_MEMORY_BYTES ({maximum}) must be at least {} (one byte more than PGCF_GATEWAY_RESERVE_BYTES, {reserve}), or lower PGCF_GATEWAY_RESERVE_BYTES",
            reserve + 1
        ));
    }
    if guaranteed > database_maximum {
        return Err(format!(
            "PGCF_GATEWAY_GUARANTEED_BYTES ({guaranteed}) must not exceed PGCF_GATEWAY_DATABASE_MEMORY_BYTES ({database_maximum})"
        ));
    }
    Ok(())
}
/// The gateway's accounted buffer memory. `maximum` is the node total; `reserve` of it is kept
/// for databases that hold less than `guaranteed` bytes, so a database that holds more can never
/// take it, and `database_maximum` bounds one database. The reserve covers the guaranteed share
/// of `reserve / guaranteed` databases that hold memory; beyond that a database within its share
/// still draws on what is free, but can be refused when the shared part is full.
pub struct MemoryBudget {
    maximum: usize,
    database_maximum: usize,
    reserve: usize,
    guaranteed: usize,
    used: Mutex<Used>,
}
impl MemoryBudget {
    pub fn new(
        maximum: usize,
        database_maximum: usize,
        reserve: usize,
        guaranteed: usize,
    ) -> Arc<Self> {
        assert!(maximum > 0 && database_maximum > 0);
        if let Err(message) = check_bounds(maximum, database_maximum, reserve, guaranteed) {
            panic!("{message}");
        }
        Arc::new(Self {
            maximum,
            database_maximum,
            reserve,
            guaranteed,
            used: Mutex::new(Used::default()),
        })
    }
    /// How many databases that hold memory the reserve covers at their guaranteed share.
    fn covered(&self) -> usize {
        self.reserve
            .checked_div(self.guaranteed)
            .unwrap_or(usize::MAX)
    }
    pub fn lease(self: &Arc<Self>, database: &str) -> Lease {
        Lease {
            budget: self.clone(),
            database: database.into(),
            bytes: 0,
        }
    }
    pub fn used(&self) -> usize {
        self.used.lock().unwrap().total
    }
    pub fn database_used(&self, database: &str) -> usize {
        *self
            .used
            .lock()
            .unwrap()
            .databases
            .get(database)
            .unwrap_or(&0)
    }
}
pub struct Lease {
    budget: Arc<MemoryBudget>,
    database: String,
    bytes: usize,
}
impl Lease {
    pub fn grow(&mut self, bytes: usize) -> bool {
        if bytes == 0 {
            return true;
        }
        let mut used = self.budget.used.lock().unwrap();
        let current = *used.databases.get(&self.database).unwrap_or(&0);
        // A database that stays within its guaranteed share may use all of the total; beyond it, a
        // database competes for what the reserve leaves. The total may lie above that ceiling:
        // the reserve was drawn on.
        let ceiling = if current.saturating_add(bytes) <= self.budget.guaranteed {
            self.budget.maximum
        } else {
            self.budget.maximum - self.budget.reserve
        };
        if bytes > ceiling.saturating_sub(used.total)
            || bytes > self.budget.database_maximum - current
        {
            return false;
        }
        used.total += bytes;
        *used.databases.entry(self.database.clone()).or_default() += bytes;
        self.bytes += bytes;
        // One line when a database starts to hold memory that the reserve cannot cover with
        // everyone's guaranteed share; nothing else changes.
        let holders = if current == 0 {
            used.outgrown(self.budget.covered(), Instant::now())
        } else {
            None
        };
        drop(used);
        if let Some(holders) = holders {
            println!(
                "{}",
                serde_json::json!({"event":"memory_reserve_outgrown","holders":holders,"guaranteed_bytes":self.budget.guaranteed,"reserve_bytes":self.budget.reserve})
            );
        }
        true
    }
    pub fn split(&mut self, bytes: usize) -> Self {
        assert!(bytes <= self.bytes);
        self.bytes -= bytes;
        Self {
            budget: self.budget.clone(),
            database: self.database.clone(),
            bytes,
        }
    }
    pub fn shrink(&mut self, bytes: usize) {
        assert!(bytes <= self.bytes);
        if bytes == 0 {
            return;
        }
        let mut used = self.budget.used.lock().unwrap();
        used.total -= bytes;
        let current = used.databases.get_mut(&self.database).unwrap();
        *current -= bytes;
        if *current == 0 {
            used.databases.remove(&self.database);
            used.outgrown(self.budget.covered(), Instant::now());
        }
        self.bytes -= bytes;
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.shrink(self.bytes);
    }
}
struct FrameReader {
    header: [u8; 14],
    bytes: usize,
    header_length: usize,
    remaining: usize,
    data: bool,
    final_frame: bool,
    frame_charge: usize,
    message_charge: usize,
    message_payload: usize,
    maximum: usize,
    complete: VecDeque<usize>,
    lease: Lease,
    invalid: bool,
}
impl FrameReader {
    fn new(lease: Lease) -> Self {
        Self {
            header: [0; 14],
            bytes: 0,
            header_length: 2,
            remaining: 0,
            data: false,
            final_frame: false,
            frame_charge: 0,
            message_charge: 0,
            message_payload: 0,
            maximum: MAX_STARTUP_BUFFER_BYTES,
            complete: VecDeque::new(),
            lease,
            invalid: false,
        }
    }
    fn observe(&mut self, chunk: &[u8]) -> io::Result<()> {
        let mut position = 0;
        while position < chunk.len() {
            if self.bytes < self.header_length {
                let take = (self.header_length - self.bytes).min(chunk.len() - position);
                self.header[self.bytes..self.bytes + take]
                    .copy_from_slice(&chunk[position..position + take]);
                self.bytes += take;
                position += take;
                if self.bytes < self.header_length {
                    break;
                }
                if self.header_length == 2 {
                    if self.header[1] & 128 == 0 {
                        return self.fail("client frames must be masked");
                    }
                    let encoded = self.header[1] & 127;
                    self.header_length = 6 + if encoded == 126 {
                        2
                    } else if encoded == 127 {
                        8
                    } else {
                        0
                    };
                    continue;
                }
                let encoded = self.header[1] & 127;
                let length = if encoded == 126 {
                    u16::from_be_bytes(self.header[2..4].try_into().unwrap()) as u64
                } else if encoded == 127 {
                    u64::from_be_bytes(self.header[2..10].try_into().unwrap())
                } else {
                    encoded as u64
                };
                if length > self.maximum as u64 {
                    return self.fail("websocket payload bound exceeded");
                }
                let length = length as usize;
                let charge = length
                    .checked_mul(2)
                    .and_then(|v| v.checked_add(256))
                    .ok_or_else(|| io::Error::other("frame charge overflow"))?;
                let opcode = self.header[0] & 15;
                self.data = opcode <= 2;
                if self.data && length > self.maximum - self.message_payload {
                    return self.fail("websocket message bound exceeded");
                }
                if !self.lease.grow(charge) {
                    return self.fail("gateway memory bound exceeded");
                }
                self.frame_charge = charge;
                self.remaining = length;
                self.final_frame = self.header[0] & 128 != 0;
                if self.data {
                    self.message_charge += charge;
                    self.message_payload += length;
                }
            }
            let take = self.remaining.min(chunk.len() - position);
            position += take;
            self.remaining -= take;
            if self.remaining == 0 {
                if self.data {
                    if self.final_frame {
                        self.complete.push_back(self.message_charge);
                        self.message_charge = 0;
                        self.message_payload = 0;
                    }
                } else {
                    self.lease.shrink(self.frame_charge);
                }
                self.bytes = 0;
                self.header_length = 2;
                self.frame_charge = 0;
            }
        }
        Ok(())
    }
    fn fail<T>(&mut self, message: &str) -> io::Result<T> {
        self.invalid = true;
        Err(io::Error::other(message))
    }
    fn busy(&self) -> bool {
        self.invalid
            || self.bytes != 0
            || self.remaining != 0
            || self.message_charge != 0
            || !self.complete.is_empty()
    }
}
#[derive(Clone)]
pub struct WireBudget(Arc<Mutex<FrameReader>>);
impl WireBudget {
    pub fn new(lease: Lease) -> Self {
        Self(Arc::new(Mutex::new(FrameReader::new(lease))))
    }
    pub fn busy(&self) -> bool {
        self.0.lock().unwrap().busy()
    }
    pub fn allow_relay(&self) {
        self.0.lock().unwrap().maximum = MAX_PAYLOAD_BYTES;
    }
    pub fn take_message(&self) -> io::Result<Lease> {
        let mut state = self.0.lock().unwrap();
        let amount = state
            .complete
            .pop_front()
            .ok_or_else(|| io::Error::other("unaccounted websocket message"))?;
        Ok(state.lease.split(amount))
    }
    fn observe(&self, bytes: &[u8]) -> io::Result<()> {
        self.0.lock().unwrap().observe(bytes)
    }
}
/// Accounts advertised masked-frame payload before handing bytes to the WebSocket
/// decoder. Buffer charge follows the decoded message until it is written or dropped.
pub struct BudgetedStream {
    stream: TcpStream,
    prefix: Vec<u8>,
    position: usize,
    http_remaining: usize,
    wire: WireBudget,
    _base: Lease,
}
impl BudgetedStream {
    pub fn new(
        stream: TcpStream,
        prefix: Vec<u8>,
        http_remaining: usize,
        wire: WireBudget,
        base: Lease,
    ) -> Self {
        Self {
            stream,
            prefix,
            position: 0,
            http_remaining,
            wire,
            _base: base,
        }
    }
    fn account(&mut self, bytes: &[u8]) -> io::Result<()> {
        let skip = self.http_remaining.min(bytes.len());
        self.http_remaining -= skip;
        self.wire.observe(&bytes[skip..])
    }
}
impl AsyncRead for BudgetedStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if out.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        let mut scratch = [0u8; MAX_FRAME_BYTES];
        let count = out.remaining().min(scratch.len());
        if self.position < self.prefix.len() {
            let take = count.min(self.prefix.len() - self.position);
            scratch[..take].copy_from_slice(&self.prefix[self.position..self.position + take]);
            self.position += take;
            if let Err(error) = self.account(&scratch[..take]) {
                return Poll::Ready(Err(error));
            }
            out.put_slice(&scratch[..take]);
            return Poll::Ready(Ok(()));
        }
        let mut read = ReadBuf::new(&mut scratch[..count]);
        match Pin::new(&mut self.stream).poll_read(cx, &mut read) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Ready(Ok(())) => {
                let bytes = read.filled();
                if let Err(error) = self.account(bytes) {
                    return Poll::Ready(Err(error));
                }
                out.put_slice(bytes);
                Poll::Ready(Ok(()))
            }
        }
    }
}
impl AsyncWrite for BudgetedStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn frame(opcode: u8, final_frame: bool, body: &[u8]) -> Vec<u8> {
        let mut result = vec![opcode | if final_frame { 128 } else { 0 }];
        if body.len() < 126 {
            result.push(128 | body.len() as u8);
        } else if body.len() <= 65535 {
            result.push(128 | 126);
            result.extend_from_slice(&(body.len() as u16).to_be_bytes());
        } else {
            result.push(128 | 127);
            result.extend_from_slice(&(body.len() as u64).to_be_bytes());
        }
        result.extend_from_slice(&[0, 0, 0, 0]);
        result.extend_from_slice(body);
        result
    }
    #[test]
    fn advertised_memory_is_reserved_before_payload_and_freed_on_failure() {
        let memory = MemoryBudget::new(1024, 1024, 0, 0);
        let wire = WireBudget::new(memory.lease("db"));
        let packet = frame(2, true, &[0; 512]);
        assert!(wire.observe(&packet[..8]).is_err());
        assert_eq!(memory.used(), 0);
        assert!(wire.busy());
    }
    #[test]
    fn fragmented_message_owns_one_charge_until_forwarded_and_partial_input_is_busy() {
        let memory = MemoryBudget::new(4096, 4096, 0, 0);
        let wire = WireBudget::new(memory.lease("db"));
        let first = frame(2, false, b"abc");
        wire.observe(&first[..1]).unwrap();
        assert!(wire.busy());
        wire.observe(&first[1..]).unwrap();
        wire.observe(&frame(9, true, b"ping")).unwrap();
        assert!(wire.busy());
        assert_eq!(memory.used(), 262);
        wire.observe(&frame(0, true, b"de")).unwrap();
        assert_eq!(memory.used(), 522);
        assert!(wire.busy());
        let held = wire.take_message().unwrap();
        assert!(!wire.busy());
        assert_eq!(memory.used(), 522);
        drop(held);
        assert_eq!(memory.used(), 0);
    }
    #[test]
    fn database_and_global_budgets_are_independent_and_never_evict_live_buffers() {
        let memory = MemoryBudget::new(2048, 1024, 0, 0);
        let a = WireBudget::new(memory.lease("a"));
        let b = WireBudget::new(memory.lease("b"));
        a.observe(&frame(2, true, &[0; 300])).unwrap();
        b.observe(&frame(2, true, &[0; 300])).unwrap();
        assert_eq!(memory.used(), 1712);
        assert!(a.observe(&frame(2, true, &[0; 100])).is_err());
        assert_eq!(memory.used(), 1712);
        let c = WireBudget::new(memory.lease("c"));
        assert!(c.observe(&frame(2, true, &[0; 200])).is_err());
        assert_eq!(memory.used(), 1712);
        drop(a);
        drop(b);
        drop(c);
        assert_eq!(memory.used(), 0);
    }
    #[test]
    fn databases_filling_the_shared_part_leave_every_other_database_its_guaranteed_share() {
        let memory = MemoryBudget::new(192 << 20, 96 << 20, 96 << 20, 3 << 20);
        let (mut a, mut b) = (memory.lease("a"), memory.lease("b"));
        while a.grow(1 << 20) {}
        while b.grow(1 << 20) {}
        // The first fills the shared part; the second gets its guaranteed share out of the reserve
        // and no more.
        assert_eq!(memory.database_used("a"), 96 << 20);
        assert_eq!(memory.database_used("b"), 3 << 20);
        // A session and a masked frame of a third database are within its guaranteed share.
        let mut c = memory.lease("c");
        assert!(c.grow(crate::transport::SESSION_MEMORY_BYTES));
        let wire = WireBudget::new(memory.lease("c"));
        wire.observe(&frame(10, true, b"")).unwrap();
        wire.observe(&frame(2, true, &[0; 1024])).unwrap();
        // A database beyond its guaranteed share competes for the shared part only.
        let mut d = memory.lease("d");
        assert!(
            !d.grow(4 << 20),
            "above the guaranteed share the reserve is closed"
        );
        assert!(d.grow(3 << 20));
        assert!(
            !d.grow(1),
            "past the guaranteed share the reserve stays closed"
        );
    }
    #[test]
    fn the_reserve_is_checked_against_the_configuration_and_reported_once_its_holders_outgrow_it() {
        // The old default total stays valid; a total at or below the reserve names its variable
        // and the smallest value.
        assert!(check_bounds(192 << 20, 96 << 20, 96 << 20, 3 << 20).is_ok());
        let message = check_bounds(96 << 20, 96 << 20, 96 << 20, 3 << 20).unwrap_err();
        assert!(message.contains("PGCF_GATEWAY_MEMORY_BYTES (100663296)"));
        assert!(message.contains("at least 100663297"));
        assert!(check_bounds(100, 200, 10, 5).is_err_and(|m| m.contains("DATABASE_MEMORY")));
        assert!(check_bounds(100, 50, 10, 60).is_err_and(|m| m.contains("GUARANTEED")));
        // Three databases hold memory where the reserve covers two guaranteed shares.
        let memory = MemoryBudget::new(1000, 500, 20, 10);
        let mut leases: Vec<Lease> = ["a", "b", "c"]
            .map(|database| {
                let mut lease = memory.lease(database);
                assert!(lease.grow(1));
                lease
            })
            .into();
        assert!(memory.used.lock().unwrap().outgrown);
        drop(leases.pop());
        assert!(!memory.used.lock().unwrap().outgrown);
        // It is said once for a stretch above the reserve and at most once in the window.
        let (mut used, start) = (Used::default(), Instant::now());
        for database in ["a", "b", "c"] {
            used.databases.insert(database.into(), 1);
        }
        assert_eq!(used.outgrown(2, start), Some(3));
        assert_eq!(used.outgrown(2, start), None);
        used.databases.remove("c");
        assert_eq!(used.outgrown(2, start), None);
        used.databases.insert("c".into(), 1);
        assert_eq!(used.outgrown(2, start + REPORT_WINDOW / 2), None);
        assert_eq!(used.outgrown(2, start + REPORT_WINDOW), None);
        used.databases.remove("c");
        used.outgrown(2, start + REPORT_WINDOW);
        used.databases.insert("c".into(), 1);
        assert_eq!(used.outgrown(2, start + REPORT_WINDOW), Some(3));
    }
    #[test]
    fn startup_fragments_cannot_evade_total_bound_and_relay_accepts_large_advertisement() {
        let memory = MemoryBudget::new(100 * 1024 * 1024, 96 * 1024 * 1024, 0, 0);
        let startup = WireBudget::new(memory.lease("db"));
        startup.observe(&frame(2, false, &vec![0; 32768])).unwrap();
        assert!(startup.observe(&frame(0, true, &vec![0; 32769])).is_err());
        drop(startup);
        assert_eq!(memory.used(), 0);
        let relay = WireBudget::new(memory.lease("db"));
        relay.allow_relay();
        let mut header = vec![0x82, 0xff];
        header.extend_from_slice(&(MAX_PAYLOAD_BYTES as u64).to_be_bytes());
        header.extend_from_slice(&[0; 4]);
        relay.observe(&header).unwrap();
        assert_eq!(memory.used(), MAX_PAYLOAD_BYTES * 2 + 256);
        assert!(relay.busy());
        drop(relay);
        assert_eq!(memory.used(), 0);
    }
}
