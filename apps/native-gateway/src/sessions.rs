// SPDX-License-Identifier: Apache-2.0
use crate::budget::WireBudget;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::watch;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Running,
    Quiesce,
    Retire,
    CloseIdle,
    CloseAuthentication,
}
pub struct Session {
    pub database: String,
    pub authenticated: bool,
    pub busy: bool,
    pub pending_dial: bool,
    pub wire: WireBudget,
    pub action: watch::Sender<Action>,
}
#[derive(Default)]
pub struct Sessions {
    entries: HashMap<String, Session>,
}
pub type SharedSessions = Arc<Mutex<Sessions>>;
impl Sessions {
    pub fn contains(&self, id: &str) -> bool {
        self.entries.contains_key(id)
    }
    pub fn insert(
        &mut self,
        id: String,
        database: String,
        wire: WireBudget,
    ) -> watch::Receiver<Action> {
        let (action, receiver) = watch::channel(Action::Running);
        assert!(
            self.entries
                .insert(
                    id,
                    Session {
                        database,
                        authenticated: false,
                        busy: true,
                        pending_dial: false,
                        wire,
                        action
                    }
                )
                .is_none()
        );
        receiver
    }
    pub fn update(&mut self, id: &str, authenticated: bool, busy: bool, pending_dial: bool) {
        if let Some(session) = self.entries.get_mut(id) {
            session.authenticated = authenticated;
            session.busy = busy;
            session.pending_dial = pending_dial;
        }
    }
    pub fn remove(&mut self, id: &str) {
        self.entries.remove(id);
    }
    pub fn signal(&self, database: &str, action: Action) {
        for session in self.entries.values().filter(|s| s.database == database) {
            let actual = if action == Action::Quiesce && !session.authenticated {
                Action::CloseAuthentication
            } else {
                action
            };
            let _ = session.action.send(actual);
        }
    }
    pub fn counts(&self, database: &str) -> Counts {
        let mut counts = Counts::default();
        for session in self.entries.values().filter(|s| s.database == database) {
            counts.connections += 1;
            counts.authenticated += session.authenticated as usize;
            let busy = session.busy || session.wire.busy();
            counts.busy += busy as usize;
            counts.authenticated_busy += (session.authenticated && busy) as usize;
            counts.pending_dials += session.pending_dial as usize;
        }
        counts
    }
}
#[derive(Default, Debug, Clone, Copy)]
pub struct Counts {
    pub connections: usize,
    pub authenticated: usize,
    pub busy: usize,
    pub authenticated_busy: usize,
    pub pending_dials: usize,
}
