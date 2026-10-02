// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Finding } from "./image-qualification.ts";

// Beyond filetype 1.1.3's last magic offset; exactly one additional line.
export const opaquePrefix = Buffer.from("#" + " ".repeat(32773) + "\n");
export interface ScanInput {
  kind:
    | "layer-file"
    | "image-config"
    | "image-manifest"
    | "metadata-string"
    | "tar-metadata";
  layer: number | null;
  tarEntry: number | null;
  path: string;
  sha256: string;
  size: number;
  sourcePath: string;
  boundDigest?: string;
}
export interface Alias {
  name: string;
  diskPath: string;
  prefixLines: number;
  input: Readonly<ScanInput>;
  detectorSha256: string;
}
export interface ScanPass {
  directory: string;
  aliases: Alias[];
  expectedBytes: number;
  requireExactBytes: boolean;
}
function check(condition: unknown): asserts condition {
  if (!condition)
    throw new Error("Scanner coverage or canonical mapping failed");
}
function identity(input: Readonly<ScanInput>): string {
  return JSON.stringify([
    input.kind,
    input.layer,
    input.tarEntry,
    input.path,
    input.sha256,
    input.size,
    input.boundDigest ?? null,
  ]);
}
async function copyAlias(
  input: ScanInput,
  path: string,
  prefixed: boolean,
): Promise<string> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const hash = createHash("sha256");
  const detectorHash = createHash("sha256");
  let size = 0;
  async function* bytes() {
    if (prefixed) {
      detectorHash.update(opaquePrefix);
      yield opaquePrefix;
    }
    for await (const chunk of createReadStream(input.sourcePath)) {
      size += chunk.length;
      hash.update(chunk);
      detectorHash.update(chunk);
      yield chunk;
    }
  }
  await pipeline(
    Readable.from(bytes()),
    createWriteStream(path, { mode: 0o600, flags: "wx" }),
  );
  check(size === input.size && hash.digest("hex") === input.sha256);
  return detectorHash.digest("hex");
}
export async function prepareInputs(
  inputs: ScanInput[],
  directory: string,
): Promise<Record<"original" | "opaque" | "family", ScanPass>> {
  const passes: Record<"original" | "opaque" | "family", ScanPass> = {
    original: {
      directory: join(directory, "original"),
      aliases: [],
      expectedBytes: 0,
      requireExactBytes: false,
    },
    opaque: {
      directory: join(directory, "opaque"),
      aliases: [],
      expectedBytes: 0,
      requireExactBytes: true,
    },
    family: {
      directory: join(directory, "family"),
      aliases: [],
      expectedBytes: 0,
      requireExactBytes: true,
    },
  };
  for (const pass of Object.values(passes))
    await mkdir(pass.directory, { mode: 0o700 });
  const seen = new Set<string>();
  for (const [index, source] of inputs.entries()) {
    check(
      Number.isSafeInteger(source.size) &&
        source.size >= 0 &&
        /^[a-f0-9]{64}$/.test(source.sha256),
    );
    const input = Object.freeze({ ...source });
    check(!seen.has(identity(input)));
    seen.add(identity(input));
    const originalName =
      source.kind === "layer-file"
        ? `${index}/${source.path}`
        : `${index}/metadata`;
    check(
      !originalName
        .split("/")
        .some((part) => !part || part === "." || part === "..") &&
        !/[\\\0\r\n]/.test(originalName),
    );
    async function add(pass: ScanPass, name: string, prefixed: boolean) {
      const diskPath = join(pass.directory, name);
      const detectorSha256 = await copyAlias(source, diskPath, prefixed);
      pass.aliases.push(
        Object.freeze({
          name,
          diskPath,
          input,
          prefixLines: prefixed ? 1 : 0,
          detectorSha256,
        }),
      );
      pass.expectedBytes += source.size + (prefixed ? opaquePrefix.length : 0);
    }
    await add(passes.original, originalName, false);
    await add(passes.opaque, String(index), true);
    if (
      source.kind === "layer-file" &&
      /(?:\.php|\.(?:tf|hcl)|\.ya?ml|nuget\.config|\.p(?:12|fx))$/i.test(
        basename(source.path),
      )
    )
      await add(passes.family, `${index}/x-${basename(source.path)}`, true);
  }
  check(
    passes.opaque.aliases.length === inputs.length &&
      passes.opaque.expectedBytes ===
        inputs.reduce(
          (total, input) => total + input.size + opaquePrefix.length,
          0,
        ),
  );
  return passes;
}
export async function metadataInputs(
  bytes: Buffer,
  kind: "image-config" | "image-manifest",
  directory: string,
  boundDigest: string,
): Promise<ScanInput[]> {
  check(
    boundDigest ===
      "sha256:" + createHash("sha256").update(bytes).digest("hex"),
  );
  const inputs: ScanInput[] = [];
  async function add(
    payload: Buffer,
    pointer: string,
    inputKind: ScanInput["kind"],
  ) {
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const sourcePath = join(directory, `${kind}-${inputs.length}-${sha256}`);
    await writeFile(sourcePath, payload, { mode: 0o600, flag: "wx" });
    inputs.push({
      kind: inputKind,
      layer: null,
      tarEntry: null,
      path: pointer,
      sha256,
      size: payload.length,
      sourcePath,
      boundDigest,
    });
  }
  await add(bytes, "/", kind);
  async function visit(value: unknown, pointer: string): Promise<void> {
    if (typeof value === "string")
      await add(Buffer.from(value), pointer, "metadata-string");
    else if (Array.isArray(value))
      for (const [index, item] of value.entries())
        await visit(item, `${pointer}/${index}`);
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        // Property names themselves are shipped text too.
        await add(
          Buffer.from(key),
          `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}#key`,
          "metadata-string",
        );
        await visit(
          item,
          `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        );
      }
  }
  await visit(JSON.parse(bytes.toString()), "");
  return inputs;
}
export function validateCompletion(
  log: string,
  expectedBytes: number | undefined,
  exit: number | null,
  count: number,
): number {
  check(exit === (count ? 2 : 0) && !log.includes("\x1b"));
  const lines = log.trim().split("\n");
  const completions = lines.filter((line) =>
    / INF scanned ~\d+ bytes \(.+\) in \S+$/.test(line),
  );
  check(completions.length === 1);
  const bytes = Number(completions[0]!.match(/scanned ~(\d+) bytes/)![1]);
  check(
    Number.isSafeInteger(bytes) &&
      (expectedBytes === undefined || bytes === expectedBytes),
  );
  const summary = count ? `WRN leaks found: ${count}` : "INF no leaks found";
  check(lines.at(-1)?.endsWith(summary));
  check(
    lines.every(
      (line) => !/ (?:WRN|ERR|FTL|PNC) /.test(line) || line.endsWith(summary),
    ),
  );
  check(
    !/partial scan|Overriding enabled rules|Starting diagnostics/.test(log),
  );
  return bytes;
}
export async function runPass(
  scanner: string,
  pass: ScanPass,
  directory: string,
  name: string,
): Promise<{
  findings: Finding[];
  detectorBytes: number;
  exit: number;
  safe: {
    aliases: number;
    detectorBytes: number;
    findings: number;
    exit: number;
  };
}> {
  check(/^[a-z-]+$/.test(name));
  for (const alias of pass.aliases) {
    const info = await stat(alias.diskPath);
    check(
      info.isFile() &&
        info.size ===
          alias.input.size + (alias.prefixLines ? opaquePrefix.length : 0),
    );
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(alias.diskPath))
      hash.update(chunk);
    check(hash.digest("hex") === alias.detectorSha256);
  }
  const report = join(directory, `${name}-findings.json`);
  const diagnostics = join(directory, `${name}-diagnostics.log`);
  await writeFile(report, "", { flag: "wx", mode: 0o600 });
  const handle = await open(diagnostics, "wx", 0o600);
  let exit: number | null;
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("GITLEAKS_"),
      ),
    ),
    GOMAXPROCS: "2",
    GOMEMLIMIT: "1GiB",
    NO_COLOR: "1",
  };
  try {
    exit = await new Promise<number | null>((fulfill, reject) => {
      const child = spawn(
        scanner,
        [
          "dir",
          "--no-banner",
          "--no-color",
          "--log-level",
          "info",
          "--redact=100",
          "--ignore-gitleaks-allow",
          "--max-target-megabytes=0",
          "--exit-code=2",
          "--report-format",
          "json",
          "--report-path",
          report,
          ".",
        ],
        {
          cwd: pass.directory,
          env,
          stdio: ["ignore", handle.fd, handle.fd],
          timeout: 600_000,
        },
      );
      child.once("error", () => reject(new Error("Scanner process failed")));
      child.once("close", fulfill);
    });
  } finally {
    await handle.close();
  }
  await chmod(report, 0o600);
  const data: unknown = JSON.parse(await readFile(report, "utf8"));
  check(data === null || Array.isArray(data));
  const findings = (data ?? []) as Finding[];
  check(
    findings.every(
      (value) =>
        value &&
        typeof value.File === "string" &&
        typeof value.RuleID === "string",
    ),
  );
  const detectorBytes = validateCompletion(
    await readFile(diagnostics, "utf8"),
    pass.requireExactBytes ? pass.expectedBytes : undefined,
    exit,
    findings.length,
  );
  return {
    findings,
    detectorBytes,
    exit: exit!,
    safe: {
      aliases: pass.aliases.length,
      detectorBytes,
      findings: findings.length,
      exit: exit!,
    },
  };
}
export interface CanonicalFinding extends Finding {
  input: Readonly<ScanInput>;
  Tags: string[];
  span?: {
    byteStart: number;
    byteEndExclusive: number;
    size: number;
    sha256: string;
  };
}
export function dedupeFindings(
  findings: CanonicalFinding[],
): CanonicalFinding[] {
  return [
    ...new Map(
      findings.map((value) => [
        JSON.stringify([
          identity(value.input),
          value.RuleID,
          value.StartLine,
          value.EndLine,
          value.StartColumn,
          value.EndColumn,
          value.Tags,
        ]),
        value,
      ]),
    ).values(),
  ];
}
export async function mapFindings(
  findings: Finding[],
  aliases: Alias[],
): Promise<CanonicalFinding[]> {
  const mapping = new Map(aliases.map((alias) => [alias.name, alias]));
  check(mapping.size === aliases.length);
  const canonical = new Map<string, CanonicalFinding>();
  const payloads = new Map<string, Buffer>();
  for (const finding of findings) {
    const alias = mapping.get(finding.File.replace(/^\.\//, ""));
    check(alias);
    const tags: unknown = (finding as Finding & { Tags?: unknown }).Tags ?? [];
    check(Array.isArray(tags) && tags.every((tag) => typeof tag === "string"));
    const value: CanonicalFinding = {
      ...finding,
      File: alias.input.path,
      StartLine: finding.StartLine - alias.prefixLines,
      EndLine: finding.EndLine - alias.prefixLines,
      input: alias.input,
      Tags: [...tags].sort(),
    };
    // v8.30.1 measures later-line columns from the newline byte, not the following byte.
    if (alias.prefixLines && value.StartLine === 1) value.StartColumn--;
    if (alias.prefixLines && value.EndLine === 1) value.EndColumn--;
    const filenameOnly =
      finding.RuleID === "pkcs12-file" &&
      /\.p(?:12|fx)$/i.test(alias.input.path) &&
      finding.StartLine === 0 &&
      finding.EndLine === 0 &&
      finding.StartColumn === 0 &&
      finding.EndColumn === 0;
    if (filenameOnly) {
      value.StartLine = 0;
      value.EndLine = 0;
    } else {
      check(
        [
          value.StartLine,
          value.EndLine,
          value.StartColumn,
          value.EndColumn,
        ].every(Number.isSafeInteger) &&
          value.StartLine > 0 &&
          value.EndLine >= value.StartLine,
      );
      let bytes = payloads.get(alias.input.sourcePath);
      if (!bytes) {
        bytes = await readFile(alias.input.sourcePath);
        check(
          bytes.length === alias.input.size &&
            createHash("sha256").update(bytes).digest("hex") ===
              alias.input.sha256,
        );
        payloads.set(alias.input.sourcePath, bytes);
      }
      const lines = bytes.toString("latin1").split("\n");
      check(
        value.EndLine <= lines.length &&
          value.StartColumn > 0 &&
          value.EndColumn > 0 &&
          value.StartColumn <=
            lines[value.StartLine - 1]!.length +
              (value.StartLine > 1 ? 1 : 0) &&
          value.EndColumn <=
            lines[value.EndLine - 1]!.length + (value.EndLine > 1 ? 1 : 0) &&
          (value.StartLine !== value.EndLine ||
            value.StartColumn <= value.EndColumn),
      );
      const offsets: number[] = [0];
      for (let index = 0; index < bytes.length; index++)
        if (bytes[index] === 10) offsets.push(index);
      const byteStart = offsets[value.StartLine - 1]! + value.StartColumn - 1;
      const byteEndExclusive = offsets[value.EndLine - 1]! + value.EndColumn;
      check(
        byteStart >= 0 &&
          byteEndExclusive > byteStart &&
          byteEndExclusive <= bytes.length,
      );
      value.span = Object.freeze({
        byteStart,
        byteEndExclusive,
        size: byteEndExclusive - byteStart,
        sha256: createHash("sha256")
          .update(bytes.subarray(byteStart, byteEndExclusive))
          .digest("hex"),
      });
    }
    const key = JSON.stringify([
      identity(alias.input),
      value.RuleID,
      value.StartLine,
      value.EndLine,
      value.StartColumn,
      value.EndColumn,
      value.Tags,
    ]);
    canonical.set(key, value);
  }
  return [...canonical.values()];
}
export function safeFindingCounts(
  findings: CanonicalFinding[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings)
    counts[finding.RuleID] = (counts[finding.RuleID] ?? 0) + 1;
  return counts;
}
