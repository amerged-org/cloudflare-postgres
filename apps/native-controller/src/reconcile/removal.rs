// SPDX-License-Identifier: Apache-2.0
//! The removal of a role the desired record names `{name, state:"absent"}`: a role the API
//! deleted, whose removal from PostgreSQL is not yet confirmed.
//!
//! A deleted role leaves in stages, so that nothing is dropped under a client and nothing is
//! asked of CNPG that cannot succeed. The manifests first enter it as a disabled role, which
//! cannot log in. Once PostgreSQL holds it as NOLOGIN its sessions are ended and, when no object
//! depends on it, the Cluster is made to drop it. Only a role PostgreSQL no longer has is
//! reported removed, and then its credential goes. A role with objects stays disabled and is
//! reported blocked until its owner removes them.
//!
//! The Cluster is the record of the stage and PostgreSQL's catalogs say how far a role has come,
//! so every pass derives its steps from them and keeps nothing: after a restart, a hibernation or
//! a wake the removal resumes where the objects say it is.
use super::*;
use crate::{contracts::removal_roles, diagnostics::error_code, postgres::Held};
use std::net::SocketAddr;

/// What a pass spends on the removals at most: the observation that reports readiness waits for
/// it, and the pass has a budget of its own.
const BUDGET: Duration = Duration::from_secs(8);

/// Where the removal of one role stands after a pass.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Pending,
    Removed,
    Blocked,
}
/// What one pass found to do for one role.
enum Step {
    /// Nothing yet: PostgreSQL has not caught up, or sessions remain.
    Wait,
    /// The role is as good as gone: the Cluster is made to drop it, and the next pass confirms.
    Drop,
    Removed,
    Blocked,
}

/// Whether the Cluster's managed role `name` is entered as absent: CNPG has been asked to drop it.
pub(super) fn drops(cluster: &Value, name: &str) -> bool {
    cluster["spec"]["managed"]["roles"]
        .as_array()
        .is_some_and(|roles| {
            roles
                .iter()
                .any(|role| role["name"] == name && role["ensure"] == "absent")
        })
}
/// The removal entries of `db` the Cluster already drops. The Cluster is the record of the stage:
/// a controller that restarted, woke or met a new generation continues from what it says.
pub(super) fn cluster_drops(db: &Value, cluster: Option<&Value>) -> Value {
    removal_roles(db)
        .filter(|role| cluster.is_some_and(|cluster| drops(cluster, text(role, "name"))))
        .map(|role| role["name"].clone())
        .collect::<Vec<_>>()
        .into()
}
/// Whether CNPG reports that it cannot drop the role: PostgreSQL's own refusal, because objects
/// depend on it.
fn cannot_be_dropped(cluster: &Value, name: &str) -> bool {
    let reasons = &cluster["status"]["managedRolesStatus"]["cannotReconcile"][name];
    reasons
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .chain(reasons.as_str())
        .any(|reason| reason.contains("cannot be dropped"))
}

