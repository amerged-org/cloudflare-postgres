// SPDX-License-Identifier: Apache-2.0
//! lvm2's JSON reports, and the decisions of first boot over them (ported from the Kubernetes-era
//! `thin-storage.ts` pool initialization, without growth and without an anchor volume).
use super::{CHUNK_BYTES, Config, Error};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VolumeGroup {
    pub name: String,
    pub size_bytes: u64,
    pub free_bytes: u64,
    pub extent_bytes: u64,
    pub writable: bool,
    pub missing_pvs: u64,
    pub pvs: u64,
    pub mda_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PhysicalVolume {
    pub name: String,
    /// Empty for a physical volume in no group.
    pub group: String,
    pub mda_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogicalVolume {
    pub name: String,
    pub size_bytes: u64,
    pub attr: String,
    pub pool: String,
    pub chunk_bytes: u64,
    pub metadata_bytes: u64,
    pub when_full: String,
    pub zero: String,
    pub tags: Vec<String>,
}

impl LogicalVolume {
    pub fn is_pool(&self) -> bool {
        self.attr.starts_with('t')
    }
    pub fn is_thin(&self) -> bool {
        self.attr.starts_with('V')
    }
    /// Something has the volume's device open: the filesystem is mounted, in any mount namespace
    /// (the agent's, a unit's, a job's), or a process has opened the device. It is the sixth
    /// character of `lv_attr`, which lvm2 reads from the device-mapper open count.
    pub fn is_open(&self) -> bool {
        self.attr.as_bytes().get(5) == Some(&b'o')
    }
    pub fn has_tag(&self, tag: &str) -> bool {
        self.tags.iter().any(|t| t == tag)
    }
}

/// The rows of one report: `{"report":[{"<key>":[{...}, ...]}]}`.
fn rows(json: &str, key: &str) -> Result<Vec<Value>, Error> {
    let value: Value = serde_json::from_str(json).map_err(|_| Error::Parse("lvm report"))?;
    match value["report"].as_array().map(Vec::as_slice) {
        Some([report]) => report[key]
            .as_array()
            .cloned()
            .ok_or(Error::Parse("lvm report")),
        _ => Err(Error::Parse("lvm report")),
    }
}
fn text<'a>(row: &'a Value, field: &str) -> Result<&'a str, Error> {
    row[field].as_str().ok_or(Error::Parse("lvm field"))
}
/// lvm2 writes numbers as strings, in bytes with `--units b --nosuffix`.
fn number(row: &Value, field: &str) -> Result<u64, Error> {
    text(row, field)?
        .parse()
        .map_err(|_| Error::Parse("lvm number"))
}
/// A number that lvm2 leaves empty where it does not apply.
fn number_or_zero(row: &Value, field: &str) -> Result<u64, Error> {
    match text(row, field)? {
        "" => Ok(0),
        _ => number(row, field),
    }
}

