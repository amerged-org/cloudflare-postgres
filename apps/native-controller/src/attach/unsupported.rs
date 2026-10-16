// SPDX-License-Identifier: Apache-2.0
//! The agent on an OS without the Linux mount and device-mapper interfaces: every kernel effect
//! answers `unsupported_platform`, so the crate builds and its rules are tested everywhere.
use crate::agent::{Device, Host, Mounted};
use pgcf_native_controller::attach_protocol::{Control, Volume};

pub(crate) struct UnsupportedHost;

const UNSUPPORTED: &str = "unsupported_platform";

impl Host for UnsupportedHost {
    fn boot_id(&self) -> Result<String, &'static str> {
        Err(UNSUPPORTED)
    }
    fn device(&self, _volume: &Volume) -> Result<Option<Device>, &'static str> {
        Err(UNSUPPORTED)
    }
    fn devices(&self) -> Result<Vec<(String, Device)>, &'static str> {
        Err(UNSUPPORTED)
    }
    fn mount(&self, _volume: &Volume) -> Result<Mounted, &'static str> {
        Err(UNSUPPORTED)
    }
    fn read_control(&self, _mounted: &Mounted) -> Result<Control, &'static str> {
        Err(UNSUPPORTED)
    }
    fn container_pid(&self, _container_id: &str) -> Result<Option<u32>, &'static str> {
        Err(UNSUPPORTED)
    }
    fn move_into(&self, _mounted: &Mounted, _pid: u32, _clone: bool) -> Result<(), &'static str> {
        Err(UNSUPPORTED)
    }
    fn unmount_in(&self, _pid: u32) -> Result<(), &'static str> {
        Err(UNSUPPORTED)
    }
    fn mounted_in(&self, _pid: u32, _dev: (u32, u32)) -> Result<bool, &'static str> {
        Err(UNSUPPORTED)
    }
    fn control_in(&self, _pid: u32) -> Result<(Option<Control>, bool), &'static str> {
        Err(UNSUPPORTED)
    }
}
