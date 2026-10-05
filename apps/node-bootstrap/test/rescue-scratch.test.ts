// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixture } from "./fixture.ts";
import { prepareScratch, prepareScratchScript } from "../src/rescue-scratch.ts";

const reserve = 512 * 1024 ** 2;

// Exercise the generated shell on real temporary files. Commands that require a
// rescue mount namespace have narrow test adapters; product code has none.
async function shell(
  input: ReturnType<typeof fixture>,
  options: {
    available: number;
    mounted?: "owned" | "foreign";
    cachedRaw?: number;
    swapFailure?: boolean;
  },
) {
  const root = await mkdtemp(join(tmpdir(), "pgcf-scratch-test-"));
  const path = join(root, "run", "pgcf-bootstrap", input.spec.operation_id);
  await mkdir(path, { recursive: true });
  if (options.mounted) {
    await writeFile(join(path, "identity"), input.input_hash);
    if (options.cachedRaw) {
      await writeFile(join(path, "image.raw"), Buffer.alloc(options.cachedRaw));
    }
  }
  const script = `
scratch_test_root="$SCRATCH_TEST_ROOT"
scratch_test_mounted="$SCRATCH_TEST_MOUNTED"
scratch_test_source="$SCRATCH_TEST_SOURCE"
scratch_test_original_dir="$scratch_test_root/run/pgcf-bootstrap/$SCRATCH_TEST_OPERATION"
map_path() { if [[ "$1" == /run* ]]; then printf '%s%s' "$scratch_test_root" "$1"; else printf '%s' "$1"; fi; }
test() {
  local arguments=() value
  for value in "$@"; do arguments+=("$(map_path "$value")"); done
  builtin test "\${arguments[@]}"
}
readlink() { printf '%s\\n' "$2"; }
mkdir() { command mkdir "$(map_path "$1")"; }
chmod() { command chmod "$1" "$(map_path "$2")"; }
find() { local path="$1"; shift; command find "$(map_path "$path")" "$@"; }
cat() { command cat "$(map_path "$1")"; }
stat() { command wc -c < "$(map_path "$2")" | command awk '{print $1}'; }
swapon() { if [[ "$SCRATCH_TEST_SWAP_FAILURE" == yes ]]; then return 2; fi; }
getconf() { printf '4096\\n'; }
awk() { if [[ "\${@: -1}" == /proc/meminfo ]]; then printf '%s\\n' "$SCRATCH_TEST_AVAILABLE"; else command awk "$@"; fi; }
mount() {
  scratch_test_mounted=yes
  scratch_test_source="$5"
  printf '%s\\n' "$*" >> "$scratch_test_root/mounts"
}
findmnt() {
  local target output index
  local arguments=("$@")
  for (( index=0; index<\${#arguments[@]}; index++ )); do
    case "\${arguments[$index]}" in
      --target|--mountpoint) target="\${arguments[$((index+1))]}";;
      --output) output="\${arguments[$((index+1))]}";;
    esac
  done
  if [[ "$scratch_test_mounted" == yes && "$target" == "$scratch_test_original_dir"* ]]; then
    if [[ "$output" == TARGET ]]; then printf '%s\\n' "$scratch_test_original_dir";
    else printf '%s %s tmpfs\\n' "$scratch_test_original_dir" "$scratch_test_source"; fi
  else printf '%s tmpfs tmpfs\\n' "$scratch_test_root/run"; fi
}
df() {
  local bytes=$(( (SCRATCH_TEST_LIMIT + 4095) / 4096 * 4096 )) used=0 file size
  for file in "$scratch_test_root/run/pgcf-bootstrap/$SCRATCH_TEST_OPERATION/"*; do
    if [[ -f "$file" ]]; then size=$(command wc -c < "$file"); used=$((used+size)); fi
  done
  printf '1B-blocks Avail\\n%s %s\\n' "$bytes" "$((bytes-used))"
}
${prepareScratchScript(input).replaceAll("/run", `${root}/run`)}`;
  const expectedSource = `pgcf-bootstrap-${input.spec.operation_id}-${input.input_hash}`;
  const result = spawnSync("bash", ["-s"], {
    input: script,
    encoding: "utf8",
    env: {
      ...process.env,
      SCRATCH_TEST_ROOT: root,
      SCRATCH_TEST_OPERATION: input.spec.operation_id,
      SCRATCH_TEST_AVAILABLE: String(options.available),
      SCRATCH_TEST_LIMIT: String(
        input.spec.image.compressed_bytes +
          input.spec.image.raw_bytes +
          reserve,
      ),
      SCRATCH_TEST_MOUNTED: options.mounted ? "yes" : "no",
      SCRATCH_TEST_SOURCE:
        options.mounted === "foreign" ? "foreign-tmpfs" : expectedSource,
      SCRATCH_TEST_SWAP_FAILURE: options.swapFailure ? "yes" : "no",
    },
  });
  return {
    result,
    path,
    mounts: await readFile(join(root, "mounts"), "utf8").catch(() => ""),
    remove: async () => await rm(root, { recursive: true, force: true }),
  };
}

