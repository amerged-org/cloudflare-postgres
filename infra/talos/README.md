# Talos bootstrap assets

These first-party patches reproduce the configuration of the single-node Contabo lab. They target **Talos v1.14.1 with Kubernetes v1.36.3**; the Kubernetes version is explicit because the selected CNPG release supports 1.36, while this Talos release defaults to a newer one. Boot, storage, SQL and node-restart behavior worked in the lab.

This is the manual recipe. In Phase 3 of [PLAN.md](../../PLAN.md), the `node-bootstrap` Container automates the same rescue path: a worker joins an existing region, while a new region bootstraps its first control-plane/worker. The initial topology has one EU control-plane/worker plus one EU worker and one US control-plane/worker. Customer databases run on these control-plane/worker nodes with system and platform resources reserved. Node loss is recovered from R2.

## Private configuration

Install the matching `talosctl` from the [official release](https://github.com/siderolabs/talos/releases/tag/v1.14.1) and verify its published checksum. Generate machine configurations only in an ignored local directory, for example `.env.local.talos/`, with owner-only directory and file permissions. Generated configurations contain cluster CA keys and bootstrap credentials; none belong in this repository or an Image Factory schematic.

Copy `network.patch.example.yaml` to that private directory and replace its MAC, address, prefix, and gateway from the provider inventory and the actual rescue/guest network. Replace the schematic placeholders separately. Keep `eth0` only after verifying the NoCloud image's single-NIC naming; the selected image uses `net.ifnames=0`. Operator-selected DNS servers must agree between the first-boot schematic and durable network configuration.

Generate the initial control-plane configuration with explicit operator-provided cluster name, API endpoint and installation disk:

```sh
umask 077
mkdir -p .env.local.talos/config
awk '/^---$/ {exit} {print}' infra/talos/single-node-lab-scheduling.patch.yaml \
  > .env.local.talos/worker-reservations.patch.yaml
talosctl gen config "$PGCF_CLUSTER_NAME" "$PGCF_KUBERNETES_API_ENDPOINT" \
  --talos-version v1.14.1 --kubernetes-version 1.36.3 \
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

The scheduling patch uses Talos 1.14's [KubeletConfig](https://docs.siderolabs.com/talos/v1.14/reference/configuration/kubernetes/kubeletconfig) `config` field. Its first document applies to both node roles: `systemReserved` reserves 500 millicores and 512 MiB for host daemons; `kubeReserved` reserves another 500 millicores and 512 MiB for kubelet and the container runtime. The complete `systemReserved` map also preserves Talos 1.14.1's defaults of 100 process IDs and 256 MiB of ephemeral storage. Talos supplies its default map only when the map is empty, so omitting those keys would remove their reservations; see the pinned [renderer](https://github.com/siderolabs/talos/blob/v1.14.1/internal/app/machined/pkg/controllers/k8s/kubelet_spec.go) and [constants](https://github.com/siderolabs/talos/blob/v1.14.1/pkg/machinery/constants/constants.go). The chosen memory value retains the control-plane default and increases the worker default from 384 MiB to 512 MiB. These are initial operator settings, not measured workload requirements. Kubernetes subtracts them, together with its eviction reservation, from Node allocatable. Read back the effective kubelet configuration and Node capacity/allocatable after boot; stop admission if the node cannot provide these reserves and the measured platform workload requests.

The generated worker patch contains only that first document. The second document removes the control-plane taint on the initial EU and US control-plane/worker nodes; it must not be applied to a worker. API-server, scheduler, controller-manager and etcd static Pods are not covered by these non-Pod daemon reserves. The agent separately subtracts the requests of every non-database Pod on the node, including control-plane and platform Pods, from allocatable memory. Do not include those same Pod requests in `kubeReserved` or subtract the host/daemon reserves again in the agent. Confirm the actual platform requests and control-plane load in Dev before admitting databases. See [Kubernetes resource reservation](https://kubernetes.io/docs/tasks/administer-cluster/reserve-compute-resources/).

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

The CNI is intentionally absent at bootstrap. Install the pinned Cilium release promptly using the [platform baseline](../platform/README.md), then confirm Cilium, CoreDNS, Node Ready, one disposable Pod DNS check and Talos health. Flux subsequently owns platform releases; the regional agent owns per-database namespaces and CNPG resources. Talos lifecycle jobs own host and Kubernetes upgrades. Flux does not patch the guest OS.

Before joining another node in Phase 3, apply the exact peer-address allowlist for Talos, Kubernetes, kubelet, control-plane etcd and CNI traffic described in [PLAN.md section 6](../../PLAN.md#6-security-and-isolation). The platform baseline requests Cilium WireGuard encryption for inter-node Pod traffic. Verify the encryption peers and traffic before admitting the new node for customer database placement; no cluster port may become world reachable. The checked-in configuration does not prove that encryption is deployed or that this two-node acceptance has passed.

Sources: [Talos NoCloud](https://docs.siderolabs.com/talos/v1.14/platform-specific-installations/cloud-platforms/nocloud), [network kernel arguments](https://docs.siderolabs.com/talos/v1.14/reference/kernel), [raw volumes](https://docs.siderolabs.com/talos/v1.14/reference/configuration/block/rawvolumeconfig), [LVM groups](https://docs.siderolabs.com/talos/v1.14/reference/configuration/storage/lvmvolumegroupconfig), [control-plane scheduling](https://docs.siderolabs.com/talos/v1.14/deploy-and-manage-workloads/workloads-on-controlplane), [Contabo rescue](https://help.contabo.com/en/support/solutions/articles/103000295053-how-do-i-boot-a-rescue-system-for-my-server-).
