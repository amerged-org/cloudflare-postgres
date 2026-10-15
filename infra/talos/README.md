# Talos bootstrap assets

These first-party patches reproduce the configuration of the single-node Contabo lab. They target **Talos v1.14.2 with Kubernetes v1.36.5**; the Kubernetes version is explicit because the selected CNPG release supports 1.36, while this Talos release defaults to a newer one. The recipe has not been exercised with the Golden Talos 1.14.2 image (see the end of this file).

These examples are the manual recovery recipe; only the EU relay host still depends on it. The programmed path in [PLAN.md](../../PLAN.md) uses the `node-bootstrap` Container, a protected regional installation profile and measured provider/network/storage proofs; every region's control server follows the [control-server configuration](#control-server-configuration-per-region) below. The existing EU customer worker is already admitted and retained as EU1 (formerly EU2); do not reset, re-adopt or reinstall it. The existing EU control/relay server is excluded from new customer placement. The US region is cancelled; US and Oceania return later through the same configuration. The earlier EU1 loss and deletion kits are withheld. Node loss is recovered from R2. Installation and admission must finish before capacity becomes available; current Dev acceptance is recorded in PLAN.md.

## Private configuration

Install the matching `talosctl` from the [official release](https://github.com/siderolabs/talos/releases/tag/v1.14.2) and verify its published checksum. Generate machine configurations only in an ignored local directory, for example `.env.local.talos/`, with owner-only directory and file permissions. Generated configurations contain cluster CA keys and bootstrap credentials; none belong in this repository or an Image Factory schematic.

Copy `network.patch.example.yaml` to that private directory and replace its MAC, address, prefix, and gateway from the provider inventory and the actual rescue/guest network. Replace the schematic placeholders separately. Keep `eth0` only after verifying the NoCloud image's single-NIC naming; the selected image uses `net.ifnames=0`. Operator-selected DNS servers must agree between the first-boot schematic and durable network configuration.

Generate the initial control-plane configuration with explicit operator-provided cluster name, API endpoint and installation disk:

```sh
umask 077
mkdir -p .env.local.talos/config
awk '/^---$/ {exit} {print}' infra/talos/single-node-lab-scheduling.patch.yaml \
  > .env.local.talos/worker-reservations.patch.yaml
talosctl gen config "$PGCF_CLUSTER_NAME" "$PGCF_KUBERNETES_API_ENDPOINT" \
  --talos-version v1.14.2 --kubernetes-version 1.36.5 \
  --install-disk "$PGCF_INSTALL_DISK" \
  --config-patch-control-plane @infra/talos/cilium.patch.yaml \
  --config-patch @infra/talos/single-disk-lab-storage.patch.yaml \
  --config-patch @.env.local.talos/network.patch.yaml \
  --config-patch-control-plane @infra/talos/single-node-lab-scheduling.patch.yaml \
  --config-patch-worker @.env.local.talos/worker-reservations.patch.yaml \
  --output .env.local.talos/config
talosctl validate --mode cloud --strict \
  --config .env.local.talos/config/controlplane.yaml
chmod 600 .env.local.talos/config/*
```

The `single-disk-lab-storage` patch uses the measured lab disk allocation; review its sizes for every target disk. EPHEMERAL must be capped before first provisioning. Changing `maxSize` does not shrink an already grown filesystem.

The scheduling patch uses Talos 1.14's [KubeletConfig](https://docs.siderolabs.com/talos/v1.14/reference/configuration/kubernetes/kubeletconfig) `config` field. Its first document applies to both node roles: `systemReserved` reserves 500 millicores and 512 MiB for host daemons; `kubeReserved` reserves another 500 millicores and 512 MiB for kubelet and the container runtime. The complete `systemReserved` map also preserves Talos 1.14.2's defaults of 100 process IDs and 256 MiB of ephemeral storage. Talos supplies its default map only when the map is empty, so omitting those keys would remove their reservations; see the pinned [renderer](https://github.com/siderolabs/talos/blob/v1.14.2/internal/app/machined/pkg/controllers/k8s/kubelet_spec.go) and [constants](https://github.com/siderolabs/talos/blob/v1.14.2/pkg/machinery/constants/constants.go). The chosen memory value retains the control-plane default and increases the worker default from 384 MiB to 512 MiB. These are initial operator settings, not measured workload requirements. Kubernetes subtracts them, together with its eviction reservation, from Node allocatable. Read back the effective kubelet configuration and Node capacity/allocatable after boot; stop admission if the node cannot provide these reserves and the measured platform workload requests.

The generated worker patch contains only that first document. The second document removes the control-plane taint so platform Pods can run on a control-plane node; it must not be applied to a worker. Removing that taint does not authorize new customer placement on a region's control server: its separate database-placement flag must remain disabled. API-server, scheduler, controller-manager and etcd static Pods are not covered by these non-Pod daemon reserves. The regional controller separately subtracts the requests of every non-database Pod on the node, including control-plane and platform Pods, from allocatable memory. Do not include those same Pod requests in `kubeReserved` or subtract the host/daemon reserves again in the controller. Confirm the actual platform requests and control-plane load in Dev before admitting databases. See [Kubernetes resource reservation](https://kubernetes.io/docs/tasks/administer-cluster/reserve-compute-resources/).

## Contabo rescue path

Contabo's custom-image storage was unavailable in the observed account. The verified alternative uses its RAM-based rescue system, a registered SSH public-key secret, and a checksum-verified NoCloud raw image from the [Image Factory](https://docs.siderolabs.com/talos/v1.14/learn-more/image-factory). The private static-network schematic can be used with different Talos versions, but the version and artifact checksum must be pinned for each run.

Before writing a disk, the operator must establish a recovery point, activate a provider firewall allowing the operator's current source address only to the bootstrap management ports, and test both operator access and denied access from another source over IPv4 and IPv6. Record a rescue host-key observation separately from the installed OS host key. Confirm the exact instance, MAC, address, gateway, one expected system disk and byte size, RAM-based rescue root, no target mounts, and no target swap. A mismatch stops the disk operation.

The earlier manual imaging sequence removed the old GPT, streamed the verified raw image to the verified system disk, relocated the backup GPT to the actual disk end, and verified the four image partitions. After GPT relocation, the raw image's GPT header bytes intentionally differ: compare partition data rather than claiming that a whole-disk byte comparison should remain identical. Contabo's rescue `reboot` returns to the installed disk. The native installer implements checkpointed image writes, resumed byte verification and GPT/partition checks under the protected installation input and fresh preparation proof. This manual recipe does not authorize an arbitrary `dd` invocation or replace that programmed flow's live acceptance.

On the first boot, the nonsecret network argument makes the encrypted but unauthenticated Talos maintenance API reachable through the restricted provider firewall. Read the disk inventory again, then apply the private configuration:

```sh
talosctl --nodes "$PGCF_NODE_ADDRESS" get disks --insecure
talosctl --nodes "$PGCF_NODE_ADDRESS" apply-config --insecure \
  --file .env.local.talos/config/controlplane.yaml
```

Use the generated `talosconfig` for subsequent authenticated calls. Read back STATE, the capped EPHEMERAL volume, the raw `r-pgcf-lvm` partition and writable `pgcf` LVM group. Prove that authenticated access and those resources survive a clean reboot before Kubernetes bootstrap or touching another server.

## Kubernetes and platform handoff

Invoke `talosctl bootstrap` exactly once against one control-plane node after recording the attempt. A timeout is an uncertain outcome, not permission to repeat it blindly. Save kubeconfig to an explicit ignored file with `--merge=false`; never overwrite or merge into an unrelated local Kubernetes context by default.

The CNI is intentionally absent at bootstrap. Install the pinned Cilium release promptly using the [platform baseline](../platform/README.md), then confirm Cilium, CoreDNS, Node Ready, one disposable Pod DNS check and Talos health. Flux subsequently owns platform releases; the regional controller owns per-database namespaces and CNPG resources. Talos lifecycle jobs own host and Kubernetes upgrades. Flux does not patch the guest OS.

Before joining another node, apply the exact peer-address allowlist for Talos, Kubernetes, kubelet, control-plane etcd and CNI traffic. The [ULTRA delivery plan](../../docs/architecture/cloudflare-convergence-and-serverless-plan.md#delivery-architecture) retains restricted management access and Cloudflare-only database ingress. The platform baseline requests Cilium WireGuard encryption for inter-node Pod traffic. Verify the encryption peers and traffic before admitting the new node for customer database placement; no cluster port may become world reachable. The checked-in configuration does not prove that encryption is deployed or that this two-node acceptance has passed.

Sources: [Talos NoCloud](https://docs.siderolabs.com/talos/v1.14/platform-specific-installations/cloud-platforms/nocloud), [network kernel arguments](https://docs.siderolabs.com/talos/v1.14/reference/kernel), [raw volumes](https://docs.siderolabs.com/talos/v1.14/reference/configuration/block/rawvolumeconfig), [LVM groups](https://docs.siderolabs.com/talos/v1.14/reference/configuration/storage/lvmvolumegroupconfig), [control-plane scheduling](https://docs.siderolabs.com/talos/v1.14/deploy-and-manage-workloads/workloads-on-controlplane), [Contabo rescue](https://help.contabo.com/en/support/solutions/articles/103000295053-how-do-i-boot-a-rescue-system-for-my-server-).

A selected fleet release binds its initial disk in `talos_raw_image` (`url`, compressed
`sha256`/`bytes`, `format`, and `raw_sha256`/`raw_bytes`). AddNode inspection, composition
and disk installation preserve that exact approved release identity and its customer-role
installer. A selected release without this artifact is rejected; Image Factory fallback
is available only before a region selects a release.

The common raw image contains no node addresses or keys. For the qualified NoCloud/GRUB
layout, after full raw/GPT verification the provisioner configures only the default A boot
entry with its existing fresh hardware network arguments. It compares the live kernel and
initramfs with the immutable reference, preserves the Reset entry, writes the one known
GRUB file atomically and reads it back. A committed file is skipped after interruption;
unexpected file content stops execution. GPT and the other partitions remain verified.
The transient mounts are outside the image staging filesystem and are checked against
exact backing-file offsets before cleanup. Cluster custody is generated or selected through
the existing sealed configuration flow after boot, outside the image.

## Control-server configuration (per region)

Every region has exactly one control server and identical customer workers; the
[ULTRA delivery architecture](../../docs/architecture/cloudflare-convergence-and-serverless-plan.md#delivery-architecture)
describes the model and the
[new-region runbook](../../docs/operations/operator-installation.md#control-server-of-a-new-region)
the order of the steps. A US or Oceania control server uses exactly these parameters and the
same Golden release as every other node. EU control is additionally the installation's single
bootstrap relay host for all regions; no other control server runs the relay.

| Parameter                     | Where it is set                                                                                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Region record                 | `POST /v1/regions`                                                                               | A new `id`, `provider:"contabo"`, the Contabo `provider_region` of every member, `gateway_url` `http://pgcf-gateway.pgcf-system.svc.cluster.local:8080/pg`, the Edge VPC binding name `gateway_binding`, `backup_bucket` and `backup_endpoint_url`. The response returns the agent key and route keyring once.                                                                                                                                                                                                        |
| Archive                       | API Worker configuration                                                                         | An `ARCHIVE_<NAME>` R2 binding and the region's `ARCHIVE_BINDINGS` entry for that binding and bucket; a bucket-scoped R2 S3 write credential for `backup_s3`.                                                                                                                                                                                                                                                                                                                                                         |
| Database ingress              | Cloudflare Tunnel and Edge Worker                                                                | One regional Tunnel, whose token goes into the profile, and an Edge VPC service binding named by `gateway_binding`. No VPS exposes a PostgreSQL port.                                                                                                                                                                                                                                                                                                                                                                 |
| Installation profile          | `PUT /v1/regions/{id}/installation-profile`, write-once                                          | `provider_product_id`; `relay_issuer_region_id` equal to the relay's issuer region; `dns`; `storage:{ephemeral_gib,lvm_gib}`; `rescue_client_private_key`; `first_region:{cluster_name,reviewed_commit,regional_image,platform}` with the issued agent key, route keyring, Tunnel token and `backup_s3`.                                                                                                                                                                                                              |
| Release and templates         | `PUT /v1/regions/{id}/release`, `PUT /v1/regions/{id}/capacity-policy`                           | The fleet's current approved release; a release-pinned `compute_pool` template, which also switches the region's pool runtime on; a `thin_storage` template byte-identical to the release's qualified profile.                                                                                                                                                                                                                                                                                                        |
| Machine configuration         | Generated by the native installer                                                                | Talos role `controlplane` for the region's first live node; endpoint `https://<IPv4>:6443`; measured MAC, IPv4 address, prefix and gateway, and IPv6; profile DNS with host DNS forwarding; PGCF node labels; the quarantine taint until admission; EPHEMERAL, `pgcf-lvm` and VG `pgcf` from `storage`; `dm_thin_pool` for postjoin releases; the kubelet reservations of the scheduling patch; control-plane taint removed, Flannel and kube-proxy disabled, KubePrism on port 7445; the release's Golden installer. |
| Cluster authority             | Native installer and Cloudflare custody                                                          | Fresh Talos and Kubernetes secrets per region, sealed as region seed and join bundle revision 1. Replacements are staged with `POST /v1/regions/{id}/bootstrap-material/stage` and activated by a rollout's `staged_material_revision`.                                                                                                                                                                                                                                                                               |
| Firewall and operator sources | `BOOTSTRAP_OPERATOR_SOURCES`, `BOOTSTRAP_FIREWALL_BINDINGS`, generated by AddNode                | Operator CIDRs and the relay addresses reach TCP 22, 50000 and 6443; exact region peers reach TCP 6443, 50000, 50001, 10250 and 4240 and UDP 8472 and 51871; ICMP only from the IPv6 gateway. Every addition rewrites all members' rules.                                                                                                                                                                                                                                                                             |
| Relay scope                   | EU relay configuration                                                                           | `PGCF_BOOTSTRAP_RELAY_ALLOWED_TARGET_REGIONS` lists the region ID.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Fleet settings                | `PUT /v1/nodes/{id}/database-placement`, `PUT /v1/nodes/{id}/release` or the rollout member role | Placement `false`; fleet role `control_relay`; a release-pinned compute-pool policy with `target_slots:0` when the role requires host configuration.                                                                                                                                                                                                                                                                                                                                                                  |

The relay add-on runs only on EU control from [`../platform/bootstrap-relay`](../platform/bootstrap-relay/README.md)
with its node name, issuer region, public keys, allowed target regions and dedicated Tunnel
token; the API's `BOOTSTRAP_RELAY_*` settings point at it, and AddNode never targets the relay
host. EU control was installed with the manual recipe above before the programmed path existed.
Fleet releases converge its software, role pins and host files, but its machine configuration
predates the generated template, and only the manual recipe can rebuild it. That recipe has not
been exercised with the Golden Talos 1.14.2 image.