test("scratch input validation prevents shell-path injection and an unbounded mount", () => {
  const input = fixture();
  input.spec.operation_id = "op_../../other";
  assert.throws(
    () => prepareScratchScript(input),
    /rescue_scratch_input_invalid/,
  );
  const valid = fixture();
  valid.spec.hardware.rescue_ram_min_bytes = reserve;
  assert.throws(
    () => prepareScratchScript(valid),
    /rescue_scratch_input_invalid/,
  );
});

test("fresh scratch refuses unavailable memory and a failed swap observation before mounting", async () => {
  const input = fixture();
  const insufficient = await shell(input, { available: reserve });
  try {
    assert.notEqual(insufficient.result.status, 0);
    assert.equal(insufficient.mounts, "");
  } finally {
    await insufficient.remove();
  }
  const unknownSwap = await shell(input, {
    available: input.spec.hardware.rescue_ram_min_bytes,
    swapFailure: true,
  });
  try {
    assert.notEqual(unknownSwap.result.status, 0);
    assert.equal(unknownSwap.mounts, "");
  } finally {
    await unknownSwap.remove();
  }
});

test("fresh scratch mounts once at a bounded size and verifies actual source and capacity", async () => {
  const input = fixture();
  const execution = await shell(input, {
    available: input.spec.hardware.rescue_ram_min_bytes,
  });
  try {
    assert.equal(execution.result.status, 0, execution.result.stderr);
    assert.equal(execution.result.stdout.trim(), "pgcf_scratch_ready");
    assert.equal(execution.mounts.trim().split("\n").length, 1);
    assert.match(execution.mounts, /nosuid,nodev,noexec/);
    assert.equal(
      await readFile(join(execution.path, "identity"), "utf8"),
      input.input_hash,
    );
  } finally {
    await execution.remove();
  }
});

test("owned scratch resumes using cached bytes without remounting or changing the image", async () => {
  const input = fixture();
  input.spec.image.compressed_bytes = 2;
  input.spec.image.raw_bytes = 512;
  input.spec.hardware.rescue_ram_min_bytes = reserve + 514;
  const execution = await shell(input, {
    available: reserve + 2,
    mounted: "owned",
    cachedRaw: 512,
  });
  try {
    assert.equal(execution.result.status, 0, execution.result.stderr);
    assert.equal(execution.mounts, "");
    assert.deepEqual(
      await readFile(join(execution.path, "image.raw")),
      Buffer.alloc(512),
    );
  } finally {
    await execution.remove();
  }
});

test("foreign scratch refuses access without replacing a mount or modifying retained files", async () => {
  const input = fixture();
  const execution = await shell(input, {
    available: input.spec.hardware.rescue_ram_min_bytes,
    mounted: "foreign",
    cachedRaw: 16,
  });
  try {
    assert.notEqual(execution.result.status, 0);
    assert.equal(execution.mounts, "");
    assert.deepEqual(
      await readFile(join(execution.path, "image.raw")),
      Buffer.alloc(16),
    );
  } finally {
    await execution.remove();
  }
});

test("scratch command failure and incomplete readback stop the caller", async () => {
  const input = fixture();
  await assert.rejects(
    prepareScratch(input, async () => ({
      exit_code: 1,
      stdout: "pgcf_scratch_ready\n",
    })),
    /rescue_scratch_not_ready/,
  );
  await assert.rejects(
    prepareScratch(input, async () => ({ exit_code: 0, stdout: "" })),
    /rescue_scratch_not_ready/,
  );
});
