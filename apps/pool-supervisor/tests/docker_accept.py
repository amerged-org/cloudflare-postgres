# SPDX-License-Identifier: Apache-2.0
"""Real local PG/Barman/S3 acceptance; never touches a regional endpoint.

The fixture authenticates runtime inputs, not the node-agent's privileged LVM mount proof.
Run after compiling the musl binary in the repository-pinned Docker builder.
"""
import argparse
import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time
import uuid

PG = "ghcr.io/amerged-org/pgcf-regional@sha256:5495f355719f24bd56219bc46825ecfa8771515a110ceca6e4d83331868bf115"
BARMAN = "ghcr.io/cloudnative-pg/plugin-barman-cloud-sidecar:v0.15.1@sha256:eb61ec74fddfcadc956fa49d99306daf9d6ec84b59594b183614037e2b5a5785"
ROOT = Path(__file__).resolve().parents[3]


def run(*args, timeout=120, check=True):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if check and result.returncode:
        if b"CERTIFICATE_VERIFY_FAILED" in result.stderr and b"IP address mismatch" in result.stderr:
            raise RuntimeError("supervisor TLS IP SAN verification failed")
        raise RuntimeError(f"fixture command failed ({Path(args[0]).name}, exit {result.returncode})")
    return result


def private(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(data if isinstance(data, bytes) else data.encode())


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def execute(container, code, *arguments, timeout=120):
    return run("docker", "exec", container, "python3", "-c", code, *arguments, timeout=timeout).stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--minio-binary", type=Path, required=True)
    parser.add_argument("--binary-volume", default="pgcf-pool-supervisor-target-amd64")
    parser.add_argument("--controller-peer-volume")
    parser.add_argument("--controller-peer-sha256")
    args = parser.parse_args()
    os.umask(0o077)
    prefix = "pgcf-pool-test-" + secrets.token_hex(6)
    base = ROOT / ".local" / "pool-supervisor"
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    fixture = Path(tempfile.mkdtemp(prefix=prefix + "-", dir=base))
    containers, volumes = [], []
    network = prefix
    archive_prefix = "pool/" + prefix
    minio_image = prefix + "-minio:fixture"
    try:
        # Only setup accesses upstream. The actual object store and clients use an internal network.
        lock = json.loads((Path(__file__).parent / "minio.lock.json").read_text())
        archive = args.minio_binary.parent / "source.tar.gz"
        license_path = args.minio_binary.parent / ("minio-" + lock["source_commit"]) / "LICENSE"
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == lock["source_archive_sha256"]
        assert hashlib.sha256(license_path.read_bytes()).hexdigest() == lock["license_sha256"]
        shutil.copyfile(archive, fixture / "minio-source.tar.gz")
        shutil.copyfile(license_path, fixture / "MinIO-LICENSE")
        shutil.copyfile(args.minio_binary, fixture / "minio")
        (fixture / "minio").chmod(0o555)
        private(fixture / "Dockerfile", "FROM scratch\nCOPY minio /minio\nCOPY MinIO-LICENSE /licenses/MinIO-LICENSE\nCOPY minio-source.tar.gz /licenses/minio-source.tar.gz\nENTRYPOINT [\"/minio\"]\n")
        run("docker", "build", "--platform", "linux/amd64", "--network", "none", "-t", minio_image, str(fixture), timeout=180)
        image_id = run("docker", "image", "inspect", "--format", "{{.Id}}", minio_image).stdout.decode().strip()
        run("openssl","req","-x509","-newkey","rsa:2048","-nodes","-days","1","-subj","/CN=local-minio-ca","-addext","basicConstraints=critical,CA:TRUE","-keyout",str(fixture/"ca.key"),"-out",str(fixture/"ca.crt"))
        run("openssl","req","-new","-newkey","rsa:2048","-nodes","-subj","/CN=minio","-keyout",str(fixture/"private.key"),"-out",str(fixture/"server.csr"))
        private(fixture/"minio-ext.cnf","basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:minio\n")
        run("openssl","x509","-req","-in",str(fixture/"server.csr"),"-CA",str(fixture/"ca.crt"),"-CAkey",str(fixture/"ca.key"),"-CAcreateserial","-days","1","-sha256","-extfile",str(fixture/"minio-ext.cnf"),"-out",str(fixture/"public.crt"))
        for path in (fixture / "private.key", fixture / "public.crt",fixture/"ca.key",fixture/"ca.crt",fixture/"server.csr",fixture/"ca.srl"):
            path.chmod(0o600)
        user, password = secrets.token_hex(12), secrets.token_hex(32)
        private(fixture / "minio.env", f"MINIO_ROOT_USER={user}\nMINIO_ROOT_PASSWORD={password}\nMINIO_REGION_NAME=auto\nMINIO_BROWSER=off\n")
        private(fixture / "archive.env", f"AWS_ACCESS_KEY_ID={user}\nAWS_SECRET_ACCESS_KEY={password}\nAWS_DEFAULT_REGION=auto\nAWS_MAX_ATTEMPTS=1\nAWS_CA_BUNDLE=/test-ca/ca.crt\nPGCF_POOL_ENABLED=1\n")
        run("docker", "network", "create", "--internal", network)
        subnet = run("docker", "network", "inspect", "--format", "{{(index .IPAM.Config 0).Subnet}}", network).stdout.decode().strip()
        pool_ip = str(ipaddress.ip_network(subnet)[10])
        for kind in ("data", "control", "run", "certificates", "bin", "ca", "object-data"):
            volume = prefix + "-" + kind
            volumes.append(volume)
            run("docker", "volume", "create", volume)
        mounts = []
        for kind, path in (("data", "/var/lib/postgresql"), ("control", "/pgcf/control"), ("run", "/controller/run"), ("certificates", "/controller/certificates"), ("bin", "/pgcf/bin"), ("ca", "/test-ca")):
            mounts += ["-v", prefix + "-" + kind + ":" + path]
        run("docker", "run", "--rm", "--platform", "linux/amd64", "--network", "none", "--user", "0:0", *mounts,
            "-v", str(fixture) + ":/fixture:ro", "--entrypoint", "/bin/sh", PG, "-c",
            "chmod 777 /pgcf/bin /pgcf/control /controller/run /controller/certificates; chown 26:26 /var/lib/postgresql; cp /fixture/ca.crt /test-ca/ca.crt; chown 26:26 /test-ca/ca.crt; chmod 600 /test-ca/ca.crt")
        run("docker", "run", "--rm", "--platform", "linux/amd64", "--network", "none", "--user", "26:26", *mounts,
            "-v", args.binary_volume + ":/target:ro", "--entrypoint", "/target/debug/pgcf-pool-supervisor", PG,
            "install", "/pgcf/bin/pgcf-supervisor", "/pgcf/control/private", "/controller/run/private", "/controller/certificates/private")
        run("docker", "run", "--rm", "--platform", "linux/amd64", "--network", "none", "--user", "26:26", *mounts,
            "-v", args.binary_volume + ":/target:ro", "--entrypoint", "/bin/cp", PG,
            "/target/debug/examples/custody-probe", "/pgcf/bin/custody-probe")
        # Setup alone runs initdb. Product serve never does and remains tenant-free until both inputs.
        run("docker", "run", "--rm", "--platform", "linux/amd64", "--network", "none", "--user", "26:26", *mounts,
            "--entrypoint", "initdb", PG, "-D", "/var/lib/postgresql/data/pgdata", "--no-sync", "--auth-local=trust", "--auth-host=reject")
        run("openssl", "genpkey", "-algorithm", "ED25519", "-out", str(fixture / "bind.key"))
        (fixture / "bind.key").chmod(0o600)
        key_der = run("openssl", "pkey", "-in", str(fixture / "bind.key"), "-pubout", "-outform", "DER").stdout
        pod_uid, node_uid, binding, nonce = (str(uuid.uuid4()) for _ in range(4))
        keys=json.dumps({"fixture":b64(key_der[-32:])},sort_keys=True,separators=(",",":"))
        private(fixture / "pool.env", "PGCF_POOL_ENABLED=1\nPGCF_POOL_POD_UID=" + pod_uid + "\nPGCF_POOL_NODE_UID=" + node_uid +
                "\nPGCF_POOL_POD_IP=" + pool_ip + "\nPGCF_POOL_POSTGRES_IMAGE_SHA256=" + PG.split("sha256:")[1] + "\nPGCF_POOL_BIND_KEYS=" + keys + "\nPGCF_POOL_BIND_KEYS_SHA256=" + hashlib.sha256(keys.encode()).hexdigest() + "\n")
        # Docker's volume subpath syntax is --mount, not the short -v syntax.
        def subpath(kind, target, readonly=False):
            return ["--mount", "type=volume,source=" + prefix + "-" + kind + ",target=" + target + ",volume-subpath=private" + (",readonly" if readonly else "")]
        pool_mounts = ["-v", prefix + "-data:/var/lib/postgresql", "-v", prefix + "-bin:/pgcf/bin:ro", *subpath("control", "/pgcf/control"), *subpath("run", "/controller/run"), *subpath("certificates", "/controller/certificates")]
        archiver_mounts = ["-v", prefix + "-data:/var/lib/postgresql:ro", "-v", prefix + "-bin:/pgcf/bin:ro", "-v", prefix + "-ca:/test-ca:ro", *subpath("run", "/controller/run")]
        archiver = prefix + "-archiver"
        containers.append(archiver)
        restricted=["--cap-drop","ALL","--security-opt","no-new-privileges:true","--read-only","--tmpfs","/tmp:uid=26,gid=26"]
        run("docker", "run", "-d", "--name", archiver, "--platform", "linux/amd64", "--network", network, "--user", "26:26", *restricted,"--env-file", str(fixture / "archive.env"), *archiver_mounts,
            "--entrypoint", "/pgcf/bin/pgcf-supervisor", BARMAN, "archiver")
        minio = prefix + "-minio"
        containers.append(minio)
        run("docker", "run", "-d", "--name", minio, "--platform", "linux/amd64", "--network", network, "--network-alias", "minio",
            "--env-file", str(fixture / "minio.env"), "-v", str(fixture) + ":/certs:ro", "-v", prefix + "-object-data:/data", minio_image, "server", "/data", "--certs-dir", "/certs", "--address", ":9000")
        create = "import boto3,time; s=boto3.client('s3',endpoint_url='https://minio:9000',region_name='auto');\nfor i in range(60):\n try: s.create_bucket(Bucket='pgcf-fixture'); break\n except Exception:\n  if i==59: raise RuntimeError('object-store readiness failed') from None\n  time.sleep(.2)"
        execute(archiver, create)
        pool_name = prefix + "-postgres"
        containers.append(pool_name)
        run("docker", "run", "-d", "--name", pool_name, "--platform", "linux/amd64", "--network", network, "--ip", pool_ip, "--network-alias", "pgcf-pool.invalid", "--user", "26:26", *restricted,
            "--env-file", str(fixture / "pool.env"), *pool_mounts, "--entrypoint", "/pgcf/bin/pgcf-supervisor", PG, "serve")
        controller = prefix + "-controller"
        containers.append(controller)
        run("docker", "run", "-d", "--name", controller, "--platform", "linux/amd64", "--network", network, "--user", "0:0", "-v", prefix + "-control:/pgcf/control", "-v", str(fixture) + ":/fixture:ro",
            "--entrypoint", "python3", BARMAN, "-c", "import time; time.sleep(3600)")
        read_attestation = "import pathlib,time; p=pathlib.Path('/pgcf/control/private/attestation.json');\nfor i in range(100):\n if p.exists(): print(p.read_text()); break\n time.sleep(.05)\nelse: raise RuntimeError('public attestation missing')"
        attestation = json.loads(execute(controller, read_attestation))
        # Engine-created physical identity is selected; no fabricated pg_control or readiness data.
        actual = run("docker", "exec", pool_name, "pg_controldata", "/var/lib/postgresql/data/pgdata").stdout.decode()
        fields = {line.split(":", 1)[0]: line.split(":", 1)[1].strip() for line in actual.splitlines() if ":" in line}
        assert fields["Database cluster state"] == "shut down"
        system_id, timeline = fields["Database system identifier"], int(fields["Latest checkpoint's TimeLineID"])
        config = "listen_addresses='*'\nport=5432\narchive_mode=on\nwal_level=replica\nmax_wal_senders=4\narchive_timeout=1\nunix_socket_directories='/controller/run'\nssl=on\nssl_cert_file='/controller/certificates/server.crt'\nssl_key_file='/controller/certificates/server.key'\nssl_ca_file='/controller/certificates/client-ca.crt'\n"
        private(fixture / "postgresql.conf", config)
        private(fixture / "pg_hba.conf", "local all all peer map=local\nhostssl all all 0.0.0.0/0 trust\nhostssl all all ::/0 trust\n")
        private(fixture / "pg_ident.conf", "local postgres postgres\n")
        run("docker","run","--rm","--platform","linux/amd64","--network","none","--user","0:0","-v",str(fixture)+":/fixture:ro","-v",prefix+"-data:/var/lib/postgresql","--entrypoint","/bin/sh",PG,"-c","cp /fixture/postgresql.conf /fixture/pg_hba.conf /fixture/pg_ident.conf /var/lib/postgresql/data/pgdata/; chown 26:26 /var/lib/postgresql/data/pgdata/postgresql.conf /var/lib/postgresql/data/pgdata/pg_hba.conf /var/lib/postgresql/data/pgdata/pg_ident.conf")
        database = "d" + secrets.token_hex(10)[1:]
        tls_name = "database-rw.pgcf-db-" + database + ".svc"
        run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=" + tls_name, "-addext", "subjectAltName=DNS:" + tls_name,
            "-keyout", str(fixture / "server.key"), "-out", str(fixture / "server.crt"))
        for file in (fixture / "server.key", fixture / "server.crt"): file.chmod(0o600)
        scope = {"v":1,"binding_id":binding,"database_id":database,"generation":1,"route_revision":1,"admission_epoch":1,"configuration_fingerprint":hashlib.sha256(config.encode()).hexdigest(),"region_id":"eu-dev","node_id":"nod_" + secrets.token_hex(10),"node_uid":node_uid,"boot_id":str(uuid.uuid4()),"pool_pod_uid":pod_uid,"pool_pod_name":pool_name,"pool_pod_ip":"127.0.0.1","container_id":run("docker", "inspect", "--format", "{{.Id}}", pool_name).stdout.decode().strip(),"supervisor_key_sha256":attestation["supervisor_key_sha256"],"supervisor_sha256":attestation["supervisor_sha256"],"class":{"postgres_image_sha256":PG.split("sha256:")[1],"cpu_request_millicores":1000,"cpu_limit_millicores":1000,"memory_request_bytes":268435456,"memory_limit_bytes":268435456,"configuration_profile_sha256":hashlib.sha256(config.encode()).hexdigest()},"storage":{"backend":"lvm-thick-v1","storage_generation":1,"storage_uid":str(uuid.uuid4()),"namespace_uid":str(uuid.uuid4()),"cnpg_cluster_uid":str(uuid.uuid4()),"pvc_uid":str(uuid.uuid4()),"pv_uid":str(uuid.uuid4()),"volume_handle":"pvc-" + str(uuid.uuid4()),"volume_group_uuid":"AAAAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAAAA","lv_uuid":"BBBBBB-BBBB-BBBB-BBBB-BBBB-BBBB-BBBBBB"},"system_identifier":system_id,"timeline":timeline,"bundle_nonce":nonce}
        scope["pool_pod_ip"] = pool_ip
        scope["pool_namespace"]="pgcf-pool"
        scope["pool_namespace_uid"]=str(uuid.uuid4())
        scope["container_ids"]=[scope["container_id"],run("docker","inspect","--format","{{.Id}}",archiver).stdout.decode().strip()]
        digest = hashlib.sha256(json.dumps(scope, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        driver = json.loads((ROOT / "infra/storage/sources.lock.json").read_text())["driver"]
        scope["driver_image"] = driver["upstream_image"] + "@" + driver["image_index_digest"]
        scope["driver_sha256"] = driver["upstream_binary_sha256"]
        digest = hashlib.sha256(json.dumps(scope, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        at = int(time.time()*1000)
        claims = {"v":1,"kid":"fixture","scope":scope,"scope_sha256":digest,"holder_revision":1,"iat":at,"exp":at+5000}
        encoded = b64(json.dumps(claims, separators=(",", ":")).encode())
        private(fixture / "sign-input", "pgcf-pool-bind/v1\n" + encoded)
        signature = run("openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(fixture / "bind.key"), "-in", str(fixture / "sign-input")).stdout
        permission = "pb1." + encoded + "." + b64(signature)
        ca = (fixture / "server.crt").read_text()
        bundle = {"v":1,"scope":scope,"scope_sha256":digest,"holder_revision":1,"permission":permission,"server_certificate_pem":ca,"server_private_key_pem":(fixture / "server.key").read_text(),"client_ca_pem":ca,"ca_secret_uid":str(uuid.uuid4()),"ca_secret_resource_version":"1","ca_sha256":hashlib.sha256(ca.encode()).hexdigest(),"tls_server_name":tls_name,"archive":{"destination_path":"s3://pgcf-fixture/"+archive_prefix,"server_name":"database","endpoint_url":"https://minio:9000","retention_days":1}}
        bundle["storage_authority"]=None
        thin_scope=json.loads(json.dumps(scope))
        thin_storage=json.loads((ROOT / "packages/contracts/native/postgres-pool.generated.json").read_text())["thin_scope"]["storage"]
        thin_storage.update({key:value for key,value in scope["storage"].items() if key!="backend"})
        thin_storage["profile"]["node_uid"]=node_uid
        thin_storage["profile"]["volume_group_uuid"]=thin_storage["volume_group_uuid"]
        thin_scope["storage"]=thin_storage
        thin_hash=hashlib.sha256(json.dumps(thin_scope,sort_keys=True,separators=(",",":")).encode()).hexdigest()
        thin_claims=dict(claims,scope=thin_scope,scope_sha256=thin_hash)
        thin_payload=b64(json.dumps(thin_claims,separators=(",",":")).encode())
        private(fixture / "thin-sign-input","pgcf-pool-bind/v1\n"+thin_payload)
        thin_signature=run("openssl","pkeyutl","-sign","-rawin","-inkey",str(fixture/"bind.key"),"-in",str(fixture/"thin-sign-input")).stdout
        private(fixture/"thin-pb1-only.json",json.dumps(dict(bundle,scope=thin_scope,scope_sha256=thin_hash,permission="pb1."+thin_payload+"."+b64(thin_signature))))
        private(fixture / "bundle.json", json.dumps(bundle))
        private(fixture / "null-initial.json", json.dumps(dict(bundle, permission=None)))
        http = "import json,ssl,urllib.request,urllib.error,sys; a=json.load(open('/pgcf/control/private/attestation.json')); c=ssl.create_default_context(cadata=a['supervisor_certificate_pem']); b=open('/fixture/'+sys.argv[2],'rb').read(); q=urllib.request.Request('https://'+sys.argv[3]+':18443/'+sys.argv[1],data=b,headers={'Content-Type':'application/json'},method='POST');\ntry: print(urllib.request.urlopen(q,context=c,timeout=2400).read().decode())\nexcept urllib.error.HTTPError as e: print(e.read().decode())"
        refused = json.loads(execute(controller, http, "bundle", "null-initial.json", pool_ip))
        assert "error" in refused, "null permission must never establish a new holder"
        thin_refused=json.loads(execute(controller,http,"bundle","thin-pb1-only.json",pool_ip))
        assert thin_refused.get("error")=="pool_storage_authority_missing", "PB1 mount permission alone must not start THIN PostgreSQL"
        waiting = json.loads(execute(controller, http, "bundle", "bundle.json", pool_ip))
        if "error" in waiting: raise RuntimeError(waiting["error"])
        assert waiting == {"accepted":True,"waiting":True}
        replay = json.loads(execute(controller, http, "bundle", "bundle.json", pool_ip))
        assert replay == waiting, "the same pending bundle must resolve a lost reply without consuming a second holder"
        private(fixture / "changed-pending.json", json.dumps(dict(bundle, holder_revision=2)))
        changed = json.loads(execute(controller, http, "bundle", "changed-pending.json", pool_ip))
        assert "error" in changed, "pending bundle replay must reject a changed holder"
        # Bundle alone must not start a postmaster.
        actual = run("docker", "exec", pool_name, "pg_controldata", "/var/lib/postgresql/data/pgdata").stdout.decode()
        assert "Database cluster state:               shut down" in actual
        device = json.loads(execute(archiver, "import os,json; d=os.stat('/var/lib/postgresql/data/pgdata').st_dev; print(json.dumps({'major':os.major(d),'minor':os.minor(d)}))"))
        signal = {"v":1,"scope_sha256":digest,"binding_id":binding,"bundle_nonce":nonce,"node_uid":node_uid,"boot_id":scope["boot_id"],"pool_pod_uid":pod_uid,"permission":permission,"mount_id":1,"device_major":device["major"],"device_minor":device["minor"],"observed_at":int(time.time()*1000)}
        signal["storage_authority"]=None
        private(fixture / "mount.json", json.dumps(signal))
        signal_code = "import socket,json; s=socket.socket(socket.AF_UNIX); s.connect('/pgcf/control/private/agent.sock'); s.sendall(open('/fixture/mount.json','rb').read()); s.shutdown(socket.SHUT_WR); print(s.makefile().read())"
        ready = json.loads(execute(controller, signal_code))
        if ready.get("error") is not None: raise RuntimeError(ready["error"])
        assert ready["state"] == "ready" and ready["postmaster_pid"] > 0 and ready["system_identifier"] == system_id and ready["timeline"] == timeline
        repeated = json.loads(execute(controller, signal_code))
        if repeated.get("error") is not None: raise RuntimeError(repeated["error"])
        assert repeated["postmaster_pid"] == ready["postmaster_pid"], "notification retry must read back the same postmaster"
        custody_probes = []
        for holder in (pool_name, archiver):
            custody = json.loads(run("docker", "exec", holder, "/pgcf/bin/custody-probe").stdout)
            # Access outcomes only; the child never reads environment/map/memory contents.
            print(json.dumps({"custody_target": "supervisor" if holder == pool_name else "archiver", "custody_probe": custody}), flush=True)
            custody_probes.append(custody)
        for custody in custody_probes:
            assert custody["target_uid_26"] and custody["self_environ"]["opened"]
            assert custody["target_environ_owner_uid"] == 0, "trusted holder must disable same-UID process inspection"
            assert all(not custody[field]["opened"] for field in ("target_environ", "target_maps", "target_mem"))
            assert all(custody[field]["errno"] == 1 for field in ("process_vm_read", "process_vm_write", "ptrace_attach"))
        inspector_code = "import hashlib,json,os,pathlib; status=pathlib.Path('/proc/1/status').read_text(); fields=dict(line.split(':',1) for line in status.splitlines() if ':' in line); own=dict(line.split(':',1) for line in pathlib.Path('/proc/self/status').read_text().splitlines() if ':' in line); namespaces=[os.readlink('/proc/1/ns/'+kind) for kind in ('pid','mnt')]; print(json.dumps({'target_uid_26':all(v=='26' for v in fields['Uid'].split()),'proc_owner_root':os.stat('/proc/1/environ').st_uid==0,'exe_sha256':hashlib.sha256(pathlib.Path('/proc/1/exe').read_bytes()).hexdigest(),'namespace_handles_read':len(namespaces)==2,'stat_read':bool(pathlib.Path('/proc/1/stat').read_text()),'cgroup_read':bool(pathlib.Path('/proc/1/cgroup').read_text()),'cap_sys_ptrace':bool(int(own['CapEff'].strip(),16)&(1<<19))}))"
        inspector_executable_matches = []
        for holder in (pool_name, archiver):
            inspected = json.loads(run("docker", "run", "--rm", "--platform", "linux/amd64", "--network", "none", "--pid", "container:"+holder, "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "SYS_PTRACE", "--security-opt", "no-new-privileges:true", "--read-only", "--entrypoint", "python3", BARMAN, "-c", inspector_code).stdout)
            assert all(inspected[field] for field in ("target_uid_26","proc_owner_root","namespace_handles_read","stat_read","cgroup_read","cap_sys_ptrace"))
            assert len(inspected["exe_sha256"]) == 64, "authorized root inspector must still read the actual executable"
            # AMD64 user-mode emulation may expose its interpreter as /proc/PID/exe.
            # This proves privileged inspection permission; native Talos executable custody
            # remains a separate qualification gate with the unchanged exact hash check.
            inspector_executable_matches.append(inspected["exe_sha256"] == attestation["supervisor_sha256"])
        peer_proved = False
        if args.controller_peer_volume:
            assert args.controller_peer_sha256 and len(args.controller_peer_sha256) == 64
            peer_binary = "/peer-binary/pool-kubernetes/debug/examples/pool-supervisor-peer"
            archive_probe = json.loads(execute(archiver, "import pathlib; print(pathlib.Path('/controller/run/archiver-isolation.json').read_text())"))
            probes = [attestation["workload_probe"], archive_probe]
            assert all(p["uid"] == 26 and p["cap_eff"] == "0000000000000000" and p["seccomp_mode"] == 2 and p["no_new_privs"] for p in probes)
            # These fixture-only logical CF inputs exercise the actual controller TLS boundary.
            # They do not attest Talos mount propagation or any physical storage qualification.
            peer_attestation = {field:scope[field] for field in ("node_id","node_uid","boot_id","pool_namespace","pool_namespace_uid","container_ids","pool_pod_uid","pool_pod_name","pool_pod_ip","container_id","supervisor_sha256","supervisor_key_sha256","class")}
            peer_attestation.update({"v":1,"supervisor_public_key_pem":attestation["supervisor_public_key_pem"],"supervisor_certificate_pem":attestation["supervisor_certificate_pem"],"propagation_verified":True,"workload_isolation":{"uid":26,"cap_sys_admin":False,"seccomp_runtime_default":True,"namespace_creation_denied":True,"mount_api_denied":True},"workload_probes":[{"container_id":cid,"probe":probe} for cid,probe in zip(scope["container_ids"],probes)],"observed_at":int(time.time()*1000)})
            peer_binding = {"v":1,"scope":scope,"scope_sha256":digest,"holder_revision":1,"state":"serving","created_at":at,"updated_at":int(time.time()*1000)}
            private(fixture / "binding.json", json.dumps(peer_binding))
            private(fixture / "attestation.json", json.dumps(peer_attestation))
            private(fixture / "peer-control.json", json.dumps({"v":1,"binding_id":binding,"scope_sha256":digest,"bundle_nonce":nonce}))
            measured = run("docker","run","--rm","--platform","linux/amd64","--network","none","-v",args.controller_peer_volume+":/peer-binary:ro","--entrypoint","python3",BARMAN,"-c","import hashlib,pathlib,sys; print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())",peer_binary).stdout.decode().strip()
            assert measured == args.controller_peer_sha256, "peer executable must match its measured build receipt"
            peer_name = prefix + "-peer"
            containers.append(peer_name)
            result = run("docker","run","--rm","--name",peer_name,"--platform","linux/amd64","--network",network,"--user","0:0","--cap-drop","ALL","--security-opt","no-new-privileges:true","--read-only","-v",args.controller_peer_volume+":/peer-binary:ro","-v",str(fixture)+":/peer:ro","--entrypoint",peer_binary,BARMAN,"--binding-file","/peer/binding.json","--attestation-file","/peer/attestation.json","--control-file","/peer/peer-control.json")
            peer = json.loads(result.stdout)
            assert peer["state"] == "ready" and peer["system_identifier"] == "matched" and peer["timeline"] == "matched"
            peer_proved = True
        sql = "CREATE TABLE pool_marker(value text); INSERT INTO pool_marker VALUES ('acknowledged');"
        tls_dsn = "host=" + tls_name + " hostaddr=" + pool_ip + " sslmode=verify-full sslrootcert=/controller/certificates/client-ca.crt user=postgres dbname=postgres"
        run("docker", "exec", pool_name, "psql", tls_dsn, "-v", "ON_ERROR_STOP=1", "-c", sql)
        wal = run("docker", "exec", pool_name, "psql", tls_dsn, "-At", "-v", "ON_ERROR_STOP=1", "-c", "SELECT pg_walfile_name(pg_switch_wal())").stdout.decode().strip()
        assert len(wal) == 24 and all(c in "0123456789ABCDEF" for c in wal)
        upload = run("docker", "exec", pool_name, "/pgcf/bin/pgcf-supervisor", "wal-archive", "/var/lib/postgresql/data/pgdata/pg_wal/" + wal, check=False)
        if upload.returncode:
            code=upload.stderr.decode().strip()
            if code.startswith("pool_") and all(c.islower() or c=='_' for c in code):
                raise RuntimeError(code)
            raise RuntimeError("WAL shim failed without a bounded diagnostic")
        wait_archive = "import boto3,time,sys,json,gzip,hashlib,pathlib; s=boto3.client('s3',endpoint_url='https://minio:9000',region_name='auto');\nfor i in range(240):\n k=s.list_objects_v2(Bucket='pgcf-fixture',Prefix=sys.argv[1]+'/database/wals/').get('Contents',[]); target=next((o['Key'] for o in k if o['Key'].endswith('/'+sys.argv[2]+'.gz')),None)\n if target:\n  raw=gzip.decompress(s.get_object(Bucket='pgcf-fixture',Key=target)['Body'].read()); actual=pathlib.Path('/var/lib/postgresql/data/pgdata/pg_wal/'+sys.argv[2]).read_bytes(); assert raw==actual; print(json.dumps({'count':len(k),'sha256':hashlib.sha256(raw).hexdigest()})); break\n time.sleep(.25)\nelse: raise RuntimeError('actual committed WAL upload missing')"
        try:
            wal_proof = json.loads(execute(archiver, wait_archive, archive_prefix, wal))
        except RuntimeError:
            statistics = run("docker", "exec", pool_name, "psql", tls_dsn, "-At", "-c", "SELECT json_build_object('archived_count',archived_count,'failed_count',failed_count,'last_failed_wal',last_failed_wal) FROM pg_stat_archiver").stdout.decode().strip()
            objects = execute(archiver, "import boto3,json; s=boto3.client('s3',endpoint_url='https://minio:9000',region_name='auto'); print(json.dumps({'object_count':s.list_objects_v2(Bucket='pgcf-fixture').get('KeyCount',0)}))").decode().strip()
            print("Selected actual archiver metrics:", statistics, objects)
            raise
        run("docker", "exec", pool_name, "test", "-f", "/var/lib/postgresql/data/pgdata/pg_wal/archive_status/" + wal + ".done")
        busy=subprocess.Popen(["docker","exec","-i",pool_name,"psql",tls_dsn,"-X","-qAt","-v","ON_ERROR_STOP=1"],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        busy.stdin.write(b"SELECT pg_backend_pid();\n"); busy.stdin.flush()
        backend_pid=int(busy.stdout.readline().strip())
        while int(time.time()*1000)<=claims["exp"]: time.sleep(.05)
        busy.stdin.write(b"SELECT pg_sleep(1); SELECT 17;\n"); busy.stdin.flush()
        run("openssl","req","-x509","-newkey","rsa:2048","-nodes","-days","1","-subj","/CN="+tls_name,"-addext","subjectAltName=DNS:"+tls_name,"-keyout",str(fixture/"renewed.key"),"-out",str(fixture/"renewed.crt"))
        for file in (fixture/"renewed.key",fixture/"renewed.crt"): file.chmod(0o600)
        renewed_ca=(fixture/"renewed.crt").read_text()
        renewed=dict(bundle,permission=None,client_ca_pem=renewed_ca,server_certificate_pem=renewed_ca,server_private_key_pem=(fixture/"renewed.key").read_text(),ca_sha256=hashlib.sha256(renewed_ca.encode()).hexdigest(),ca_secret_resource_version="2")
        private(fixture/"renewed.json",json.dumps(renewed))
        renewal=json.loads(execute(controller,http,"bundle","renewed.json",pool_ip))
        if renewal.get("error") is not None: raise RuntimeError(renewal["error"])
        assert renewal["postmaster_pid"]==ready["postmaster_pid"]
        assert busy.stdout.readline().strip()==b"" and busy.stdout.readline().strip()==b"17", "existing busy TLS session must survive CA refresh"
        busy.stdin.write(b"SELECT pg_backend_pid();\n"); busy.stdin.flush()
        assert int(busy.stdout.readline().strip())==backend_pid
        busy.stdin.write(b"\\q\n"); busy.stdin.flush(); busy.wait(timeout=10)
        assert busy.returncode==0
        for attempt in range(30):
            refreshed=run("docker","exec",pool_name,"psql",tls_dsn,"-At","-c","SELECT value FROM pool_marker",check=False)
            if refreshed.returncode==0: break
            time.sleep(.1)
        assert refreshed.returncode==0 and refreshed.stdout.strip()==b"acknowledged", "fresh connection must verify the refreshed CA"
        control = {"v":1,"binding_id":binding,"scope_sha256":digest,"bundle_nonce":nonce}
        private(fixture / "backup.json", json.dumps(dict(control, backup_name="backup-" + prefix)))
        # A real object-store outage before dispatch is safe to retry under the same identity.
        run("docker", "stop", "--time", "5", minio)
        unavailable = json.loads(execute(controller, http, "backup", "backup.json", pool_ip, timeout=2500))
        assert "error" in unavailable, "no backup may dispatch without a readable catalog"
        run("docker", "start", minio)
        execute(archiver, create.replace("s.create_bucket(Bucket='pgcf-fixture')", "s.head_bucket(Bucket='pgcf-fixture')"))
        backup = json.loads(execute(controller, http, "backup", "backup.json", pool_ip, timeout=2500))
        if "error" in backup: raise RuntimeError(backup["error"])
        assert backup["state"] == "DONE" and len(backup["catalog_sha256"]) == 64 and (backup["bytes"] is None or backup["bytes"] > 0)
        again = json.loads(execute(controller, http, "backup", "backup.json", pool_ip, timeout=2500))
        assert again == backup
        catalog_prefix = archive_prefix + "/database/base/"
        s3_setup = "import boto3,json,sys; s=boto3.client('s3',endpoint_url='https://minio:9000',region_name='auto'); bucket='pgcf-fixture'; prefix=sys.argv[1]; "
        catalogs = json.loads(execute(archiver, s3_setup + "print(json.dumps([v['Key'] for v in s.list_objects_v2(Bucket=bucket,Prefix=prefix).get('Contents',[]) if v['Key'].endswith('/backup.info')]))", catalog_prefix))
        assert len(catalogs) == 1, "safe pre-dispatch retry must create exactly one backup"
        first_key = catalogs[0]
        original_catalog = execute(archiver, "import boto3,sys; s=boto3.client('s3',endpoint_url='https://minio:9000',region_name='auto'); sys.stdout.buffer.write(s.get_object(Bucket='pgcf-fixture',Key=sys.argv[1])['Body'].read())", first_key)
        private(fixture / "original-backup.info", original_catalog)
        def restore_catalog():
            code = "import boto3,sys; s=boto3.client('s3',endpoint_url='https://minio:9000',region_name='auto'); s.put_object(Bucket='pgcf-fixture',Key=sys.argv[1],Body=sys.stdin.buffer.read())"
            result = subprocess.run(["docker", "exec", "-i", archiver, "python3", "-c", code, first_key], input=original_catalog, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
            assert result.returncode == 0, "restore the exact captured local catalog without printing it"
        private(fixture / "second-backup.json", json.dumps(dict(control, backup_name="second-" + prefix)))
        # Stock Barman silently skips corrupt or absent metadata, even with an exit-zero list.
        for mutation in ("s.put_object(Bucket=bucket,Key=sys.argv[2],Body=b'version=not-an-integer\\n')", "s.delete_object(Bucket=bucket,Key=sys.argv[2])"):
            execute(archiver, s3_setup + mutation, catalog_prefix, first_key)
            refused = json.loads(execute(controller, http, "backup", "second-backup.json", pool_ip, timeout=2500))
            assert refused.get("error") == "pool_backup_catalog_incomplete", "an incomplete catalog cannot authorize a new backup"
            restore_catalog()
        # Corrupt real prior metadata only after a new backup has actually dispatched.
        watcher_code = s3_setup + "\nimport time\nfor _ in range(1000):\n keys=[v['Key'] for v in s.list_objects_v2(Bucket=bucket,Prefix=prefix).get('Contents',[]) if v['Key'].endswith('/backup.info') and v['Key']!=sys.argv[2]]\n if keys:\n  s.put_object(Bucket=bucket,Key=sys.argv[2],Body=b'version=not-an-integer\\n'); print('dispatched'); break\n time.sleep(.01)\nelse: raise RuntimeError('actual backup dispatch was not observed')"
        watcher = subprocess.Popen(["docker", "exec", archiver, "python3", "-c", watcher_code, catalog_prefix, first_key], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        uncertain = json.loads(execute(controller, http, "backup", "second-backup.json", pool_ip, timeout=2500))
        watcher_out, _ = watcher.communicate(timeout=30)
        assert watcher.returncode == 0 and watcher_out.strip() == b"dispatched"
        assert uncertain.get("error") == "pool_backup_catalog_incomplete", "post-dispatch catalog failure must remain unresolved"
        restore_catalog()
        reconciled = json.loads(execute(controller, http, "backup", "second-backup.json", pool_ip, timeout=2500))
        assert reconciled.get("state") == "DONE", "a dispatched backup must reconcile through reads rather than cache its transient error"
        after = json.loads(execute(archiver, s3_setup + "print(json.dumps([v['Key'] for v in s.list_objects_v2(Bucket=bucket,Prefix=prefix).get('Contents',[]) if v['Key'].endswith('/backup.info')]))", catalog_prefix))
        assert len(after) == 2, "uncertain same-name reconciliation must not create another backup"
        private(fixture / "control.json", json.dumps(control))
        stopped = json.loads(execute(controller, http, "stop", "control.json", pool_ip))
        assert stopped["state"] == "stopped" and stopped["control_state"] == "shut down" and stopped["postmaster_pid"] is None
        assert json.loads(execute(controller, http, "stop", "control.json", pool_ip)) == stopped
        print(json.dumps({"postgres_image":PG,"barman_image":BARMAN,"minio_local_image_id":image_id,"minio_binary_sha256":hashlib.sha256(args.minio_binary.read_bytes()).hexdigest(),"ready":True,"clean_stop":True,"wal_objects":wal_proof["count"],"wal_sha256":wal_proof["sha256"],"backup_state":backup["state"],"catalog_sha256":backup["catalog_sha256"],"backup_bytes":backup["bytes"],"ca_refresh_after_initial_expiry":True,"busy_tls_session_preserved":True,"matching_ready_timestamps":ready["readiness_at"] >= ready["postgres_started_at"],"same_uid_custody_sealed":True,"privileged_process_inspection_preserved":True,"inspector_executable_matches_attestation":all(inspector_executable_matches),"native_process_executable_identity_acceptance":False,"pending_bundle_replay":True,"complete_catalog_required":True,"backup_reconciled_without_replay":True,"controller_peer_tls":peer_proved,"kernel_mount_acceptance":False,"cloudflare_first_sql_acceptance":False}))
    finally:
        for container in reversed(containers): run("docker", "rm", "-f", container, check=False)
        for volume in reversed(volumes): run("docker", "volume", "rm", volume, check=False)
        run("docker", "network", "rm", network, check=False)
        run("docker", "image", "rm", minio_image, check=False)
        shutil.rmtree(fixture)


if __name__ == "__main__":
    main()
