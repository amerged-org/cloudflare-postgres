// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
export const POOL_WORKLOAD_PROBE_MODE = "isolation-probe";
export const POOL_WORKLOAD_PROBE_RESULTS = [
  "unshare_mount",
  "unshare_user",
  "unshare_pid",
  "unshare_ipc",
  "unshare_net",
  "unshare_uts",
  "unshare_cgroup",
  "unshare_time",
  "setns_own_mount",
  "clone_mount",
  "clone_user",
  "clone_pid",
  "clone_ipc",
  "clone_net",
  "clone_uts",
  "clone_cgroup",
  "clone3",
  "mount_missing_target",
  "fsopen_ext4",
  "open_tree_clone_root",
] as const;
const Errno = z.number().int().min(1).max(4095).nullable();
export const PoolWorkloadIsolationProbe = z.strictObject({
  v: z.literal(1),
  uid: z.number().int().nonnegative().max(4294967295),
  cap_eff: z.string().regex(/^[a-fA-F0-9]{16}$/),
  cap_sys_admin: z.boolean(),
  seccomp_mode: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  no_new_privs: z.boolean(),
  observed_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  results: z.strictObject(
    Object.fromEntries(
      POOL_WORKLOAD_PROBE_RESULTS.map((name) => [name, Errno]),
    ) as Record<(typeof POOL_WORKLOAD_PROBE_RESULTS)[number], typeof Errno>,
  ),
});
export type PoolWorkloadIsolationProbe = z.infer<
  typeof PoolWorkloadIsolationProbe
>;
/** Raw failures remain reportable; only actual policy denials qualify the fixed workload. */
export function poolWorkloadProbeSafe(
  probe: PoolWorkloadIsolationProbe,
): boolean {
  return (
    probe.uid === 26 &&
    /^0{16}$/.test(probe.cap_eff) &&
    !probe.cap_sys_admin &&
    probe.seccomp_mode === 2 &&
    probe.no_new_privs &&
    POOL_WORKLOAD_PROBE_RESULTS.every(
      (name) =>
        probe.results[name] === 1 ||
        probe.results[name] === 13 ||
        (name === "clone3" && probe.results[name] === 38),
    )
  );
}
