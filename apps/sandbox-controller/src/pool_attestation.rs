// SPDX-License-Identifier: Apache-2.0
//! Public-only local supervisor identity; possession of this file does not grant any write authority.
use crate::pool_custody::Container;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    ffi::CString,
    fs::File,
    io::Read,
    os::{fd::FromRawFd, unix::fs::MetadataExt},
    path::Path,
};
use tonic::Status;
use x509_parser::{
    extensions::{GeneralName, ParsedExtension},
    prelude::*,
};
fn refused() -> Status {
    Status::failed_precondition("pool_supervisor_attestation_unconfirmed")
}
#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}
fn open(path: &str, flags: i32) -> Result<File, Status> {
    let path = CString::new(path).map_err(|_| refused())?;
    let how = OpenHow {
        flags: (flags | libc::O_CLOEXEC) as u64,
        mode: 0,
        resolve: 0x04 | 0x02,
    };
    let fd = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            libc::AT_FDCWD,
            path.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        )
    };
    if fd < 0 {
        return Err(refused());
    }
    Ok(unsafe { File::from_raw_fd(fd as i32) })
}
pub fn certificate_matches(
    public_pem: &str,
    certificate_pem: &str,
    key_hash: &str,
    address: std::net::IpAddr,
) -> bool {
    let Ok((remaining, pem)) = x509_parser::pem::parse_x509_pem(certificate_pem.as_bytes()) else {
        return false;
    };
    if !remaining.iter().all(u8::is_ascii_whitespace) || pem.label != "CERTIFICATE" {
        return false;
    }
    let Ok((remaining, cert)) = X509Certificate::from_der(&pem.contents) else {
        return false;
    };
    if !remaining.is_empty()
        || !cert.validity().is_valid()
        || cert.verify_signature(Some(cert.public_key())).is_err()
    {
        return false;
    }
    let Ok((remaining, key)) = x509_parser::pem::parse_x509_pem(public_pem.as_bytes()) else {
        return false;
    };
    if !remaining.iter().all(u8::is_ascii_whitespace)
        || key.label != "PUBLIC KEY"
        || key.contents.as_slice() != cert.tbs_certificate.subject_pki.raw
    {
        return false;
    }
    let actual = Sha256::digest(&key.contents)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    if actual != key_hash {
        return false;
    }
    let ips = cert
        .extensions()
        .iter()
        .filter_map(|ext| {
            if let ParsedExtension::SubjectAlternativeName(san) = ext.parsed_extension() {
                Some(san)
            } else {
                None
            }
        })
        .flat_map(|san| san.general_names.iter())
        .filter_map(|name| {
            if let GeneralName::IPAddress(raw) = name {
                Some(*raw)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    let expected = match address {
        std::net::IpAddr::V4(v) => v.octets().to_vec(),
        std::net::IpAddr::V6(v) => v.octets().to_vec(),
    };
    ips.len() == 1 && ips[0] == expected
}
pub fn read(
    container: &Container,
    node_uid: &str,
    expected_executable: &str,
    address: std::net::IpAddr,
) -> Result<Value, Status> {
    container.process.recheck()?;
    if container.role != "postgres"
        || crate::policy::digest(Path::new(&format!("/proc/{}/exe", container.process.pid)))?
            != expected_executable
    {
        return Err(refused());
    }
    let parent = format!(
        "/var/lib/kubelet/pods/{}/volumes/kubernetes.io~empty-dir/control/private",
        container.pod_uid
    );
    let directory = open(&parent, libc::O_PATH | libc::O_DIRECTORY)?;
    let meta = directory.metadata().map_err(|_| refused())?;
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    use std::os::fd::AsRawFd;
    if meta.uid() != 26
        || meta.mode() & 0o7777 != 0o700
        || unsafe { libc::fstatfs(directory.as_raw_fd(), &mut stat) } != 0
        || i128::from(stat.f_type) != 0x0102_1994
    {
        return Err(refused());
    }
    let file = open(&format!("{parent}/attestation.json"), libc::O_RDONLY)?;
    let meta = file.metadata().map_err(|_| refused())?;
    if !meta.is_file()
        || meta.uid() != 26
        || meta.mode() & 0o7777 != 0o600
        || meta.nlink() != 1
        || meta.len() > 65536
    {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    file.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| refused())?;
    if bytes.len() > 65536 {
        return Err(refused());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    let fields = [
        "v",
        "pool_pod_uid",
        "node_uid",
        "supervisor_sha256",
        "supervisor_key_sha256",
        "supervisor_public_key_pem",
        "supervisor_certificate_pem",
        "workload_probe",
        "observed_at",
    ];
    if value.as_object().is_none_or(|o| {
        o.len() != fields.len() || o.keys().any(|key| !fields.contains(&key.as_str()))
    }) || value["v"] != 1
        || value["pool_pod_uid"] != container.pod_uid
        || value["node_uid"] != node_uid
        || value["supervisor_sha256"] != expected_executable
    {
        return Err(refused());
    }
    if !certificate_matches(
        value["supervisor_public_key_pem"]
            .as_str()
            .ok_or_else(refused)?,
        value["supervisor_certificate_pem"]
            .as_str()
            .ok_or_else(refused)?,
        value["supervisor_key_sha256"]
            .as_str()
            .ok_or_else(refused)?,
        address,
    ) {
        return Err(refused());
    }
    if !pgcf_native_protocol::pool::workload_probe_safe(&value["workload_probe"]) {
        return Err(refused());
    }
    container.process.recheck()?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_certificate_binds_ip_spki_hash_and_single_public_leaf() {
        use rcgen::PublicKeyData;
        let generated = rcgen::generate_simple_self_signed(vec![
            "pgcf-pool.invalid".to_owned(),
            "192.0.2.10".to_owned(),
        ])
        .unwrap();
        let key = generated.signing_key.public_key_pem();
        let cert = generated.cert.pem();
        let hash = Sha256::digest(generated.signing_key.subject_public_key_info())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let address = "192.0.2.10".parse().unwrap();
        assert!(certificate_matches(&key, &cert, &hash, address));
        assert!(!certificate_matches(
            &key,
            &cert,
            &hash,
            "192.0.2.11".parse().unwrap()
        ));
        assert!(!certificate_matches(&key, &cert, &"0".repeat(64), address));
        let another = rcgen::generate_simple_self_signed(vec!["192.0.2.10".to_owned()]).unwrap();
        assert!(!certificate_matches(
            &another.signing_key.public_key_pem(),
            &cert,
            &hash,
            address
        ));
        assert!(!certificate_matches(
            &key,
            &format!("{cert}{cert}"),
            &hash,
            address
        ));
    }
}
