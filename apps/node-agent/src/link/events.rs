// SPDX-License-Identifier: Apache-2.0
//! What the link tells the agent: Cloudflare asks for a pull of the desired page, or has fenced
//! the node. Requests to pull coalesce into one, so that a slow agent never queues them up and
//! never misses one.
use super::desired::IDS_PER_PULL;
use std::{
    collections::BTreeSet,
    sync::{Mutex, MutexGuard, PoisonError},
};
use tokio::sync::Notify;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkEvent {
    /// Pull the desired page now: all of it (`None`), or only the databases named. The orders
    /// are on the page.
    Desired(Option<Vec<String>>),
    /// Cloudflare answered 403 `node_fenced`: the node was declared lost (plan 9.4). Its desired
    /// page now holds the fence and the superseded orders and no database. The link stops after
    /// this event; only the desired page and the observations are still accepted.
    Fenced,
}

#[derive(Debug, Default, PartialEq, Eq)]
enum Pull {
    #[default]
    Nothing,
    Databases(BTreeSet<String>),
    All,
}
impl Pull {
    fn add(&mut self, ids: Option<&[String]>) {
        let Some(ids) = ids else {
            return *self = Self::All;
        };
        match self {
            Self::All => {}
            Self::Nothing => *self = Self::Databases(ids.iter().cloned().collect()),
            Self::Databases(held) => held.extend(ids.iter().cloned()),
        }
        if matches!(self, Self::Databases(held) if held.len() > IDS_PER_PULL) {
            *self = Self::All;
        }
    }
    fn take(&mut self) -> Option<Option<Vec<String>>> {
        match std::mem::take(self) {
            Self::Nothing => None,
            Self::All => Some(None),
            Self::Databases(ids) => Some(Some(ids.into_iter().collect())),
        }
    }
}

#[derive(Default)]
struct State {
    pull: Pull,
    fenced: bool,
    fence_reported: bool,
    closed: bool,
}
/// The side of the link tasks.
#[derive(Default)]
pub(super) struct Events {
    state: Mutex<State>,
    wake: Notify,
}
impl Events {
    /// Cloudflare asks for a pull of these databases, or of all (`None`).
    pub fn pull(&self, ids: Option<&[String]>) {
        self.state().pull.add(ids);
        self.wake.notify_one();
    }
    /// The node is fenced; the agent pulls its page too. Every refused request says so again,
    /// and only the first one is news.
    pub fn fence(&self) {
        {
            let mut state = self.state();
            if state.fenced {
                return;
            }
            state.fenced = true;
            state.pull.add(None);
        }
        self.wake.notify_one();
    }
    pub fn fenced(&self) -> bool {
        self.state().fenced
    }
    /// The link has ended; the events still pending are delivered first.
    pub fn close(&self) {
        self.state().closed = true;
        self.wake.notify_one();
    }
    pub(super) async fn next(&self) -> Option<LinkEvent> {
        loop {
            {
                let mut state = self.state();
                if state.fenced && !state.fence_reported {
                    state.fence_reported = true;
                    return Some(LinkEvent::Fenced);
                }
                if let Some(ids) = state.pull.take() {
                    return Some(LinkEvent::Desired(ids));
                }
                if state.closed {
                    return None;
                }
            }
            self.wake.notified().await;
        }
    }
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn pulls_of_databases_merge_and_a_pull_of_all_absorbs_them() {
        let mut pull = Pull::default();
        assert_eq!(pull.take(), None);
        pull.add(Some(&ids(&["b", "a"])));
        pull.add(Some(&ids(&["c", "a"])));
        assert_eq!(pull.take(), Some(Some(ids(&["a", "b", "c"]))));
        assert_eq!(pull.take(), None);
        pull.add(Some(&ids(&["a"])));
        pull.add(None);
        pull.add(Some(&ids(&["b"])));
        assert_eq!(pull.take(), Some(None));
        // So many databases are cheaper to pull whole, and the page size bounds the request.
        let many: Vec<String> = (0..=IDS_PER_PULL).map(|i| format!("{i:02}")).collect();
        pull.add(Some(&many));
        assert_eq!(pull.take(), Some(None));
    }

    #[tokio::test]
    async fn events_come_in_order_a_fence_first_and_the_stream_ends_after_close() {
        let events = Events::default();
        events.pull(Some(&ids(&["a"])));
        events.pull(Some(&ids(&["b"])));
        assert_eq!(
            events.next().await,
            Some(LinkEvent::Desired(Some(ids(&["a", "b"]))))
        );
        // A pull that arrives while the consumer waits wakes it.
        let waiting = events.next();
        tokio::pin!(waiting);
        assert!(futures_util::poll!(waiting.as_mut()).is_pending());
        events.pull(None);
        assert_eq!(waiting.await, Some(LinkEvent::Desired(None)));
        // A fence is reported once, and the page that holds it is pulled after it.
        events.pull(Some(&ids(&["a"])));
        events.fence();
        assert!(events.fenced());
        assert_eq!(events.next().await, Some(LinkEvent::Fenced));
        assert_eq!(events.next().await, Some(LinkEvent::Desired(None)));
        events.fence();
        events.close();
        assert_eq!(events.next().await, None);
    }
}
