// SPDX-License-Identifier: Apache-2.0
//! The life of a database on the node (plan 5.10, 7.8, 9.5): create, restore and move target,
//! resize and delete. A build ends with the database ready, and ready means that the storage
//! generation has a DONE base backup, so that a database is never writable before it is
//! restorable.
use super::{
    Core, Db, Entry, Origin, Phase, Source,
    power::{StartAs, StartFailure, writer_of},
};
use crate::{
    Error,
    archive::{
        facts,
        job::{Job, Store},
        recovery::Restored,
        restore::{End, Failed, Host, Order, Restorer},
        server::{log_failed_job, unix_seconds},
    },
    credentials::Access,
    machine::{Account, Machine},
    postgres, roles,
    settings::{self, Settings},
    sleep,
    state::{self, DatabaseState},
    storage::{self, Removal, VolumeId},
    units::limits::{Io, Limits},
};
use sha2::{Digest, Sha256};
use std::{
    io::{self, Write},
    os::unix::fs::{OpenOptionsExt, fchown},
    path::Path,
    sync::Arc,
    time::Duration,
};

/// The files of a cluster's configuration: name and content.
type Configuration = [(&'static str, String); 3];

/// A build step that failed: the contract's error for the observation, and the step, by its place
/// in this file, for the agent's log (a failure's own text can carry an address or a path).
fn failed_at(line: u32) -> &'static str {
    crate::timing::emit_event(serde_json::json!({"event": "build_step_failed", "line": line}));
    "build_failed"
}
macro_rules! build_failed {
    () => {
        failed_at(line!())
    };
}

/// The tasks one database's unit may have (`TasksMax=` of the unit template).
const TASKS_MAX: u64 = 64;

/// What the entry sets a database's unit and volume to.
fn resources(entry: &Entry) -> state::Resources {
    state::Resources {
        memory_mib: entry.memory_mib,
        cpu_millicores: entry.cpu_millicores,
        storage_gib: entry.storage_gib,
    }
}

/// What a failed volume operation means for a build.
fn volume_error(error: &storage::Error) -> &'static str {
    match error {
        storage::Error::NoRoom(_) | storage::Error::LogicalCap { .. } => "storage_full",
        _ => "build_failed",
    }
}

