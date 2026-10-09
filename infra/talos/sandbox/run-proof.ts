// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, chmod, open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
export function proofDockerArguments(
  image: string,
  name: string,
  architecture: "amd64" | "arm64" = "amd64",
) {
  return [
    "run",
    "--pull",
    "never",
    "--name",
    name,
    "--platform",
    "linux/" + architecture,
    "--network",
    "none",
    "--privileged",
    "--cgroupns",
    "private",
    "--memory",
    "768m",
    "--cpus",
    "2",
    "--pids-limit",
    "256",
    image,
  ];
}
async function invoke(args: string[], log: string, timeout: number) {
  const file = await open(log, "w", 0o600);
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn("docker", args, {
        stdio: ["ignore", file.fd, file.fd],
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code ?? 137);
      });
    });
  } finally {
    await file.close();
  }
}
export async function runSandboxProof() {
  const lock = JSON.parse(
      await readFile(
        new URL("../../platform/versions.lock.json", import.meta.url),
        "utf8",
      ),
    ) as {
      nativeRuntime: { testBuilderImage: string; rustVersion: string };
      regional: { postgresImage: { reference: string } };
    },
    directory = await mkdtemp(join(tmpdir(), "pgcf-public-sandbox-proof-"));
  await chmod(directory, 0o700);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12),
    image = "pgcf-sandbox-proof:" + suffix,
    name = "pgcf-sandbox-proof-" + suffix;
  let stage = "proof_native_platform";
  try {
    if (
      (await invoke(
        ["info", "--format", "{{.Architecture}}"],
        join(directory, "platform.private.log"),
        30000,
      )) !== 0
    )
      throw Error(stage);
    const host = (
        await readFile(join(directory, "platform.private.log"), "utf8")
      ).trim(),
      architecture =
        host === "x86_64" ? "amd64" : host === "aarch64" ? "arm64" : undefined;
    if (!architecture) throw Error(stage);
    const artifacts =
      architecture === "amd64"
        ? {
            containerd:
              "96eece214bedf3b77d2c2fd04245baaa3de36a1be1d10addf358dca71ae876d2",
            runc: "599f6f94ff8c5057241eff0d54c3c74f95c34935b6457b33fe545defc61e9488",
          }
        : {
            containerd:
              "b188111644bf19c3f482f0f0d4b7b93461a3653e60521289519cc474f5bce511",
            runc: "d10ecae898361832a059be2089bab92d158aec54661b18ed7346ed79628b46b0",
          };
    stage = "proof_build";
    let exit = await invoke(
      [
        "build",
        "--platform",
        "linux/" + architecture,
        "--build-arg",
        `RUST_BUILDER=${lock.nativeRuntime.testBuilderImage}`,
        "--build-arg",
        `RUST_VERSION=${lock.nativeRuntime.rustVersion}`,
        "--build-arg",
        `POSTGRES_FIXTURE=${lock.regional.postgresImage.reference}`,
        "--build-arg",
        `CONTAINERD_ASSET=https://github.com/containerd/containerd/releases/download/v2.3.6/containerd-static-2.3.6-linux-${architecture}.tar.gz`,
        "--build-arg",
        `CONTAINERD_SHA256=${artifacts.containerd}`,
        "--build-arg",
        `RUNC_ASSET=https://github.com/opencontainers/runc/releases/download/v1.5.2/runc.${architecture}`,
        "--build-arg",
        `RUNC_SHA256=${artifacts.runc}`,
        "-f",
        "infra/talos/sandbox/RuntimeProof.Dockerfile",
        "-t",
        image,
        ".",
      ],
      join(directory, "build.private.log"),
      900000,
    );
    if (exit !== 0) throw Error(stage);
    stage = "proof_runtime";
    exit = await invoke(
      proofDockerArguments(image, name, architecture),
      join(directory, "runtime.private.log"),
      150000,
    );
    if (exit !== 0) throw Error(stage);
    const lines = (
        await readFile(join(directory, "runtime.private.log"), "utf8")
      )
        .trim()
        .split("\n"),
      result = JSON.parse(lines.at(-1)!);
    const evidence = result.evidence as {
      assignment_mode: string;
      assignment_ms: number;
    }[];
    if (
      result.CF_CRI_CNI_CNPG_SQL_acceptance !== false ||
      ![
        "actual_separate_CRI_PID_and_mount_context",
        "actual_process_restart_recovers_same_assigned_PID_and_discards_unassigned",
        "expired_lease_retires_idle_preserves_running_tenant",
        "idle_cgroup_limits_observed",
        "all_tasks_deleted",
        "bounded_on_demand_miss_verified_separately",
        "actual_PostgreSQL_18_6_long_SQL_stopped_without_CF_or_Kube_API",
        "material_revision_reload_preserves_running_SQL_and_expiry",
        "retired_physical_scope_survives_normal_CRI_remove_and_restart",
        "readonly_reclaimer_host_CRI_PID_mapping_verified",
        "unprivileged_reclaimer_private_inputs_and_controls_denied",
      ].every((key) => result[key] === true) ||
      evidence.filter((x) => x.assignment_mode === "prestarted").length !== 2 ||
      evidence.filter((x) => x.assignment_mode === "on_demand").length !== 1 ||
      evidence.some(
        (x) => !Number.isFinite(x.assignment_ms) || x.assignment_ms < 0,
      ) ||
      !Number.isFinite(result.storage_expiry_stop_ms) ||
      result.storage_expiry_stop_ms < 0 ||
      result.storage_expiry_stop_ms >= 1000 ||
      result.thin_physical_storage_acceptance !== false
    )
      throw Error("proof_observation_invalid");
    console.log(
      JSON.stringify({
        passed: true,
        architecture,
        prestarted_claims: 2,
        on_demand_claims: 1,
        prestarted_ms: evidence
          .filter((x) => x.assignment_mode === "prestarted")
          .map((x) => Number(x.assignment_ms.toFixed(3))),
        on_demand_ms: Number(
          evidence
            .find((x) => x.assignment_mode === "on_demand")!
            .assignment_ms.toFixed(3),
        ),
        isolated_cri_context: true,
        process_restart: true,
        actual_long_SQL_stopped: true,
        continuous_guard_material_reload: true,
        removed_scope_restart_protection: true,
        least_privilege_reclaimer_boundary: true,
        storage_expiry_stop_ms:
          Math.round(result.storage_expiry_stop_ms * 1000) / 1000,
        all_tasks_deleted: true,
        CF_CNPG_SQL_acceptance: false,
      }),
    );
  } catch {
    throw Error(stage);
  } finally {
    await invoke(
      ["rm", "-f", name],
      join(directory, "cleanup-container.private.log"),
      30000,
    );
    await invoke(
      ["image", "rm", "-f", image],
      join(directory, "cleanup-image.private.log"),
      30000,
    );
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await runSandboxProof();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "proof_failed");
    process.exitCode = 1;
  }
}
