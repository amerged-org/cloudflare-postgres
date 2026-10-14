#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Owned, isolated real kube-apiserver/etcd fixture; never connects to a user's cluster."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

API_IMAGE = "registry.k8s.io/kube-apiserver:v1.36.5@sha256:78487f7b4b1a588d9630f758f6677895eabe00d93c4cbbea3d6b06e5f476a371"
ETCD_IMAGE = "registry.k8s.io/etcd:3.6.8-0@sha256:aa2b41e3f99c9a337b82f687875a63c5119e6d39bc43fc76b6c40a96f55cf391"
RUST_IMAGE = "docker.io/library/rust:1.99.0-alpine3.24@sha256:0cce0a5e0e8ba67b455257a3a02a1d99005f382748789d6464460028810f1627"
LABEL = "pgcf.test.fixture"

def command(args, *, output=False):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise RuntimeError("Fixture command failed: " + args[0])
    return result.stdout if output else None

def write_private(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(value)

def openssl(*args):
    command(["openssl", *map(str, args)])

def load_metadata(path):
    expected=Path(__file__).resolve().parents[3]/".local"/"kube-fixtures"
    if path.name!="fixture.json" or path.parent.parent!=expected or not path.parent.name.startswith("pgcf-pool-kube-") or path.is_symlink():
        raise RuntimeError("Fixture custody path changed")
    if path.parent.stat().st_mode & 0o777 != 0o700 or path.stat().st_mode & 0o777 != 0o600:
        raise RuntimeError("Fixture custody mode changed")
    metadata=json.loads(path.read_text())
    identity=metadata.get("id","")
    if len(identity)!=32 or any(c not in "0123456789abcdef" for c in identity):
        raise RuntimeError("Fixture identity changed")
    for role,prefix in (("api","pgcf-pool-api-"),("etcd","pgcf-pool-etcd-"),("network","pgcf-pool-kube-")):
        if metadata.get(role)!=prefix+identity:
            raise RuntimeError("Fixture resource name changed")
    if metadata.get("origin")!="https://"+metadata["api"]+":6443/" or metadata.get("api_image")!=API_IMAGE or metadata.get("etcd_image")!=ETCD_IMAGE:
        raise RuntimeError("Fixture endpoint or source changed")
    if metadata.get("ca_file")!=str(path.parent/"ca.crt") or metadata.get("token_file")!=str(path.parent/"token"):
        raise RuntimeError("Fixture custody file changed")
    for name in ("ca.crt","token","admin.tokens","server.key","sa.key"):
        candidate=path.parent/name
        if candidate.is_symlink() or candidate.stat().st_mode & 0o777 != 0o600:
            raise RuntimeError("Fixture custody mode changed")
    return metadata

def owned(metadata):
    for role in ("api", "etcd"):
        actual = json.loads(command(["docker", "inspect", metadata[role]], output=True))[0]
        if actual["Id"] != metadata[role + "_id"] or actual["Config"]["Labels"].get(LABEL) != metadata["id"] or actual["Config"]["Image"]!=metadata[role+"_image"]:
            raise RuntimeError("Fixture container ownership changed")
    actual = json.loads(command(["docker", "network", "inspect", metadata["network"]], output=True))[0]
    if actual["Id"] != metadata["network_id"] or actual["Labels"].get(LABEL) != metadata["id"]:
        raise RuntimeError("Fixture network ownership changed")

def stop(path):
    metadata = load_metadata(path)
    owned(metadata)
    for role in ("api", "etcd"):
        command(["docker", "rm", "-f", metadata[role + "_id"]])
    command(["docker", "network", "rm", metadata["network_id"]])
    shutil.rmtree(path.parent)
    print(json.dumps({"fixture": "removed"}))

def start():
    fixture_id = uuid.uuid4().hex
    fixture_parent=Path(__file__).resolve().parents[3]/".local"/"kube-fixtures"
    fixture_parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    fixture_parent.chmod(0o700)
    root = Path(tempfile.mkdtemp(prefix="pgcf-pool-kube-",dir=fixture_parent))
    root.chmod(0o700)
    api, etcd, network = ("pgcf-pool-api-" + fixture_id, "pgcf-pool-etcd-" + fixture_id, "pgcf-pool-kube-" + fixture_id)
    # Files are test-only generated custody; nothing from a user environment is read.
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=PGCF isolated pool test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", root/"ca.key", "-out", root/"ca.crt")
    openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", root/"server.key", "-out", root/"server.csr")
    write_private(root/"san.conf", "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,DNS:" + api + ",IP:127.0.0.1\n")
    openssl("x509", "-req", "-in", root/"server.csr", "-CA", root/"ca.crt", "-CAkey", root/"ca.key", "-CAcreateserial", "-days", "1", "-extfile", root/"san.conf", "-out", root/"server.crt")
    openssl("genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", root/"sa.key")
    openssl("pkey", "-in", root/"sa.key", "-pubout", "-out", root/"sa.pub")
    token = secrets.token_urlsafe(48)
    write_private(root/"token", token)
    write_private(root/"admin.tokens", token + ',pool-test-admin,pool-test-admin,"system:masters"\n')
    for path in root.iterdir():
        path.chmod(0o600)
    resources = []
    try:
        network_id = command(["docker", "network", "create", "--label", LABEL + "=" + fixture_id, network], output=True).decode().strip()
        resources.append(("network", network_id))
        etcd_id = command(["docker", "run", "-d", "--platform", "linux/amd64", "--name", etcd, "--network", network, "--label", LABEL+"="+fixture_id, ETCD_IMAGE, "etcd", "--name=default", "--listen-client-urls=http://0.0.0.0:2379", "--advertise-client-urls=http://"+etcd+":2379", "--data-dir=/tmp/etcd"], output=True).decode().strip()
        resources.append(("container", etcd_id))
        api_id = command(["docker", "run", "-d", "--platform", "linux/amd64", "--name", api, "--network", network, "--label", LABEL+"="+fixture_id, "-p", "127.0.0.1::6443", "-v", str(root)+":/tls:ro", API_IMAGE, "/usr/local/bin/kube-apiserver", "--etcd-servers=http://"+etcd+":2379", "--service-cluster-ip-range=10.88.0.0/24", "--secure-port=6443", "--advertise-address=127.0.0.1", "--tls-cert-file=/tls/server.crt", "--tls-private-key-file=/tls/server.key", "--client-ca-file=/tls/ca.crt", "--token-auth-file=/tls/admin.tokens", "--service-account-key-file=/tls/sa.pub", "--service-account-signing-key-file=/tls/sa.key", "--service-account-issuer=https://pool-test.invalid", "--authorization-mode=RBAC", "--anonymous-auth=false"], output=True).decode().strip()
        resources.append(("container", api_id))
        inspect = json.loads(command(["docker", "inspect", api], output=True))[0]
        port = int(inspect["NetworkSettings"]["Ports"]["6443/tcp"][0]["HostPort"])
        context = ssl.create_default_context(cafile=str(root/"ca.crt"))
        until = time.monotonic() + 90
        while True:
            state=json.loads(command(["docker","inspect",api],output=True))[0]["State"]
            if not state["Running"]:
                logs=subprocess.run(["docker","logs",api],capture_output=True)
                diagnostic=(logs.stdout+logs.stderr).decode(errors="replace")
                import re
                errors=re.findall(r'err="([^"]+)"',diagnostic)
                selected=[]
                for error in errors:
                    error=re.sub(r'(?:\d{1,3}\.){3}\d{1,3}','[IP]',error)
                    error=re.sub(r'[A-Za-z0-9_+/=-]{40,}','[VALUE]',error)
                    if error.startswith(("failed to parse ","invalid argument ","unknown flag ","unable to ")):
                        selected.append(error[:256])
                print(json.dumps({"fixture":"startup_failed","selected_process_errors":selected,"exit_code":state["ExitCode"]}))
                raise RuntimeError("Isolated Kubernetes API exited")
            try:
                request = urllib.request.Request("https://localhost:"+str(port)+"/readyz", headers={"Authorization":"Bearer "+token})
                with urllib.request.urlopen(request, context=context, timeout=2) as reply:
                    if reply.read(128).strip() == b"ok":
                        break
            except (OSError, urllib.error.HTTPError):
                if time.monotonic() > until:
                    raise RuntimeError("Isolated Kubernetes API did not become ready")
                time.sleep(0.5)
        metadata = {"id":fixture_id,"api":api,"etcd":etcd,"network":network,"api_id":api_id,"etcd_id":etcd_id,"network_id":network_id,"origin":"https://"+api+":6443/","ca_file":str(root/"ca.crt"),"token_file":str(root/"token"),"host_port":port,"api_image":API_IMAGE,"etcd_image":ETCD_IMAGE}
        path=root/"fixture.json"
        write_private(path,json.dumps(metadata))
        print(json.dumps({"fixture":"ready","metadata":str(path),"api_image":API_IMAGE,"etcd_image":ETCD_IMAGE}))
        return path
    except Exception:
        for kind, identity in reversed(resources):
            if kind == "container":
                command(["docker","rm","-f",identity])
            else:
                command(["docker","network","rm",identity])
        shutil.rmtree(root)
        raise

def run(path, worktree, target, target_dir):
    if not target_dir or len(target_dir)>96 or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-/" for c in target_dir) or ".." in target_dir:
        raise RuntimeError("Fixture target directory invalid")
    metadata=load_metadata(path)
    owned(metadata)
    root=path.parent
    args=["docker","run","--rm","--platform","linux/amd64","--network",metadata["network"],"-e","CARGO_HOME=/cargo","-e","CARGO_TARGET_DIR=/target/"+target_dir,"-e","CARGO_PROFILE_DEV_DEBUG=0","-e","CARGO_PROFILE_TEST_DEBUG=0","-e","CARGO_INCREMENTAL=0","-e","PGCF_POOL_TEST_ORIGIN="+metadata["origin"],"-e","PGCF_POOL_TEST_CA=/fixture/ca.crt","-e","PGCF_POOL_TEST_TOKEN=/fixture/token","-e","PGCF_POOL_TEST_ATTEMPT="+uuid.uuid4().hex,"-v",str(worktree)+":/repo","-v",str(root)+":/fixture:ro","-v","pgcf-diag-cargo-amd64:/cargo","-v",target+":/target","-w","/repo",RUST_IMAGE,"sh","-c","apk add --no-cache musl-dev >/dev/null && cargo run --locked -p pgcf-native-controller --example pool-kubernetes"]
    # The executable reports only fixed public check names; a failed command is not printed raw.
    result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if result.returncode:
        lines=result.stderr.decode(errors="replace").splitlines()
        safe=[line for line in lines if line.startswith("error[") or line.startswith("error: could not compile") or line.startswith('Error: "isolated ' ) or line.startswith('Error: "pool ' ) or line.startswith("Error: KubernetesError")]
        print(json.dumps({"fixture":"check_failed","compiler_errors":safe}))
        raise RuntimeError("Actual Kubernetes fixture check failed")
    print(result.stdout.decode().strip())

if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode",choices=["start","run","stop"])
    parser.add_argument("--metadata",type=Path)
    parser.add_argument("--worktree",type=Path,default=Path(__file__).resolve().parents[3])
    parser.add_argument("--target-volume",default="pgcf-diag-target-amd64")
    parser.add_argument("--target-dir",default="warm-pool-routing-kubernetes")
    args=parser.parse_args()
    try:
        if args.mode=="start":start()
        elif args.metadata is None:parser.error("--metadata is required")
        elif args.mode=="stop":stop(args.metadata.resolve())
        else:run(args.metadata.resolve(),args.worktree.resolve(),args.target_volume,args.target_dir)
    except Exception as error:
        # No subprocess body, credentials, addresses or API payload are emitted.
        print(json.dumps({"fixture":"failed","reason":type(error).__name__,"stage":str(error) if isinstance(error,RuntimeError) else "fixture_error"}))
        raise SystemExit(1)
