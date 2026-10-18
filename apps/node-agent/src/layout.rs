// SPDX-License-Identifier: Apache-2.0
//! Where the node keeps what the agent manages (plan 5.4, 5.6 and Appendix C; the layout of
//! `infra/node-image`). `Layout::default()` is the image's; tests give another root.
use std::path::PathBuf;

/// PostgreSQL's port inside a database: the name of its socket file, `.s.PGSQL.<port>`.
pub const PORT: u16 = 5432;

#[derive(Clone, Debug)]
pub struct Layout {
    /// `/var/lib/pgcf`: the agent's state, the credentials, the volumes of the databases.
    pub state: PathBuf,
    /// `/run/pgcf`: the databases' socket directories and the agent's own.
    pub run: PathBuf,
    /// PostgreSQL's programs (`initdb`, `postgres`).
    pub postgres_bin: PathBuf,
    /// The barman-cloud commands of the jobs.
    pub barman_bin: PathBuf,
    pub systemd_run: PathBuf,
    /// The `archive_command` client of the image (plan 7.5).
    pub archive_command: String,
    /// The `restore_command` client of the image (plan 7.8).
    pub fetch_command: String,
}

impl Default for Layout {
    fn default() -> Self {
        Self {
            state: PathBuf::from("/var/lib/pgcf"),
            run: PathBuf::from("/run/pgcf"),
            postgres_bin: PathBuf::from("/usr/lib/postgresql/18/bin"),
            barman_bin: PathBuf::from("/usr/bin"),
            systemd_run: PathBuf::from("/usr/bin/systemd-run"),
            archive_command: "/usr/libexec/pgcf/pgcf-archive".into(),
            fetch_command: crate::archive::recovery::WAL_FETCH_COMMAND.into(),
        }
    }
}

impl Layout {
    /// Where the volumes are mounted: `<volumes>/<id>` (`units::DB_ROOT`).
    pub fn volumes(&self) -> PathBuf {
        self.state.join("db")
    }
    /// The mount point of a database's volume, the unit's `AssertPathIsMountPoint=`.
    pub fn volume(&self, database: &str) -> PathBuf {
        self.volumes().join(database)
    }
    /// The data directory the unit runs PostgreSQL on.
    pub fn data(&self, database: &str) -> PathBuf {
        self.volume(database).join("data")
    }
    /// The socket directory of a database (`/run/pgcf/<id>`).
    pub fn socket_directory(&self, database: &str) -> PathBuf {
        self.run.join(database)
    }
    /// What the agent keeps of its own, below the root only the agent reads.
    pub fn agent(&self) -> PathBuf {
        self.state.join("agent")
    }
    /// The binaries of the releases: `<bin>/<release>/`, and `<bin>/current` linking to the one
    /// that runs (plan 9.3).
    pub fn bin(&self) -> PathBuf {
        self.state.join("bin")
    }
    /// One database's files: its state, its upload log.
    pub fn database_files(&self, database: &str) -> PathBuf {
        self.agent().join("databases").join(database)
    }
    pub fn uids(&self) -> PathBuf {
        self.agent().join("uids.json")
    }
    pub fn fences(&self) -> PathBuf {
        self.agent().join("fences.json")
    }
    /// The directory of the agent's two sockets, which the image's unit creates.
    pub fn agent_run(&self) -> PathBuf {
        self.run.join("agent")
    }
    pub fn gateway_socket(&self) -> PathBuf {
        self.agent_run().join("gateway.sock")
    }
    pub fn archive_socket(&self) -> PathBuf {
        self.agent_run().join("archive.sock")
    }
    /// The scratch directory of the barman jobs' environment files.
    pub fn jobs(&self) -> PathBuf {
        self.agent().join("jobs")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_images_layout_is_the_default() {
        let layout = Layout::default();
        assert_eq!(layout.volumes(), PathBuf::from(crate::units::DB_ROOT));
        assert_eq!(layout.volume("a"), PathBuf::from("/var/lib/pgcf/db/a"));
        assert_eq!(layout.data("a"), PathBuf::from("/var/lib/pgcf/db/a/data"));
        assert_eq!(layout.socket_directory("a"), PathBuf::from("/run/pgcf/a"));
        assert_eq!(
            layout.gateway_socket(),
            PathBuf::from(pgcf_native_protocol::agent::GATEWAY_SOCKET)
        );
        assert_eq!(
            layout.archive_socket(),
            PathBuf::from(crate::archive::protocol::SOCKET)
        );
        // Nothing of the agent's own is below a database's volume, which its user can rearrange.
        assert!(!layout.database_files("a").starts_with(layout.volume("a")));
    }
}
