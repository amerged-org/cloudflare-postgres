// SPDX-License-Identifier: Apache-2.0
//! Observe PostgreSQL message boundaries without retaining SQL or authentication bodies.
#[derive(Default)]
struct MessageReader {
    header: [u8; 5],
    prefix: [u8; 4],
    header_bytes: usize,
    remaining: u32,
    prefix_bytes: usize,
    length: u32,
    tag: u8,
    invalid: bool,
}
enum Event {
    Start(u8, u32),
    Complete(u8, u32, [u8; 4], usize),
}
impl MessageReader {
    fn partial(&self) -> bool {
        self.header_bytes != 0 || self.remaining != 0
    }
    fn push(&mut self, chunk: &[u8], mut observe: impl FnMut(Event)) {
        let mut offset = 0;
        while offset < chunk.len() && !self.invalid {
            if self.header_bytes < 5 {
                let take = (5 - self.header_bytes).min(chunk.len() - offset);
                self.header[self.header_bytes..self.header_bytes + take]
                    .copy_from_slice(&chunk[offset..offset + take]);
                self.header_bytes += take;
                offset += take;
                if self.header_bytes < 5 {
                    return;
                }
                self.tag = self.header[0];
                self.length = u32::from_be_bytes(self.header[1..5].try_into().unwrap());
                if self.length < 4 || self.length > 0x7fff_ffff {
                    self.invalid = true;
                    return;
                }
                self.remaining = self.length - 4;
                self.prefix_bytes = 0;
                observe(Event::Start(self.tag, self.length));
            }
            let take = (self.remaining as usize).min(chunk.len() - offset);
            let keep = take.min(4 - self.prefix_bytes);
            if keep > 0 {
                self.prefix[self.prefix_bytes..self.prefix_bytes + keep]
                    .copy_from_slice(&chunk[offset..offset + keep]);
                self.prefix_bytes += keep;
            }
            offset += take;
            self.remaining -= take as u32;
            if self.remaining == 0 {
                observe(Event::Complete(
                    self.tag,
                    self.length,
                    self.prefix,
                    self.prefix_bytes,
                ));
                self.header_bytes = 0;
            }
        }
    }
}
struct State {
    authenticated: bool,
    ready_cycles: u64,
    complete_ready_cycles: u64,
    extended: bool,
    copy: bool,
    transaction: bool,
    uncertain: bool,
}
impl Default for State {
    fn default() -> Self {
        Self {
            authenticated: false,
            ready_cycles: 1,
            complete_ready_cycles: 1,
            extended: false,
            copy: false,
            transaction: true,
            uncertain: false,
        }
    }
}
#[derive(Default)]
pub struct PostgresActivity {
    state: State,
    frontend: MessageReader,
    backend: MessageReader,
}
impl PostgresActivity {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn authenticated(&self) -> bool {
        self.state.authenticated
    }
    pub fn observe_frontend(&mut self, chunk: &[u8]) {
        let state = &mut self.state;
        self.frontend.push(chunk, |event| match event {
            Event::Start(tag, length) => match tag {
                b'Q' | b'S' => {
                    state.ready_cycles = state.ready_cycles.saturating_add(1);
                    if state.ready_cycles > 65536 || (tag == b'S' && length != 4) {
                        state.uncertain = true;
                    }
                }
                b'P' | b'B' | b'E' | b'D' | b'C' | b'H' => state.extended = true,
                b'd' | b'c' | b'f' => state.copy = true,
                b'p' => {
                    if state.authenticated {
                        state.uncertain = true;
                    }
                }
                _ => state.uncertain = true,
            },
            Event::Complete(tag, _, _, _) => {
                if tag == b'Q' || tag == b'S' {
                    state.complete_ready_cycles = state.complete_ready_cycles.saturating_add(1);
                }
                if tag == b'S' {
                    state.extended = false;
                }
            }
        });
    }
    pub fn observe_backend(&mut self, chunk: &[u8]) {
        let state = &mut self.state;
        self.backend.push(chunk, |event| match event {
            Event::Start(b'G' | b'H' | b'W', _) => state.copy = true,
            Event::Complete(b'R', length, prefix, _) => {
                if length < 8 {
                    state.uncertain = true;
                } else if u32::from_be_bytes(prefix) == 0 {
                    if length != 8 || state.authenticated {
                        state.uncertain = true;
                    }
                    state.authenticated = true;
                }
            }
            Event::Complete(b'Z', length, prefix, prefix_bytes) => {
                let idle_state = prefix[0];
                if length != 5
                    || prefix_bytes != 1
                    || !state.authenticated
                    || state.complete_ready_cycles == 0
                    || !matches!(idle_state, b'I' | b'T' | b'E')
                {
                    state.uncertain = true;
                    return;
                }
                state.ready_cycles = state.ready_cycles.saturating_sub(1);
                state.complete_ready_cycles -= 1;
                state.transaction = idle_state != b'I';
                state.copy = false;
            }
            _ => {}
        });
    }
    pub fn busy(&self) -> bool {
        let state = &self.state;
        state.uncertain
            || !state.authenticated
            || state.transaction
            || state.ready_cycles != 0
            || state.extended
            || state.copy
            || self.frontend.invalid
            || self.backend.invalid
            || self.frontend.partial()
            || self.backend.partial()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    fn decode(hex: &str) -> Vec<u8> {
        assert_eq!(hex.len() % 2, 0);
        hex.as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
            .collect()
    }
    #[test]
    fn authoritative_typescript_activity_vectors() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../contracts/native/conformance.generated.json"
        ))
        .unwrap();
        for case in fixtures["postgresActivity"].as_array().unwrap() {
            let mut activity = PostgresActivity::default();
            assert_eq!(
                json!({"authenticated":activity.authenticated(),"busy":activity.busy()}),
                case["initial"]
            );
            for step in case["steps"].as_array().unwrap() {
                let bytes = decode(step["hex"].as_str().unwrap());
                for _ in 0..step["repeat"].as_u64().unwrap_or(1) {
                    if step["direction"] == "frontend" {
                        activity.observe_frontend(&bytes);
                    } else {
                        activity.observe_backend(&bytes);
                    }
                }
                assert_eq!(
                    json!({"authenticated":activity.authenticated(),"busy":activity.busy()}),
                    step["expected"],
                    "{} {step}",
                    case["name"]
                );
            }
        }
    }
    #[test]
    fn protocol_observer_retains_only_headers_and_prefixes() {
        assert!(std::mem::size_of::<PostgresActivity>() < 256);
        let mut reader = MessageReader::default();
        let mut header = [0; 5];
        header[0] = b'd';
        header[1..].copy_from_slice(&(1024u32 * 1024 + 4).to_be_bytes());
        let mut complete = 0;
        reader.push(&header, |_| {});
        for _ in 0..1024 {
            reader.push(&[7; 1024], |event| {
                if let Event::Complete(_, _, prefix, len) = event {
                    assert_eq!(prefix, [7; 4]);
                    assert_eq!(len, 4);
                    complete += 1;
                }
            });
        }
        assert_eq!(complete, 1);
        assert!(!reader.partial());
    }
}
