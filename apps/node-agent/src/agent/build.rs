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
    pg_control, postgres, roles,
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
/// How old the newest base backup of a database that runs may grow (plan 7.6).
const BACKUP_MAX_AGE_MS: i64 = 24 * 3_600_000;
/// How long a base backup that failed waits before it is tried again.
pub(crate) const BACKUP_RETRY_MS: i64 = 600_000;
/// How long after its own wake a database's due base backup waits, so that the first requests of a
/// cold database do not share the disk and the CPU with its backup.
pub(crate) const BACKUP_AFTER_WAKE_MS: i64 = 60_000;
/// The longest a due base backup is put off, counted from the first time it was in an awake
/// session: the same wait as after a failed one. A database whose idle sleep is put off is not put
/// to sleep, because nothing wakes a database for a backup later, and the idle pass (`idle_poll`)
/// asks again, so a database that stays idle has its backup within this wait and one pass. WAL
/// archiving goes on meanwhile, so the archive's RPO does not change; only the age of the newest
/// base backup, and with it the WAL a restore replays, grows by this much.
pub(crate) const BACKUP_PUT_OFF_MAX_MS: i64 = BACKUP_RETRY_MS;

/// What `backup_if_due` did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Backup {
    /// A base backup was taken.
    Taken,
    /// None is due, or one failed a short while ago and is not tried again yet.
    NotTaken,
    /// One is due and waits for a wake (`backup_waits`).
    PutOff,
}

/// Whether a due base backup is put off now (`backup_if_due`): the database woke less than a
/// minute ago (`awake_since_ms`), or a start is queued or in flight on the node (`wakes`), unless
/// it has been put off for the longest it may (`put_off_since_ms`: when it first was).
pub(crate) fn backup_waits(
    awake_since_ms: Option<i64>,
    wakes: usize,
    put_off_since_ms: Option<i64>,
    now_ms: i64,
) -> bool {
    if put_off_since_ms.is_some_and(|since| now_ms - since >= BACKUP_PUT_OFF_MAX_MS) {
        return false;
    }
    wakes > 0 || awake_since_ms.is_some_and(|since| now_ms - since < BACKUP_AFTER_WAKE_MS)
}

/// Whether a base backup is due (plan 7.6): there is none of the timeline the database runs on
/// (`None`: not asked), or the newest is older than a day. It is asked only of a database that
/// runs, which has written WAL since: its sleep proof writes a checkpoint at least.
pub(crate) fn backup_due(
    backup: Option<&state::Backup>,
    timeline: Option<u32>,
    now_ms: i64,
) -> bool {
    let Some(backup) = backup else {
        return true;
    };
    let completed = time::OffsetDateTime::parse(
        &backup.completed_at,
        &time::format_description::well_known::Rfc3339,
    )
    .ok()
    .and_then(|at| i64::try_from(at.unix_timestamp_nanos().div_euclid(1_000_000)).ok());
    timeline.is_some_and(|timeline| timeline != backup.timeline)
        || completed.is_none_or(|completed| now_ms - completed >= BACKUP_MAX_AGE_MS)
}

/// The system identifier of the cluster on a database's volume, as its `pg_control` shows it:
/// `None` without a readable one.
fn local_system_identifier(volume: &Path) -> Option<String> {
    let bytes = crate::proof::read_control(volume).ok()?;
    Some(pg_control::parse_control(&bytes).ok()?.system_identifier)
}