impl Reconciler {
    /// One level-triggered step of the removal of every role the record awaits the removal of, in
    /// one session of the maintenance role. `None` when the record awaits none: such a database
    /// reports no roles at all. Otherwise the roles confirmed removed and those blocked; the
    /// others are pending. Nothing here fails the pass: a role that could not be advanced is
    /// pending, and a database becomes ready as soon as its present roles are verified.
    pub(super) async fn advance_removals(
        &self,
        db: &Value,
        context: &Value,
        ca: &[u8],
        socket: Option<SocketAddr>,
    ) -> Option<Value> {
        let names: Vec<&str> = removal_roles(db).map(|role| text(role, "name")).collect();
        if names.is_empty() {
            return None;
        }
        let mut stages = vec![Stage::Pending; names.len()];
        let outcome = tokio::time::timeout(
            BUDGET,
            self.settle_removals(db, context, ca, socket, &names, &mut stages),
        )
        .await;
        // Only the class of a failure is logged; its text can name objects.
        let failure = match outcome {
            Ok(None) => None,
            Ok(Some(error)) => Some(error_code(&error)),
            Err(_) => Some("deadline_exceeded".to_string()),
        };
        if let Some(error) = failure {
            eprintln!(
                "{}",
                json!({"event":"role_removal_pending","database_id":db["id"],"generation":db["generation"],"error":error})
            );
        }
        let with = |wanted: Stage| -> Vec<Value> {
            names
                .iter()
                .zip(&stages)
                .filter(|(_, stage)| **stage == wanted)
                .map(|(name, _)| Value::from(*name))
                .collect()
        };
        Some(json!({"removed":with(Stage::Removed),"blocked":with(Stage::Blocked)}))
    }
    /// Advances every role it can; the first failure is returned once the others were tried.
    async fn settle_removals(
        &self,
        db: &Value,
        context: &Value,
        ca: &[u8],
        socket: Option<SocketAddr>,
        names: &[&str],
        stages: &mut [Stage],
    ) -> Option<Error> {
        // Without the maintenance credential nothing can be read or ended.
        if db["maintenance"].is_null() {
            return None;
        }
        let ns = namespace(db);
        let cluster = match self.k8s.read("Cluster", Some(&ns), "database").await {
            Ok(Some(cluster)) => cluster,
            Ok(None) => return Some("removal Cluster missing".into()),
            Err(error) => return Some(error),
        };
        let session = match postgres::maintenance(db, ca, socket).await {
            Ok(session) => session,
            Err(error) => return Some(error),
        };
        let mut failure = None;
        let mut drop_now = Vec::new();
        for (index, name) in names.iter().enumerate() {
            match self.removal_step(db, &cluster, &session, name).await {
                Ok(Step::Removed) => stages[index] = Stage::Removed,
                Ok(Step::Blocked) => stages[index] = Stage::Blocked,
                Ok(Step::Drop) => drop_now.push(*name),
                Ok(Step::Wait) => {}
                Err(error) => failure = failure.or(Some(error)),
            }
        }
        if !drop_now.is_empty()
            && let Err(error) = self.enter_drop(db, context, &cluster, &drop_now).await
        {
            failure = failure.or(Some(error));
        }
        failure
    }
    /// What the Cluster and the catalogs say to do for `name`. The statements bind the role; it
    /// is never part of their text.
    async fn removal_step(
        &self,
        db: &Value,
        cluster: &Value,
        session: &postgres::Session,
        name: &str,
    ) -> Result<Step, Error> {
        let named_absent = drops(cluster, name);
        match postgres::held(session, name).await? {
            Held::Absent if named_absent => {
                // The credential goes with the role, before the role is reported removed: the
                // record forgets the role once told, and nothing would remove it later.
                self.forget_credential(db, name).await?;
                Ok(Step::Removed)
            }
            // The Cluster still asks for a disabled role, which CNPG would create once the
            // record has forgotten it: the Cluster drops it first.
            Held::Absent => Ok(Step::Drop),
            _ if named_absent => {
                // CNPG drops it at its own pace; objects that appeared meanwhile block it.
                if postgres::dependencies(session, name).await? > 0
                    || cannot_be_dropped(cluster, name)
                {
                    Ok(Step::Blocked)
                } else {
                    Ok(Step::Wait)
                }
            }
            // CNPG has not applied `login: false` yet.
            Held::Login => Ok(Step::Wait),
            Held::NoLogin => {
                if !postgres::end_sessions(session, name).await? {
                    return Ok(Step::Wait);
                }
                // A role with objects cannot be dropped: it stays disabled, so CNPG is never
                // left retrying a statement that fails.
                if postgres::dependencies(session, name).await? > 0 {
                    Ok(Step::Blocked)
                } else {
                    Ok(Step::Drop)
                }
            }
        }
    }
    /// Applies the Cluster with `names` entered as absent beside those it already drops.
    async fn enter_drop(
        &self,
        db: &Value,
        context: &Value,
        cluster: &Value,
        names: &[&str],
    ) -> Result<(), Error> {
        let mut context = context.clone();
        let mut dropping = cluster_drops(db, Some(cluster))
            .as_array()
            .cloned()
            .unwrap_or_default();
        dropping.extend(names.iter().map(|name| Value::from(*name)));
        context["droppingRoles"] = dropping.into();
        let manifests = manifests::build(db, &context)?;
        let desired = manifests
            .iter()
            .find(|manifest| text(manifest, "kind") == "Cluster")
            .ok_or("desired Cluster missing")?;
        self.apply(db, desired).await?;
        Ok(())
    }
    /// Deletes the role's Secret if it is there, under its UID and version like every delete.
    async fn forget_credential(&self, db: &Value, name: &str) -> Result<(), Error> {
        let ns = namespace(db);
        let secret_name = manifests::role_secret(name);
        if let Some(secret) = self.k8s.read("Secret", Some(&ns), &secret_name).await? {
            owned(&secret, db, &secret_name, Some(&ns))?;
            self.k8s.delete(&secret, "Background").await?;
        }
        Ok(())
    }
}
