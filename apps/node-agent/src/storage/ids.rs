// SPDX-License-Identifier: Apache-2.0
//! The names of a database's volume: LV name, tags and device-mapper name.
use super::Error;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const TAG_DATABASE: &str = "pgcf.db.";
const TAG_GENERATION: &str = "pgcf.gen.";

/// `^[a-z][a-z0-9]{19}$` (contracts `DatabaseId`).
pub fn database_id_valid(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 20
        && bytes[0].is_ascii_lowercase()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// One storage generation of one database: a restore or a move builds the next one.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct VolumeId {
    database: String,
    generation: u64,
}

impl VolumeId {
    pub fn new(database: &str, generation: u64) -> Result<Self, Error> {
        if !database_id_valid(database) {
            return Err(Error::InvalidId("database id"));
        }
        if !(1..=MAX_SAFE_INTEGER).contains(&generation) {
            return Err(Error::InvalidId("storage generation"));
        }
        Ok(Self {
            database: database.to_string(),
            generation,
        })
    }
    pub fn database(&self) -> &str {
        &self.database
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    /// `db_<id>_g<generation>`: one name per generation, so a retried create finds its volume.
    pub fn lv_name(&self) -> String {
        format!("db_{}_g{}", self.database, self.generation)
    }
    pub fn from_lv_name(name: &str) -> Option<Self> {
        let (database, generation) = name.strip_prefix("db_")?.split_once("_g")?;
        let canonical =
            generation.bytes().all(|b| b.is_ascii_digit()) && !generation.starts_with('0');
        if !canonical {
            return None;
        }
        Self::new(database, generation.parse().ok()?).ok()
    }
    /// `pgcf.db.<id>` and `pgcf.gen.<generation>`.
    pub fn tags(&self) -> [String; 2] {
        [
            format!("{TAG_DATABASE}{}", self.database),
            format!("{TAG_GENERATION}{}", self.generation),
        ]
    }
}

/// The device-mapper name of an LV: group and volume joined by `-`, every `-` in them doubled.
pub fn dm_name(group: &str, volume: &str) -> String {
    format!("{}-{}", group.replace('-', "--"), volume.replace('-', "--"))
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "a1b2c3d4e5f6g7h8i9j0";

    #[test]
    fn a_volume_id_needs_a_database_id_and_a_generation_from_one() {
        assert!(VolumeId::new(ID, 1).is_ok());
        assert!(VolumeId::new(ID, 9_007_199_254_740_991).is_ok());
        for bad in [
            "",
            "A1b2c3d4e5f6g7h8i9j0",
            "1a2b3c4d5e6f7g8h9i0j",
            "a1b2c3d4e5f6g7h8i9j",
            "a1b2c3d4e5f6g7h8i9j01",
            "a1b2c3d4e5f6g7h8i9j-",
            "a1b2c3d4e5f6g7h8i9/0",
            "../etc/passwd/x/y/z",
        ] {
            assert!(VolumeId::new(bad, 1).is_err(), "{bad}");
        }
        assert!(VolumeId::new(ID, 0).is_err());
        assert!(VolumeId::new(ID, 9_007_199_254_740_992).is_err());
    }

    #[test]
    fn the_lv_name_and_tags_follow_from_the_id_and_the_name_reads_back() {
        let id = VolumeId::new(ID, 12).unwrap();
        assert_eq!(id.lv_name(), "db_a1b2c3d4e5f6g7h8i9j0_g12");
        assert_eq!(
            id.tags(),
            ["pgcf.db.a1b2c3d4e5f6g7h8i9j0", "pgcf.gen.12"].map(String::from)
        );
        assert_eq!(VolumeId::from_lv_name(&id.lv_name()), Some(id));
        for foreign in [
            "pgcf_thinpool",
            "stranger",
            "db_a1b2c3d4e5f6g7h8i9j0_g0",
            "db_a1b2c3d4e5f6g7h8i9j0_g01",
            "db_a1b2c3d4e5f6g7h8i9j0_g",
            "db_a1b2c3d4e5f6g7h8i9j0",
            "db_short_g1",
        ] {
            assert_eq!(VolumeId::from_lv_name(foreign), None, "{foreign}");
        }
    }

    #[test]
    fn the_device_mapper_name_doubles_every_dash() {
        assert_eq!(dm_name("pgcf", "pgcf_thinpool"), "pgcf-pgcf_thinpool");
        assert_eq!(dm_name("pg-cf", "db-a"), "pg--cf-db--a");
    }
}