/// Whether a create may use an archive path that holds `backups`: it holds none, or every one is
/// of the cluster on the volume (`local`). A backup without an identifier, or a volume without a
/// cluster, leaves the archive refused.
fn archive_is_free_or_own(backups: &[facts::Backup], local: Option<&str>) -> bool {
    backups.is_empty()
        || local.is_some_and(|local| {
            backups
                .iter()
                .all(|backup| backup.system_identifier == local)
        })
}

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
pub(super) fn write_owned(
    dir: &Path,
    name: &str,
    content: &str,
    account: &Account,
) -> io::Result<()> {
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

    /// The base backup that is due of a database that runs (plan 7.6): before an idle sleep, and
    /// daily for an always-warm database. A database is never woken for one. It is put off, and
    /// the database is not put to sleep without it (`Backup::PutOff`), in the first minute after
    /// the database's own wake and while a start is queued or in flight on the node, so that the
    /// first requests of a cold database do not share the disk and the CPU with a backup
    /// (`backup_waits`); the next idle pass asks again, and after the longest wait the backup is
    /// taken whatever the node does. WAL archiving goes on meanwhile.
    pub(crate) async fn backup_if_due(
        &self,
        db: &Db,
        entry: &Entry,
    ) -> Result<Backup, &'static str> {
        let now = super::now_ms();
        let (held, failed, awake_since, put_off) = {
            let view = db.view();
            (
                view.state.as_ref().and_then(|state| state.backup.clone()),
                view.backup_failed_ms,
                view.awake_since_ms,
                view.backup_put_off_ms,
            )
        };
        if failed.is_some_and(|failed| now - failed < BACKUP_RETRY_MS) {
            return Ok(Backup::NotTaken);
        }
        let socket = self.layout().socket_directory(&db.id);
        let session = postgres::agent(&socket)
            .await
            .map_err(|_| "backup_failed")?;
        let identity = sleep::system(&session).await.ok_or("backup_failed")?;
        drop(session);
        let timeline = u32::try_from(identity.timeline).map_err(|_| "backup_failed")?;
        if !backup_due(held.as_ref(), Some(timeline), now) {
            if put_off.is_some() {
                self.set(db, |view| view.backup_put_off_ms = None);
            }
            return Ok(Backup::NotTaken);
        }
        let wakes = self
            .admission
            .snapshot()
            .await
            .map_or(0, |awake| awake.starting + awake.queued);
        if backup_waits(awake_since, wakes, put_off, now) {
            if put_off.is_none() {
                self.set(db, |view| view.backup_put_off_ms = Some(now));
                crate::timing::emit_event(serde_json::json!({
                    "event": "backup_put_off", "database_id": db.id,
                    "wakes_on_node": wakes,
                    "age_of_wake_ms": awake_since.map(|since| now - since),
                }));
            }
            return Ok(Backup::PutOff);
        }
        // Minutes for a large database, under the flow of a database that is served: a burst of a
        // wake does not wait behind it (plan 4.4).
        self.end_burst(db).await;
        let taken = async {
            let account = self.machine.account(&db.id).ok_or("backup_failed")?;
            let store = self
                .store(&entry.archive_path, Access::ReadWrite)
                .ok_or("archive_unusable")?;
            let volume = Self::volume_id(entry).ok_or("backup_failed")?;
            let backup = self
                .take_backup(&self.job_database(&volume, &account.name), &store, timeline)
                .await?;
            self.save_state(db, |state| state.backup = Some(backup))
                .map_err(|_| "backup_failed")
        }
        .await;
        self.set(db, |view| {
            view.backup_failed_ms = taken.is_err().then_some(now);
            view.backup_put_off_ms = None;
        });
        taken.map(|()| Backup::Taken)
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
        // Before anything is written: the record of the generation that is released stays what
        // it is until it has been, so that a build that was refused is released again.
        let built = if !self.release_previous_generation(entry).await {
            Err("build_failed")
        } else {
            match origin {
                Origin::Create => self.build_create(db, entry).await,
                Origin::Restore(source) => self.build_restored(db, entry, &source, None).await,
                Origin::Move(source, end) => {
                    self.build_restored(db, entry, &source, Some(end)).await
                }
            }
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
        let job_database = self.job_database(&volume, &account.name);
        // The archive path is the database's own and must hold nothing but backups of the cluster
        // on this volume: a generation never writes into an archive that holds something else
        // (barman overwrites without asking). The first base backup is the last step before the
        // state says built, so a build that stopped there finds its own backup and goes on.
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
        let backups = facts::parse_backup_list(&listing.stdout).map_err(|_| "archive_unusable")?;
        let local = local_system_identifier(&self.layout().volume(id));
        if !archive_is_free_or_own(&backups, local.as_deref()) {
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
        let (started, ..) = self
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
        let (account, volume) = self.provision(entry).await?;
        self.apply_limits(entry)
            .await
            .map_err(|_| build_failed!())?;
        // The restore writes the generation it builds: its device, whatever the database's link
        // names.
        let job_database = self.job_database(&volume, &account.name);
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
        // A move on the node of its source leaves the source's volume, whose files the user owns:
        // the user, and its uid, go only with the database's last volume.
        let others = core.machine.inventory().await.map(|inventory| {
            inventory
                .volumes
                .iter()
                .any(|volume| volume.id.database() == self.entry.id)
        });
        if matches!(others, Ok(false)) {
            let _ = std::fs::remove_dir_all(core.layout().socket_directory(&self.entry.id));
            let _ = core.machine.remove_account(&self.entry.id).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{agent::testing::Rig, node_link::contract_valid, pg_control};
    use pgcf_native_protocol::agent::Mode;
    use serde_json::{Value, json};
    use std::num::NonZeroU32;

    fn report(observation: Value) -> Value {
        json!({"observed_at": "2026-10-18T10:11:12.345Z", "databases": [observation], "orders": []})
    }

    #[test]
    fn a_due_base_backup_waits_for_a_wake_on_the_node_and_the_first_minute_of_its_database_but_not_for_ever()
     {
        let now = 50_000_000;
        let hours_ago = |hours: i64| Some(now - hours * 3_600_000);
        // A quiet node and a database that woke long ago, or whose wake is not known: it starts.
        assert!(!backup_waits(hours_ago(1), 0, None, now));
        assert!(!backup_waits(None, 0, None, now));
        // The database's first minute is its own: 59.999 s is inside it, 60 s is not.
        assert!(backup_waits(Some(now - 59_999), 0, None, now));
        assert!(!backup_waits(
            Some(now - BACKUP_AFTER_WAKE_MS),
            0,
            None,
            now
        ));
        // A start queued or in flight on the node, whichever database it is for.
        assert!(backup_waits(hours_ago(1), 1, None, now));
        assert!(backup_waits(hours_ago(1), 7, None, now));
        // Put off for the longest it may be, it starts whatever the node does; a moment less, not.
        let since = now - BACKUP_PUT_OFF_MAX_MS;
        assert!(!backup_waits(Some(now - 1), 3, Some(since), now));
        assert!(backup_waits(Some(now - 1), 3, Some(since + 1), now));
        assert!(!backup_waits(hours_ago(1), 0, Some(since + 1), now));
    }

    #[test]
    fn a_base_backup_is_due_without_one_of_the_timeline_or_after_a_day() {
        // 2026-10-18T10:00:00Z.
        let now = 1_792_317_600_000;
        let backup = |completed_at: &str| state::Backup {
            backup_id: "20261018T080000".into(),
            timeline: 2,
            completed_at: completed_at.into(),
        };
        let today = backup("2026-10-18T08:00:00.000Z");
        assert!(backup_due(None, Some(2), now));
        assert!(!backup_due(Some(&today), Some(2), now));
        assert!(!backup_due(Some(&today), None, now));
        assert!(backup_due(Some(&today), Some(3), now));
        assert!(!backup_due(
            Some(&backup("2026-10-17T10:00:00.001Z")),
            Some(2),
            now
        ));
        assert!(backup_due(
            Some(&backup("2026-10-17T10:00:00.000Z")),
            Some(2),
            now
        ));
        assert!(backup_due(Some(&backup("yesterday")), Some(2), now));
    }

    #[test]
    fn a_create_uses_an_archive_that_is_empty_or_holds_only_backups_of_the_cluster_on_its_volume() {
        let backup = |system_identifier: &str| facts::Backup {
            backup_id: "20261018T080000".into(),
            status: "DONE".into(),
            timeline: 1,
            system_identifier: system_identifier.into(),
            end_wal: None,
            completed_at_ms: None,
            segment_bytes: None,
        };
        assert!(archive_is_free_or_own(&[], None));
        assert!(archive_is_free_or_own(&[], Some("7697773764701949975")));
        let own = [backup("7697773764701949975"), backup("7697773764701949975")];
        assert!(archive_is_free_or_own(&own, Some("7697773764701949975")));
        // Another cluster's backup, one without an identifier, or no cluster on the volume.
        let mixed = [backup("7697773764701949975"), backup("7697781764826800331")];
        assert!(!archive_is_free_or_own(&mixed, Some("7697773764701949975")));
        assert!(!archive_is_free_or_own(
            &[backup("")],
            Some("7697773764701949975")
        ));
        assert!(!archive_is_free_or_own(&own, None));
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
        assert!(contract_valid(
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
        assert!(contract_valid(
            "NodeEventReport",
            &json!({"events": events})
        ));
        let _ = pg_control::CONTROL_FILE;
    }

    /// The node went down after the base backup was DONE and before the state file said built: the
    /// agent comes back with the unbuilt state of the generation, the cluster on the volume and the
    /// backup in the archive.
    async fn after_a_crash_before_built(rig: Rig, entry: &Entry) -> (Rig, Arc<Db>) {
        rig.core
            .files(&entry.id)
            .save(&DatabaseState::new(entry.storage_generation))
            .unwrap();
        let rig = rig.restart().await;
        rig.deliver(&entry.archive_path, "read_write");
        let db = rig.core.db(&entry.id);
        assert!(rig.core.accept(&db, entry.clone()));
        (rig, db)
    }

    fn backup_files(rig: &Rig, entry: &Entry, backup_id: &str) -> std::path::PathBuf {
        rig.fixture.store_directory().join(format!(
            "objects/{}/database/base/{backup_id}/backup.json",
            entry.archive_path.strip_prefix("s3://").unwrap()
        ))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_create_that_stopped_after_its_base_backup_resumes_over_the_backup_of_its_own_cluster()
     {
        let Some(rig) = Rig::new("create-resume").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        let first = db.state().unwrap().backup.unwrap();
        let (rig, db) = after_a_crash_before_built(rig, &entry).await;
        assert!(!db.state().is_some_and(|state| state.built));
        let _flow = db.lock.lock().await;
        rig.core.build(&db, &entry).await.unwrap();

        // The normal end state: built, a backup recorded, ready.
        let state = db.state().unwrap();
        assert!(state.built && state.record.is_none());
        let backup = state.backup.clone().unwrap();
        assert_eq!(backup.timeline, 1);
        assert_eq!(rig.observation(&entry.id)["state"], "ready");
        assert_eq!(
            rig.observation(&entry.id)["backup"]["backup_id"],
            backup.backup_id.as_str()
        );
        assert_eq!(rig.core.files(&entry.id).load().unwrap(), Some(state));
        // The one more base backup is next to the first, which nothing deleted or overwrote.
        assert_ne!(backup.backup_id, first.backup_id);
        assert!(backup_files(&rig, &entry, &backup.backup_id).exists());
        assert!(backup_files(&rig, &entry, &first.backup_id).exists());
        assert!(rig.machine.running(&entry.id));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_create_still_refuses_an_archive_with_a_backup_of_another_cluster_next_to_its_own() {
        let Some(rig) = Rig::new("create-resume-foreign").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        let first = db.state().unwrap().backup.unwrap();
        let foreign = r#"{"backup_id":"20261017T225342","status":"DONE","timeline":1,"systemid":"7697773764701949975","end_wal":"000000010000000000000003","end_time_iso":"2026-10-17T22:53:45+00:00","xlog_segment_size":16777216}"#;
        rig.fixture
            .put_backup(&entry.archive_path, "20261017T225342", foreign, None);
        let (rig, db) = after_a_crash_before_built(rig, &entry).await;
        let _flow = db.lock.lock().await;
        assert_eq!(rig.core.build(&db, &entry).await, Err("prefix_not_empty"));
        assert_eq!(rig.observation(&entry.id)["error"], "prefix_not_empty");
        // Nothing of the cluster or the archive was touched.
        assert!(
            rig.core
                .layout()
                .data(&entry.id)
                .join("PG_VERSION")
                .exists()
        );
        assert!(backup_files(&rig, &entry, &first.backup_id).exists());
        assert_eq!(
            std::fs::read_to_string(backup_files(&rig, &entry, "20261017T225342")).unwrap(),
            foreign
        );
        assert!(!db.state().is_some_and(|state| state.built));
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