/// Writes a file of the database's cluster as root, below a directory its user can rearrange:
/// whatever is there is unlinked, which follows nothing, and the file is created exclusively,
/// which fails on a link that appears in between, and handed over by its descriptor. This is done
/// only while the database's unit is stopped.
fn write_owned(dir: &Path, name: &str, content: &str, account: &Account) -> io::Result<()> {
    let path = dir.join(name);
    match std::fs::remove_file(&path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    file.write_all(content.as_bytes())?;
    fchown(&file, Some(account.uid), Some(account.gid))?;
    file.sync_all()
}

impl<M: Machine> Core<M> {
    /// The three files of the cluster's configuration (`settings`) for `entry`, and their hash.
    fn configuration(
        &self,
        entry: &Entry,
        account: &Account,
    ) -> Result<(Configuration, String), Error> {
        let socket = self.layout().socket_directory(&entry.id);
        let archive_command = self.machine.archive_command(&entry.id);
        let conf = settings::postgresql_conf(&Settings {
            socket_directory: &socket,
            memory_mib: entry.memory_mib,
            volume_bytes: entry.volume_bytes(),
            max_connections: entry.max_connections,
            archive_timeout_seconds: entry.archive_timeout_seconds,
            archive_command: Some(&archive_command),
        })
        .ok_or("the settings cannot be written")?;
        let ident = settings::pg_ident(&self.machine.agent_user(), &account.name)
            .ok_or("the users cannot be written")?;
        let files = [
            ("postgresql.conf", conf),
            ("pg_hba.conf", settings::PG_HBA.to_string()),
            ("pg_ident.conf", ident),
        ];
        let mut hash = Sha256::new();
        for (name, content) in &files {
            hash.update(name.as_bytes());
            hash.update([0]);
            hash.update(content.as_bytes());
            hash.update([0]);
        }
        let hash = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        Ok((files, hash))
    }

    /// Writes the cluster's configuration; its hash is returned. The unit must be stopped.
    pub(crate) fn write_configuration(
        &self,
        entry: &Entry,
        account: &Account,
    ) -> Result<String, Error> {
        let (files, hash) = self.configuration(entry, account)?;
        let data = self.layout().data(&entry.id);
        for (name, content) in &files {
            write_owned(&data, name, content, account)?;
        }
        crate::link::file::sync_directory(&data)?;
        Ok(hash)
    }

    /// Writes the configuration again if the database's size or settings changed since the agent
    /// wrote it: a resize applies at the next start. The unit must be stopped.
    pub(crate) async fn refresh_configuration(&self, db: &Db, entry: &Entry) -> Result<(), Error> {
        let account = self
            .machine
            .account(&db.id)
            .ok_or("the database has no account")?;
        let (_, hash) = self.configuration(entry, &account)?;
        let held = db
            .view()
            .state
            .as_ref()
            .and_then(|state| state.config.clone());
        if held.as_deref() == Some(hash.as_str()) {
            return Ok(());
        }
        let written = self.write_configuration(entry, &account)?;
        self.save_state(db, |state| state.config = Some(written))?;
        Ok(())
    }

    /// The limits of a database's unit for its size.
    fn limits(&self, entry: &Entry, volume: &VolumeId) -> Limits {
        let policy = self.policy();
        Limits {
            memory_mib: entry.memory_mib,
            cpu_millicores: entry.cpu_millicores,
            tasks_max: TASKS_MAX,
            io: Some(Io::scaled(
                self.machine.device(volume),
                policy.write_bytes_per_second,
                policy.write_iops,
                entry.memory_mib,
            )),
        }
    }

    /// Sets the unit's limits for the database's size: persistent properties, running or not.
    pub(crate) async fn apply_limits(&self, entry: &Entry) -> Result<(), Error> {
        let volume = Self::volume_id(entry).ok_or("the database has no volume")?;
        self.machine
            .set_limits(&entry.id, &self.limits(entry, &volume))
            .await?;
        Ok(())
    }

    /// Makes PostgreSQL hold the page's roles if the page changed them since they were applied.
    /// The database runs.
    pub(crate) async fn refresh_roles(&self, db: &Db, entry: &Entry) -> Result<(), &'static str> {
        let applied = db
            .view()
            .state
            .as_ref()
            .map(|state| state.roles.clone())
            .unwrap_or_default();
        if !roles::needs_apply(&entry.roles, &applied) {
            return Ok(());
        }
        let session = postgres::agent(&self.layout().socket_directory(&db.id))
            .await
            .map_err(|_| "release_failed")?;
        let report = roles::apply(&session, &entry.roles, &applied, false)
            .await
            .map_err(|_| "release_failed")?;
        self.save_state(db, |state| state.roles = report.revisions)
            .map_err(|_| "release_failed")?;
        self.set(db, |view| {
            view.roles_removed = report.removed;
            view.roles_blocked = report.blocked;
        });
        Ok(())
    }

    /// A base backup of the running database into its archive, and its newest DONE backup of the
    /// timeline it is on (plan 7.6). A backup counts only when `backup.info` says DONE.
    pub(crate) async fn take_backup(
        &self,
        database: &crate::archive::job::Database,
        store: &Store,
        timeline: u32,
    ) -> Result<state::Backup, &'static str> {
        let credential = self
            .credentials
            .get(&store.scope, unix_seconds())
            .map_err(|_| "archive_unusable")?;
        let job = Job::base_backup(store, database);
        let outcome = self
            .jobs
            .run(database, &job, &credential, None)
            .await
            .map_err(|_| build_failed!())?;
        if !outcome.succeeded() {
            log_failed_job(
                "base_backup_failed",
                &database.id,
                "backup",
                &outcome,
                &credential,
            );
            return Err("build_failed");
        }
        let listing = self
            .jobs
            .run(database, &Job::backup_list(store), &credential, None)
            .await
            .map_err(|_| build_failed!())?;
        let backups = listing
            .succeeded()
            .then(|| facts::parse_backup_list(&listing.stdout).ok())
            .flatten()
            .ok_or_else(|| build_failed!())?;
        facts::newest_done(&backups)
            .filter(|backup| backup.timeline == timeline)
            .and_then(|backup| {
                Some(state::Backup {
                    backup_id: backup.backup_id.clone(),
                    timeline,
                    completed_at: facts::timestamp(backup.completed_at_ms?),
                })
            })
            .ok_or_else(|| build_failed!())
    }

    /// Builds the storage generation `entry.origin` names. Ready follows only the first base
    /// backup. The error is the node contract's.
    pub(crate) async fn build(
        self: &Arc<Self>,
        db: &Arc<Db>,
        entry: &Entry,
    ) -> Result<(), &'static str> {
        let origin = entry.origin.clone().ok_or_else(|| build_failed!())?;
        self.set(db, |view| {
            view.phase = Phase::Building;
            view.error = None;
            view.writer = None;
            view.adopted = true;
        });
        let built = match origin {
            Origin::Create => self.build_create(db, entry).await,
            Origin::Restore(source) => self.build_restored(db, entry, &source, None).await,
            Origin::Move(source, end) => self.build_restored(db, entry, &source, Some(end)).await,
        };
        match built {
            Ok(()) => Ok(()),
            Err(error) => {
                crate::timing::emit_event(serde_json::json!({
                    "event": "build_failed", "database_id": db.id,
                    "operation": entry.operation, "error": error,
                }));
                self.set(db, |view| {
                    view.phase = Phase::Error;
                    view.error = Some(error);
                });
                Err(error)
            }
        }
    }

    /// The state file of a build that begins: a new generation, or the one a crash left behind.
    fn begin_state(&self, db: &Db, entry: &Entry) -> Result<(), &'static str> {
        let held = self.files(&db.id).load().map_err(|_| build_failed!())?;
        let state = held
            .filter(|state| state.storage_generation == entry.storage_generation)
            .unwrap_or_else(|| DatabaseState::new(entry.storage_generation));
        self.files(&db.id)
            .save(&state)
            .map_err(|_| build_failed!())?;
        self.set(db, |view| view.state = Some(state));
        Ok(())
    }

    /// Creates the user, the volume and its directories: the same for every origin.
    async fn provision(&self, entry: &Entry) -> Result<(Account, VolumeId), &'static str> {
        let id = &entry.id;
        let volume = Self::volume_id(entry).ok_or_else(|| build_failed!())?;
        let account = self
            .machine
            .ensure_account(id)
            .await
            .map_err(|_| build_failed!())?;
        self.machine
            .create_volume(
                &volume,
                entry.volume_bytes(),
                &account,
                &self.policy().storage,
            )
            .await
            .map_err(|error| volume_error(&error))?;
        self.machine
            .prepare_socket_directory(id, &account)
            .map_err(|_| build_failed!())?;
        Ok((account, volume))
    }

    async fn build_create(
        self: &Arc<Self>,
        db: &Arc<Db>,
        entry: &Entry,
    ) -> Result<(), &'static str> {
        let id = &entry.id;
        let store = self
            .store(&entry.archive_path, Access::ReadWrite)
            .ok_or("archive_unusable")?;
        self.begin_state(db, entry)?;
        let (account, volume) = self.provision(entry).await?;
        let job_database = self.job_database(id, &account.name);
        // The archive path is the database's own and must be empty: a generation never writes
        // into an archive that holds something (barman overwrites without asking).
        let credential = self
            .credentials
            .get(&store.scope, unix_seconds())
            .map_err(|_| "archive_unusable")?;
        let listing = self
            .jobs
            .run(&job_database, &Job::backup_list(&store), &credential, None)
            .await
            .map_err(|_| "archive_unusable")?;
        if !listing.succeeded() {
            return Err("archive_unusable");
        }
        if !facts::parse_backup_list(&listing.stdout)
            .map_err(|_| "archive_unusable")?
            .is_empty()
        {
            return Err("prefix_not_empty");
        }
        // The cluster. A data directory a crash left half made is made again: no client has been
        // near it.
        let data = self.layout().data(id);
        if !data.join("PG_VERSION").exists() {
            match std::fs::remove_dir_all(&data) {
                Err(error) if error.kind() != io::ErrorKind::NotFound => {
                    return Err("build_failed");
                }
                _ => {}
            }
            self.machine
                .initdb(&account, &data)
                .await
                .map_err(|_| build_failed!())?;
        }
        let config = self
            .write_configuration(entry, &account)
            .map_err(|_| build_failed!())?;
        self.save_state(db, |state| state.config = Some(config))
            .map_err(|_| build_failed!())?;
        self.apply_limits(entry)
            .await
            .map_err(|_| build_failed!())?;
        self.ensure_archive(db, entry);
        let (started, _) = self
            .start_unit(
                db,
                entry,
                StartAs {
                    kind: "create",
                    generation: entry.generation,
                    operation: Some(&entry.operation),
                },
                None,
            )
            .await
            .map_err(|failure| match failure {
                StartFailure::Refused(_) => "storage_full",
                _ => "start_failed",
            })?;
        // The roles, the backup role and the database of the tenant.
        let session = postgres::agent(&self.layout().socket_directory(id))
            .await
            .map_err(|_| build_failed!())?;
        roles::ensure_backup_role(&session)
            .await
            .map_err(|_| build_failed!())?;
        let applied = roles::apply(&session, &entry.roles, &Default::default(), false)
            .await
            .map_err(|_| build_failed!())?;
        roles::ensure_database(&session, id, roles::OWNER_ROLE)
            .await
            .map_err(|_| build_failed!())?;
        let identity = sleep::system(&session)
            .await
            .ok_or_else(|| build_failed!())?;
        drop(session);
        let timeline = u32::try_from(identity.timeline).map_err(|_| build_failed!())?;
        // Ready only when the first base backup is DONE.
        let backup = self.take_backup(&job_database, &store, timeline).await?;
        self.save_state(db, |state| {
            state.built = true;
            state.roles = applied.revisions;
            state.backup = Some(backup);
            state.record = None;
            state.resources = Some(resources(entry));
        })
        .map_err(|_| build_failed!())?;
        let writer = writer_of(&started).ok_or_else(|| build_failed!())?;
        self.set(db, |view| {
            view.phase = Phase::Ready;
            view.writer = Some(writer);
            view.awake_since_ms = Some(super::now_ms());
            view.roles_removed = applied.removed;
            view.roles_blocked = applied.blocked;
        });
        let _ = volume;
        self.after_ready(db).await;
        Ok(())
    }

    /// A restore, a point-in-time restore or a move target (plan 7.8, 9.5): the executor of the
    /// archive module over this database's unit and connection.
    async fn build_restored(
        self: &Arc<Self>,
        db: &Arc<Db>,
        entry: &Entry,
        source: &Source,
        end: Option<End>,
    ) -> Result<(), &'static str> {
        let id = &entry.id;
        let store = self
            .store(&entry.archive_path, Access::ReadWrite)
            .ok_or("archive_unusable")?;
        let from = self
            .store(&source.path, Access::ReadOnly)
            .ok_or("archive_unusable")?;
        self.begin_state(db, entry)?;
        let (account, _volume) = self.provision(entry).await?;
        self.apply_limits(entry)
            .await
            .map_err(|_| build_failed!())?;
        let job_database = self.job_database(id, &account.name);
        let upload_log = self.files(id).upload_log(entry.storage_generation);
        let host = Rebuild {
            core: self.clone(),
            db: db.clone(),
            entry: entry.clone(),
            account: account.clone(),
            source_database: source.database_id.clone(),
            started: std::sync::Mutex::new(None),
            applied: std::sync::Mutex::new(None),
        };
        let restorer = Restorer {
            table: &self.table,
            jobs: &self.jobs,
            credentials: &self.credentials,
            fetch_command: &self.layout().fetch_command,
        };
        let order = Order {
            database: &job_database,
            uid: account.uid,
            gid: account.gid,
            source: &from,
            backup_id: &source.backup_id,
            target_time: source.target_time.as_deref(),
            end: end.as_ref(),
            store: &store,
            upload_log: &upload_log,
            operation: &entry.operation,
        };
        let backup = match restorer.run(&order, &host).await {
            Ok(backup) => backup,
            Err(error) => {
                // The executor abandoned the build: stopped, volume and user gone.
                self.files(id).remove().ok();
                return Err(error);
            }
        };
        let completed = backup
            .completed_at_ms
            .map(facts::timestamp)
            .ok_or_else(|| build_failed!())?;
        let applied = host
            .applied
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
            .ok_or_else(|| build_failed!())?;
        self.save_state(db, |state| {
            state.built = true;
            state.roles = applied.revisions;
            state.resources = Some(resources(entry));
            state.backup = Some(state::Backup {
                backup_id: backup.backup_id.clone(),
                timeline: backup.timeline,
                completed_at: completed,
            });
            state.record = None;
        })
        .map_err(|_| build_failed!())?;
        let started = host
            .started
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
            .ok_or_else(|| build_failed!())?;
        let writer = writer_of(&started).ok_or_else(|| build_failed!())?;
        self.set(db, |view| {
            view.phase = Phase::Ready;
            view.writer = Some(writer);
            view.awake_since_ms = Some(super::now_ms());
        });
        self.after_ready(db).await;
        Ok(())
    }
}

