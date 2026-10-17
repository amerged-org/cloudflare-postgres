// SPDX-License-Identifier: Apache-2.0
//! The wait between attempts to reach Cloudflare: exponential, with jitter so that the nodes of
//! a region do not all return at the same instant after an outage.
use ring::rand::{SecureRandom, SystemRandom};
use std::time::Duration;

pub struct Backoff {
    minimum: Duration,
    maximum: Duration,
    ceiling: Duration,
}
impl Backoff {
    pub fn new(minimum: Duration, maximum: Duration) -> Self {
        Self {
            minimum,
            maximum,
            ceiling: minimum,
        }
    }
    /// The next ceiling, which doubles up to the maximum.
    fn step(&mut self) -> Duration {
        let ceiling = self.ceiling;
        self.ceiling = (ceiling * 2).min(self.maximum);
        ceiling
    }
    /// The wait before the next attempt: between half of the ceiling and all of it.
    pub fn wait(&mut self) -> Duration {
        let ceiling = self.step();
        let mut random = [0; 8];
        // The system generator fails only when the kernel has none; the ceiling is a safe wait.
        if SystemRandom::new().fill(&mut random).is_err() {
            return ceiling;
        }
        let fraction = (u64::from_le_bytes(random) >> 11) as f64 / (1u64 << 53) as f64;
        ceiling.mul_f64(0.5 + fraction / 2.0)
    }
    /// The next attempt follows a good connection: start from the minimum again.
    pub fn reset(&mut self) {
        self.ceiling = self.minimum;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ceiling_doubles_to_the_maximum_and_a_reset_starts_again() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));
        let ceilings: Vec<u64> = (0..8).map(|_| backoff.step().as_secs()).collect();
        assert_eq!(ceilings, [1, 2, 4, 8, 16, 32, 60, 60]);
        backoff.reset();
        assert_eq!(backoff.step(), Duration::from_secs(1));
    }

    #[test]
    fn a_wait_is_between_half_of_the_ceiling_and_all_of_it() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));
        let mut seen = std::collections::HashSet::new();
        for _ in 0..200 {
            backoff.reset();
            backoff.step();
            backoff.step();
            let wait = backoff.wait();
            assert!(wait >= Duration::from_secs(2) && wait <= Duration::from_secs(4));
            seen.insert(wait);
        }
        assert!(seen.len() > 100, "the wait carries jitter");
    }
}
