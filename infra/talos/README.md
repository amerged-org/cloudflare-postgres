# Talos bootstrap assets

These first-party patches reproduce the configuration used by the disposable M1 lab. They target **Talos v1.14.1 with Kubernetes v1.36.3**. The latter is explicit because the selected CNPG release supports Kubernetes 1.36, while this Talos release otherwise defaults to a newer Kubernetes version. This directory is a reviewed bootstrap recipe, not yet an unattended fleet installer or a production topology.

The [live M1 record](../../docs/evidence/m1-2026-09-28.md) distinguishes the proven boot, storage, SQL, and restart behavior from the pending backup, replacement, and failover work. Two VPS in one data center do not prove independent failure domains.

## Private configuration

Install the matching `talosctl` from the [official release](https://github.com/siderolabs/talos/releases/tag/v1.14.1) and verify its published checksum. Generate machine configurations only in an ignored local directory, for example `.env.local.talos/`, with owner-only directory and file permissions. Generated configurations contain cluster CA keys and bootstrap credentials; none belong in this repository or an Image Factory schematic.

Copy `network.patch.example.yaml` to that private directory and replace its MAC, address, prefix, and gateway from the provider inventory and the actual rescue/guest network. Replace the schematic placeholders separately. Keep `eth0` only after verifying the NoCloud image's single-NIC naming; the selected image uses `net.ifnames=0`. Operator-selected DNS servers must agree between the first-boot schematic and durable network configuration.

Generate the initial control-plane configuration with explicit operator-provided cluster name, API endpoint and installation disk:

```sh
umask 077
mkdir -p .env.local.talos/config
talosctl gen config "$PGCF_CLUSTER_NAME" "$PGCF_KUBERNETES_API_ENDPOINT" \
  --talos-version v1.14.1 --kubernetes-version 1.36.3 \
  --install-disk "$PGCF_INSTALL_DISK" \
  --config-patch-control-plane @infra/talos/cilium.patch.yaml \
  --config-patch @infra/talos/single-disk-lab-storage.patch.yaml \
  --config-patch @.env.local.talos/network.patch.yaml \
  --config-patch-control-plane @infra/talos/single-node-lab-scheduling.patch.yaml \
  --output .env.local.talos/config
talosctl validate --mode cloud --strict \
  --config .env.local.talos/config/controlplane.yaml
chmod 600 .env.local.talos/config/*
```

The two `single-*-lab` patches are deliberately scoped to the measured one-node lab. Replace the disk allocation and scheduling policy for another node pool; do not silently apply these sizes to a smaller disk or schedule customer databases on a production control plane. EPHEMERAL must be capped before first provisioning. Changing `maxSize` does not shrink an already grown filesystem.

## Verified kubelet serving identity

The [native serving-TLS patch](kubelet-serving-tls.patch.yaml) enables
`KubeletConfig.config.serverTLSBootstrap` for the selected Talos 1.14 schema.
Merge it into the generated native document, preserving the pinned kubelet
image and other configuration. A local merge against the actual lab's 30
documents and strict validation pass; live application and automatic renewal
remain pending. Do not add deprecated kubelet fields alongside the native
document or substitute a nonexistent `serverCertExtraSANs` property.

Install the qualified [node-bound approver](../kubelet-serving-certificates/README.md)
and operator-owned enrollment before applying this change to a live node.
Initial application restarts kubelet and removes its old self-signed serving
files; the new serving endpoint waits for a signed CSR. Talos machine reboot is
not required, but availability and PostgreSQL preservation must be observed.
Kubelet subsequently loads renewed certificates dynamically. Preserve verified
TLS and scope enrollment to authenticated machine identities and addresses.

The [current TLS checkpoint](../../docs/evidence/m4-kubelet-serving-tls-2026-09-28.md)
distinguishes this prepared correction from an actual runtime success.

## Contabo rescue path

Contabo's custom-image storage was unavailable in the observed account. The verified alternative uses its RAM-based rescue system, a registered SSH public-key secret, and a checksum-verified NoCloud raw image from the [Image Factory](https://docs.siderolabs.com/talos/v1.14/learn-more/image-factory). The private static-network schematic can be used with different Talos versions, but the version and artifact checksum must be pinned for each run.

Before writing a disk, the operator must establish a recovery point, activate a provider firewall allowing the operator's current source address only to the bootstrap management ports, and test both operator access and denied access from another source over IPv4 and IPv6. Record a rescue host-key observation separately from the installed OS host key. Confirm the exact instance, MAC, address, gateway, one expected system disk and byte size, RAM-based rescue root, no target mounts, and no target swap. A mismatch stops the disk operation.

The performed imaging sequence removed the old GPT, streamed the verified raw image to the verified system disk, relocated the backup GPT to the actual disk end, and verified the four image partitions. After GPT relocation, the raw image's GPT header bytes intentionally differ: compare partition data rather than claiming that a whole-disk byte comparison should remain identical. Contabo's rescue `reboot` returns to the installed disk. These checks still need to become a fail-closed automated installer; this document does not make an arbitrary `dd` invocation safe.

On the first boot, the nonsecret network argument makes the encrypted but unauthenticated Talos maintenance API reachable through the restricted provider firewall. Read the disk inventory again, then apply the private configuration:

```sh
talosctl --nodes "$PGCF_NODE_ADDRESS" get disks --insecure
talosctl --nodes "$PGCF_NODE_ADDRESS" apply-config --insecure \
  --file .env.local.talos/config/controlplane.yaml
```

Use the generated `talosconfig` for subsequent authenticated calls. Read back STATE, the capped EPHEMERAL volume, the raw `r-pgcf-lvm` partition and writable `pgcf` LVM group. Prove that authenticated access and those resources survive a clean reboot before Kubernetes bootstrap or touching another server.

## Kubernetes and platform handoff

Invoke `talosctl bootstrap` exactly once against one control-plane node after recording the attempt. A timeout is an uncertain outcome, not permission to repeat it blindly. Save kubeconfig to an explicit ignored file with `--merge=false`; never overwrite or merge into an unrelated local Kubernetes context by default.

The CNI is intentionally absent at bootstrap. Install the pinned Cilium release promptly using the [platform baseline](../platform/README.md), then confirm Cilium, CoreDNS, Node Ready, one disposable Pod DNS check and Talos health. Flux subsequently owns platform releases; our regional controller owns customer namespaces and CNPG resources. Talos lifecycle jobs own host and Kubernetes upgrades. Flux does not patch the guest OS.

Sources: [Talos NoCloud](https://docs.siderolabs.com/talos/v1.14/platform-specific-installations/cloud-platforms/nocloud), [network kernel arguments](https://docs.siderolabs.com/talos/v1.14/reference/kernel), [raw volumes](https://docs.siderolabs.com/talos/v1.14/reference/configuration/block/rawvolumeconfig), [LVM groups](https://docs.siderolabs.com/talos/v1.14/reference/configuration/storage/lvmvolumegroupconfig), [lab control-plane scheduling](https://docs.siderolabs.com/talos/v1.14/deploy-and-manage-workloads/workloads-on-controlplane), [Contabo rescue](https://help.contabo.com/en/support/solutions/articles/103000295053-how-do-i-boot-a-rescue-system-for-my-server-).