/// The restore executor's view of the database being built.
struct Rebuild<M: Machine> {
    core: Arc<Core<M>>,
    db: Arc<Db>,
    entry: Entry,
    account: Account,
    /// The database name inside the restored cluster: the source's ID.
    source_database: String,
    started: std::sync::Mutex<Option<crate::units::Started>>,
    /// The roles as applied to the promoted database.
    applied: std::sync::Mutex<Option<roles::Report>>,
}
impl<M: Machine> Rebuild<M> {
    fn kind(&self) -> &'static str {
        if matches!(self.entry.origin, Some(Origin::Move(..))) {
            "move"
        } else {
            "restore"
        }
    }
}
impl<M: Machine> Host for Rebuild<M> {
    async fn start(&self) -> Result<(), Failed> {
        let core = &self.core;
        // The restored files are the source's: the agent's own replace them before the start.
        core.write_configuration(&self.entry, &self.account)
            .map_err(|_| Failed)?;
        let started = core
            .start_unit(
                &self.db,
                &self.entry,
                StartAs {
                    kind: self.kind(),
                    generation: self.entry.generation,
                    operation: Some(&self.entry.operation),
                },
                None,
            )
            .await
            .map_err(|_| Failed)?;
        *self
            .started
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(started.0);
        Ok(())
    }

