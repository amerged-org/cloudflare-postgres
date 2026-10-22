// SPDX-License-Identifier: Apache-2.0
// QEMU boot test of a built node image (plan 9.1): SeaBIOS, the image disk grown by 40 GiB, an
// isolated network with the installer's static settings, two boots. Usage (from the repository root):
//   node infra/node-image/boot-test.ts --image .local/node-image/out/pgcf-node.raw --accel kvm
// --accel tcg works without KVM (slow); --qemu names the qemu-system-x86_64 binary.
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, truncate, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

export interface BootTestResult {
  phases: Map<number, "ok" | "fail">;
  failedChecks: string[];
}

// One SMBIOS type 11 string carrying a systemd system credential.
export function smbiosCredential(name: string, content: string | Buffer): string {
  if (!/^[A-Za-z0-9_.~@-]+$/.test(name)) throw new Error(`invalid credential name ${name}`);
  return `io.systemd.credential.binary:${name}=${Buffer.from(content).toString("base64")}`;
}

export function parseResults(text: string): BootTestResult {
  const phases = new Map<number, "ok" | "fail">();
  const failedChecks: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const phase = /^PGCF-BOOT-TEST phase ([12]) (ok|fail)\b/.exec(line);
    if (phase) phases.set(Number(phase[1]), phase[2] as "ok" | "fail");
    const check = /^PGCF-BOOT-TEST check ([12]) fail (\S+)$/.exec(line);
    if (check) failedChecks.push(`boot ${check[1]}: ${check[2]}`);
  }
  return { phases, failedChecks };
}

export function passed(result: BootTestResult): boolean {
  return result.phases.get(1) === "ok" && result.phases.get(2) === "ok" && result.failedChecks.length === 0;
}

// The guest script travels gzip-compressed: the SMBIOS table QEMU hands to the guest holds 65,535
// bytes in all, and the base64 of the script, at 50 KB, was cut inside it, so systemd could not
// decode the credential and the test never ran.
export const guestCredential = (script: string): string => smbiosCredential("pgcf.boot-test", gzipSync(script));

export const testUnit = `[Unit]
Description=PGCF boot test
After=multi-user.target

[Service]
# Not oneshot: the boot must finish while the test waits for it (systemctl is-system-running --wait).
Type=exec
ImportCredential=pgcf.boot-test
ExecStart=/bin/bash -c 'gzip -dc "%d/pgcf.boot-test" > /run/pgcf-boot-test.sh && exec /bin/bash /run/pgcf-boot-test.sh'
`;

// What the installer writes for a node (install.sh), for QEMU's isolated user network.
const network = `[Match]
MACAddress=52:54:00:12:34:56

[Network]
Address=10.0.2.15/24
IPv6AcceptRA=no
LinkLocalAddressing=ipv6

[Route]
Gateway=10.0.2.2
GatewayOnLink=yes
`;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const image = option("image");
  const accel = option("accel");
  if (!image || (accel !== "kvm" && accel !== "tcg")) {
    console.error("usage: boot-test.ts --image RAW --accel kvm|tcg [--qemu BIN] [--work DIR] [--timeout SECONDS]");
    process.exit(2);
  }
  const qemu = option("qemu") ?? "qemu-system-x86_64";
  const timeout = Number(option("timeout") ?? (accel === "kvm" ? 900 : 3600));
  const work = resolve(option("work") ?? join(resolve(image), "..", "boot-test"));
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  const disk = join(work, "disk.raw");
  await copyFile(resolve(image), disk);
  await truncate(disk, (await stat(disk)).size + 40 * 1024 ** 3);

  const guest = await readFile(join(import.meta.dirname, "boot-test", "guest.sh"), "utf8");
  const credentials = [
    smbiosCredential("systemd.extra-unit.pgcf-boot-test.service", testUnit),
    smbiosCredential("systemd.unit-dropin.multi-user.target~pgcf-boot-test", "[Unit]\nWants=pgcf-boot-test.service\n"),
    guestCredential(guest),
    smbiosCredential("network.network.10-pgcf", network),
  ];
  const smbios: string[] = [];
  for (const [index, credential] of credentials.entries()) {
    const path = join(work, `credential-${index}`);
    await writeFile(path, credential);
    smbios.push("-smbios", `type=11,path=${path}`);
  }

  const console_ = join(work, "console.log");
  const results = join(work, "results.log");
  const args = [
    "-nodefaults", "-no-user-config", "-display", "none",
    "-machine", "q35", "-accel", accel, "-cpu", accel === "kvm" ? "host" : "max",
    "-smp", "2", "-m", "4096",
    "-drive", `file=${disk},format=raw,if=virtio,cache=unsafe`,
    "-nic", "user,model=virtio-net-pci,restrict=on,mac=52:54:00:12:34:56",
    "-chardev", `file,id=console,path=${console_}`, "-serial", "chardev:console",
    "-chardev", `file,id=results,path=${results}`, "-serial", "chardev:results",
    ...smbios,
  ];
  const started = Date.now();
  const child = spawn(qemu, args, { stdio: ["ignore", "inherit", "inherit"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout * 1000);
  const exit = await new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  clearTimeout(timer);

  const output = await readFile(results, "utf8").catch(() => "");
  process.stdout.write(output);
  const result = parseResults(output);
  const seconds = Math.round((Date.now() - started) / 1000);
  if (exit !== 0 || !passed(result)) {
    const log = await readFile(console_, "utf8").catch(() => "");
    process.stdout.write(`--- console (last 150 lines) ---\n${log.split("\n").slice(-150).join("\n")}\n`);
    console.error(`boot test failed after ${seconds} s (qemu exit ${exit}): ${result.failedChecks.join(", ") || "no result"}`);
    process.exit(1);
  }
  console.log(`boot test passed in ${seconds} s`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