pub fn parse_vgs(json: &str) -> Result<Vec<VolumeGroup>, Error> {
    rows(json, "vg")?
        .iter()
        .map(|row| {
            Ok(VolumeGroup {
                name: text(row, "vg_name")?.to_string(),
                size_bytes: number(row, "vg_size")?,
                free_bytes: number(row, "vg_free")?,
                extent_bytes: number(row, "vg_extent_size")?,
                writable: text(row, "vg_permissions")? == "writeable",
                missing_pvs: number(row, "vg_missing_pv_count")?,
                pvs: number(row, "pv_count")?,
                mda_bytes: number(row, "vg_mda_size")?,
            })
        })
        .collect()
}
pub fn parse_pvs(json: &str) -> Result<Vec<PhysicalVolume>, Error> {
    rows(json, "pv")?
        .iter()
        .map(|row| {
            Ok(PhysicalVolume {
                name: text(row, "pv_name")?.to_string(),
                group: text(row, "vg_name")?.to_string(),
                mda_bytes: number(row, "pv_mda_size")?,
            })
        })
        .collect()
}
pub fn parse_lvs(json: &str) -> Result<Vec<LogicalVolume>, Error> {
    rows(json, "lv")?
        .iter()
        .map(|row| {
            Ok(LogicalVolume {
                name: text(row, "lv_name")?.to_string(),
                size_bytes: number(row, "lv_size")?,
                attr: text(row, "lv_attr")?.to_string(),
                pool: text(row, "pool_lv")?.to_string(),
                chunk_bytes: number(row, "chunk_size")?,
                metadata_bytes: number_or_zero(row, "lv_metadata_size")?,
                when_full: text(row, "lv_when_full")?.to_string(),
                zero: text(row, "zero")?.to_string(),
                tags: text(row, "lv_tags")?
                    .split(',')
                    .filter(|tag| !tag.is_empty())
                    .map(String::from)
                    .collect(),
            })
        })
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
pub enum GroupStep {
    CreatePhysicalVolume,
    CreateGroup,
}
/// What first boot still has to do to have the volume group on the device. `device` is the
/// physical volume lvm2 lists for the configured device, if any. A group or disk that is not
/// what first boot makes is an error: the metadata area cannot be grown in place (Stage 1), and
/// the agent never adopts or wipes what it did not make.
pub fn plan_group(
    config: &Config,
    device: Option<&PhysicalVolume>,
    groups: &[VolumeGroup],
) -> Result<Vec<GroupStep>, Error> {
    let group = groups.iter().find(|group| group.name == config.group);
    if let Some(pv) = device
        && pv.mda_bytes < config.pv_metadata_bytes
    {
        return Err(Error::Unexpected("the physical volume's metadata area"));
    }
    match (device, group) {
        (None, None) => Ok(vec![
            GroupStep::CreatePhysicalVolume,
            GroupStep::CreateGroup,
        ]),
        (Some(pv), None) if pv.group.is_empty() => Ok(vec![GroupStep::CreateGroup]),
        (Some(_), None) => Err(Error::Unexpected("the device is in another volume group")),
        (None, Some(_)) => Err(Error::Unexpected("the volume group is not on the device")),
        (Some(pv), Some(group)) => {
            if pv.group != group.name || group.pvs != 1 || group.missing_pvs != 0 {
                return Err(Error::Unexpected("the volume group's physical volumes"));
            }
            if !group.writable {
                return Err(Error::Unexpected("the volume group is read-only"));
            }
            Ok(vec![])
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PoolStep {
    Create { data_bytes: u64 },
    ErrorWhenFull,
}
/// What first boot still has to do to have the pool: create it over every free extent but the
/// metadata and its spare, then make a full pool fail writes at once. The two steps are separate
/// commands, so a first boot that stopped between them finds the pool and finishes. The pool is
/// never grown or recreated: a pool that differs from what first boot makes is an error.
pub fn plan_pool(
    config: &Config,
    group: &VolumeGroup,
    lvs: &[LogicalVolume],
) -> Result<Vec<PoolStep>, Error> {
    let extent = group.extent_bytes.max(1);
    let metadata = config.pool_metadata_bytes.div_ceil(extent) * extent;
    let Some(pool) = lvs.iter().find(|lv| lv.name == config.pool) else {
        if !lvs.is_empty() {
            return Err(Error::Unexpected("volumes without the pool"));
        }
        // The pool's metadata and an equal spare for `thin_repair` come out of the same group.
        let data = group.free_bytes.saturating_sub(2 * metadata) / extent * extent;
        if data == 0 {
            return Err(Error::TooSmall);
        }
        return Ok(vec![
            PoolStep::Create { data_bytes: data },
            PoolStep::ErrorWhenFull,
        ]);
    };
    if !pool.is_pool()
        || pool.chunk_bytes != CHUNK_BYTES
        || pool.zero != "zero"
        || pool.metadata_bytes != metadata
    {
        return Err(Error::Unexpected("the thin pool"));
    }
    Ok(if pool.when_full == "error" {
        vec![]
    } else {
        vec![PoolStep::ErrorWhenFull]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const VGS_EMPTY: &str = include_str!("fixtures/vgs-empty.json");
    const VGS_POOL: &str = include_str!("fixtures/vgs-pool.json");
    const PVS: &str = include_str!("fixtures/pvs-in-vg.json");
    const LVS_NONE: &str = include_str!("fixtures/lvs-none.json");
    const LVS_QUEUE: &str = include_str!("fixtures/lvs-pool-queue.json");
    const LVS_VOLUMES: &str = include_str!("fixtures/lvs-volumes.json");

    /// The fixtures were written by lvm2 2.03.31 on a pool with 8 MiB of metadata.
    fn config() -> Config {
        Config {
            device: "/dev/loop0".into(),
            pool_metadata_bytes: 8 << 20,
            ..Config::default()
        }
    }
    fn group() -> VolumeGroup {
        parse_vgs(VGS_EMPTY).unwrap().remove(0)
    }
    fn device() -> PhysicalVolume {
        parse_pvs(PVS).unwrap().remove(0)
    }

    /// The sixth character of `lv_attr` is `o` while something has the device open, as lvm2
    /// wrote it for a thin volume that a mount holds (lab).
    #[test]
    fn a_volume_is_open_when_lvm2_says_o_in_the_sixth_place_of_its_attributes() {
        let mut volume = parse_lvs(LVS_VOLUMES).unwrap().remove(0);
        assert_eq!(volume.attr, "Vwi-a-tz--");
        assert!(!volume.is_open());
        volume.attr = "Vwi-aotz--".into();
        assert!(volume.is_open());
        volume.attr = "Vwi".into();
        assert!(!volume.is_open());
    }

    #[test]
    fn reports_read_as_lvm2_wrote_them() {
        assert_eq!(
            parse_vgs(VGS_POOL).unwrap(),
            vec![VolumeGroup {
                name: "pgcf".into(),
                size_bytes: 1_002_438_656,
                free_bytes: 448_790_528,
                extent_bytes: 4_194_304,
                writable: true,
                missing_pvs: 0,
                pvs: 1,
                mda_bytes: 68_153_344,
            }]
        );
        assert_eq!(
            parse_pvs(PVS).unwrap(),
            vec![PhysicalVolume {
                name: "/dev/loop0".into(),
                group: "pgcf".into(),
                mda_bytes: 68_153_344,
            }]
        );
        assert_eq!(parse_lvs(LVS_NONE).unwrap(), vec![]);
        let lvs = parse_lvs(LVS_VOLUMES).unwrap();
        assert_eq!(lvs.len(), 4);
        let pool = lvs.iter().find(|lv| lv.name == "pgcf_thinpool").unwrap();
        assert!(pool.is_pool() && !pool.is_thin());
        assert_eq!(
            (pool.size_bytes, pool.chunk_bytes, pool.metadata_bytes),
            (536_870_912, 65_536, 8_388_608)
        );
        assert_eq!(
            (pool.when_full.as_str(), pool.zero.as_str()),
            ("error", "zero")
        );
        let volume = &lvs[0];
        assert!(volume.is_thin() && !volume.is_pool());
        assert_eq!(volume.name, "db_a1b2c3d4e5f6g7h8i9j0_g1");
        assert_eq!(volume.pool, "pgcf_thinpool");
        assert_eq!(volume.size_bytes, 134_217_728);
        assert!(volume.has_tag("pgcf.fs") && volume.has_tag("pgcf.gen.1"));
        assert!(!lvs[1].has_tag("pgcf.fs"));
        assert!(lvs[3].tags.is_empty());
    }

    #[test]
    fn a_report_that_is_not_lvm2s_is_an_error() {
        for bad in [
            "",
            "{}",
            r#"{"report":[]}"#,
            r#"{"report":[{"vg":[{"vg_name":"pgcf"}]}]}"#,
            r#"{"report":[{"vg":[{"vg_name":"pgcf","vg_uuid":"x","vg_size":"-1","vg_free":"0","vg_extent_size":"1","vg_permissions":"writeable","vg_missing_pv_count":"0","pv_count":"1","vg_mda_size":"1"}]}]}"#,
        ] {
            assert!(parse_vgs(bad).is_err(), "{bad}");
        }
        assert!(parse_lvs(r#"{"report":[{"lv":[{"lv_name":"x"}]}]}"#).is_err());
        assert!(parse_pvs("not json").is_err());
    }

    #[test]
    fn a_blank_disk_gets_a_physical_volume_and_a_group() {
        assert_eq!(
            plan_group(&config(), None, &[]).unwrap(),
            vec![GroupStep::CreatePhysicalVolume, GroupStep::CreateGroup]
        );
        // The group of another disk does not matter.
        let mut other = group();
        other.name = "other".into();
        assert_eq!(
            plan_group(&config(), None, &[other]).unwrap(),
            vec![GroupStep::CreatePhysicalVolume, GroupStep::CreateGroup]
        );
    }

    #[test]
    fn a_first_boot_that_stopped_after_pvcreate_creates_the_group_only() {
        let mut pv = device();
        pv.group = String::new();
        assert_eq!(
            plan_group(&config(), Some(&pv), &[]).unwrap(),
            vec![GroupStep::CreateGroup]
        );
        pv.mda_bytes = 1_044_480;
        assert!(plan_group(&config(), Some(&pv), &[]).is_err());
    }

    #[test]
    fn an_existing_group_on_the_device_needs_nothing() {
        assert_eq!(
            plan_group(&config(), Some(&device()), &[group()]).unwrap(),
            vec![]
        );
    }

    #[test]
    fn a_group_that_is_not_the_nodes_is_never_adopted() {
        let wrong = |change: &dyn Fn(&mut PhysicalVolume, &mut VolumeGroup)| {
            let (mut pv, mut vg) = (device(), group());
            change(&mut pv, &mut vg);
            plan_group(&config(), Some(&pv), &[vg]).is_err()
        };
        assert!(wrong(&|pv, _| pv.group = "other".into()));
        assert!(wrong(&|_, vg| vg.pvs = 2));
        assert!(wrong(&|_, vg| vg.missing_pvs = 1));
        assert!(wrong(&|_, vg| vg.writable = false));
        // The default 1 MiB area cannot be grown in place (Stage 1).
        assert!(wrong(&|pv, _| pv.mda_bytes = 1_044_480));
        // The group exists but the device is not its physical volume.
        assert!(plan_group(&config(), None, &[group()]).is_err());
    }

    #[test]
    fn the_pool_takes_every_free_extent_but_metadata_and_its_spare() {
        // 1,002,438,656 free bytes minus 2 x 8 MiB is 235 whole extents.
        assert_eq!(
            plan_pool(&config(), &group(), &[]).unwrap(),
            vec![
                PoolStep::Create {
                    data_bytes: 985_661_440
                },
                PoolStep::ErrorWhenFull
            ]
        );
        // A partial extent stays unused: the data size is a whole number of extents.
        let mut vg = group();
        vg.free_bytes += 4_194_303;
        assert_eq!(
            plan_pool(&config(), &vg, &[]).unwrap()[0],
            PoolStep::Create {
                data_bytes: 985_661_440
            }
        );
        vg.free_bytes = 2 * (8 << 20) + 4_194_304 - 1;
        assert!(matches!(
            plan_pool(&config(), &vg, &[]),
            Err(Error::TooSmall)
        ));
    }

    #[test]
    fn a_pool_that_stopped_before_error_when_full_is_finished_and_a_finished_one_is_left() {
        let queue = parse_lvs(LVS_QUEUE).unwrap();
        assert_eq!(
            plan_pool(&config(), &group(), &queue).unwrap(),
            vec![PoolStep::ErrorWhenFull]
        );
        let done = parse_lvs(LVS_VOLUMES).unwrap();
        assert_eq!(plan_pool(&config(), &group(), &done).unwrap(), vec![]);
    }

    #[test]
    fn a_pool_that_is_not_the_nodes_is_never_changed() {
        let pool = || parse_lvs(LVS_VOLUMES).unwrap();
        let wrong = |change: &dyn Fn(&mut LogicalVolume)| {
            let mut lvs = pool();
            change(lvs.iter_mut().find(|lv| lv.is_pool()).unwrap());
            plan_pool(&config(), &group(), &lvs).is_err()
        };
        assert!(wrong(&|lv| lv.chunk_bytes = 131_072));
        assert!(wrong(&|lv| lv.zero = "".into()));
        assert!(wrong(&|lv| lv.metadata_bytes = 16 << 20));
        // Volumes without a pool cannot exist; whatever they are, they are not ours to adopt.
        let no_pool: Vec<_> = pool().into_iter().filter(|lv| !lv.is_pool()).collect();
        assert!(plan_pool(&config(), &group(), &no_pool).is_err());
    }
}