    async fn promoted(&self) -> Result<Restored, Failed> {
        let core = &self.core;
        let socket = core.layout().socket_directory(&self.entry.id);
        let session = postgres::agent(&socket).await.map_err(|_| Failed)?;
        loop {
            let rows = session
                .query("SELECT pg_catalog.pg_is_in_recovery()", &[])
                .await
                .map_err(|_| Failed)?;
            if !rows[0].try_get::<_, bool>(0).map_err(|_| Failed)? {
                break;
            }
            // The unit may have ended: a recovery that died is not promoted.
            if core
                .machine
                .unit(&self.entry.id)
                .await
                .map_or(true, |unit| !unit.active.awake())
            {
                return Err(Failed);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // The database is the new database's before its first backup: its name, its roles.
        if self.source_database != self.entry.id {
            session
                .batch(&format!(
                    "ALTER DATABASE \"{}\" RENAME TO \"{}\"",
                    self.source_database, self.entry.id
                ))
                .await
                .map_err(|_| Failed)?;
        }
        let applied = roles::apply(&session, &self.entry.roles, &Default::default(), true)
            .await
            .map_err(|_| Failed)?;
        *self
            .applied
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(applied);
        // The timeline of the promotion is in the control file once its checkpoint is done.
        session.batch_long("CHECKPOINT").await.map_err(|_| Failed)?;
        let identity = sleep::system(&session).await.ok_or(Failed)?;
        Ok(Restored {
            in_recovery: false,
            system_identifier: identity.identifier,
            timeline: u32::try_from(identity.timeline).map_err(|_| Failed)?,
        })
    }

    async fn abandon(&self) {
        let core = &self.core;
        let _ = core.machine.stop(&self.entry.id).await;
        core.admission.stopped(&self.entry.id);
        if let Some(volume) = Core::<M>::volume_id(&self.entry) {
            let _ = core
                .machine
                .remove_volume(
                    &volume,
                    Removal::DatabaseDeleted {
                        storage_generation: self.entry.storage_generation,
                    },
                )
                .await;
        }
        let _ = std::fs::remove_dir_all(core.layout().socket_directory(&self.entry.id));
        let _ = core.machine.remove_account(&self.entry.id).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{agent::testing::Rig, node_link::schema_valid, pg_control};
    use pgcf_native_protocol::agent::Mode;
    use serde_json::{Value, json};
    use std::num::NonZeroU32;

    fn report(observation: Value) -> Value {
        json!({"observed_at": "2026-10-18T10:11:12.345Z", "databases": [observation], "orders": []})
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_database_is_created_and_ready_only_with_its_first_base_backup() {
        let Some(rig) = Rig::new("create").await else {
            return;
        };
        let entry = rig.entry();
        let db = rig.core.db(&entry.id);
        assert!(rig.core.accept(&db, entry.clone()));
        let _flow = db.lock.lock().await;
        rig.core.build(&db, &entry).await.unwrap();

        // The volume, the user, the cluster and its configuration are the agent's.
        let layout = rig.machine.layout();
        assert!(rig.machine.has_account(&entry.id));
        assert_eq!(rig.machine.volumes().len(), 1);
        assert!(layout.data(&entry.id).join("PG_VERSION").exists());
        let conf = std::fs::read_to_string(layout.data(&entry.id).join("postgresql.conf")).unwrap();
        assert!(conf.contains("max_connections = 25") && conf.contains("archive_mode = on"));
        assert!(rig.machine.running(&entry.id));
        // The limits of its size are set, and the CPU quota of its size follows ready.
        let limits = rig.machine.limits(&entry.id).unwrap();
        assert_eq!((limits.memory_mib, limits.cpu_millicores), (256, 250));
        assert_eq!(rig.machine.quota(&entry.id), Some(NonZeroU32::new(250)));

        // PostgreSQL holds the page's roles, the backup role and the tenant's database.
        let agent = rig.agent(&entry.id).await;
        let owner = agent
            .query(
                "SELECT pg_catalog.pg_get_userbyid(datdba)::text FROM pg_database WHERE datname = $1",
                &[&entry.id],
            )
            .await
            .unwrap();
        assert_eq!(owner[0].get::<_, String>(0), "app");
        let roles = agent
            .query(
                "SELECT rolname::text FROM pg_roles WHERE rolcanlogin ORDER BY 1",
                &[],
            )
            .await
            .unwrap();
        let roles: Vec<String> = roles.iter().map(|r| r.get(0)).collect();
        assert_eq!(roles, ["app", "pgcf_backup", "postgres", "reader"]);

        // The first base backup is DONE, in the database's own archive, and the state says so.
        let state = db.state().unwrap();
        assert!(state.built && state.record.is_none());
        let backup = state.backup.clone().unwrap();
        assert_eq!(backup.timeline, 1);
        assert!(
            rig.fixture
                .store_directory()
                .join(format!(
                    "objects/{}/database/base/{}/backup.json",
                    entry.archive_path.strip_prefix("s3://").unwrap(),
                    backup.backup_id
                ))
                .exists()
        );
        assert_eq!(
            state.roles,
            [("app".to_string(), 1), ("reader".to_string(), 2)].into()
        );
        assert_eq!(rig.core.files(&entry.id).load().unwrap(), Some(state));

        // The gateway has the writer, with the unit's uid, main PID and invocation.
        let table = rig.gateway.get(&entry.id).unwrap();
        assert_eq!(table.mode, Mode::Running);
        let writer = table.writer.unwrap();
        assert!(
            writer
                .socket
                .ends_with(&format!("{}/.s.PGSQL.5432", entry.id))
        );
        assert!(writer.valid());
        // Admission knows it as awake, and it is not starting any more.
        let awake = rig.core.admission.snapshot().await.unwrap();
        assert_eq!((awake.awake, awake.starting), (vec![entry.id.clone()], 0));
        // The archive socket knows the database (its failing run has not begun).
        assert_eq!(rig.table.failing_since_ms(&entry.id), None);

        // What Cloudflare is told is what the contract states, and says ready with the backup.
        let observation = rig.observation(&entry.id);
        assert!(schema_valid(
            "NodeObservationReport",
            &report(observation.clone())
        ));
        assert_eq!(observation["state"], "ready");
        assert_eq!(
            observation["backup"]["backup_id"],
            backup.backup_id.as_str()
        );
        assert_eq!(observation["proven_sleep"], Value::Null);
        assert_eq!(observation["generation"], entry.generation);
        // The admission is an event of the node.
        let events = rig.core.take_events();
        assert!(events.iter().any(|e| e["type"] == "admission"
            && e["start"] == "create"
            && e["decision"] == "admitted"));
        assert!(schema_valid("NodeEventReport", &json!({"events": events})));
        let _ = pg_control::CONTROL_FILE;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_build_without_room_or_into_a_used_archive_fails_before_it_writes_a_cluster() {
        let Some(rig) = Rig::new("create-refused").await else {
            return;
        };
        // No room: the pool is at its reserve.
        let entry = rig.entry();
        let db = rig.core.db(&entry.id);
        rig.core.accept(&db, entry.clone());
        rig.machine.set_no_room(true);
        {
            let _flow = db.lock.lock().await;
            assert_eq!(rig.core.build(&db, &entry).await, Err("storage_full"));
        }
        assert_eq!(rig.observation(&entry.id)["error"], "storage_full");
        assert_eq!(rig.observation(&entry.id)["state"], "error");
        assert!(!rig.machine.running(&entry.id));
        rig.machine.set_no_room(false);

        // An archive path that holds a backup is not a new database's.
        let entry = rig.entry();
        let db = rig.core.db(&entry.id);
        rig.core.accept(&db, entry.clone());
        rig.fixture.put_backup(
            &entry.archive_path,
            "20261017T225342",
            r#"{"backup_id":"20261017T225342","status":"DONE","timeline":1,"systemid":"7697773764701949975","end_wal":"000000010000000000000003","end_time_iso":"2026-10-17T22:53:45+00:00","xlog_segment_size":16777216}"#,
            None,
        );
        let _flow = db.lock.lock().await;
        assert_eq!(rig.core.build(&db, &entry).await, Err("prefix_not_empty"));
        assert!(
            !rig.core
                .layout()
                .data(&entry.id)
                .join("PG_VERSION")
                .exists()
        );

        // A start that fails is a failed build, and a build is tried again from where it stopped.
        let entry = rig.entry();
        let db = rig.core.db(&entry.id);
        rig.core.accept(&db, entry.clone());
        rig.machine.fail_next_start();
        assert_eq!(rig.core.build(&db, &entry).await, Err("start_failed"));
        assert_eq!(rig.observation(&entry.id)["error"], "start_failed");
        rig.core.build(&db, &entry).await.unwrap();
        assert_eq!(rig.observation(&entry.id)["state"], "ready");
        assert_eq!(
            rig.machine.volumes().len(),
            2,
            "one volume per database, not per attempt"
        );
    }
}
