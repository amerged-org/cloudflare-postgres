# Proposal: a faster CI

**Status:** plan for the owner, 2026-11-01. Nothing here is built. The owner pointed to a write-up on making a CI about 20 times faster ([Owen Gretzinger, "How I made our CI 20x faster", 2026-10-30](https://x.com/owengretzinger/status/2116291924219060319)). This document checks each of its levers against this repository's measured CI and orders the ones that apply. The status row is in the [ULTRA plan](cloudflare-convergence-and-serverless-plan.md), 11.2; completed steps and their measured numbers are recorded there, in 11.1, as they land.

Each number carries its basis: *measured* (the GitHub Actions API, see section 1), *estimate* (not measured) or *target* (an acceptance threshold proposed here for the owner to confirm). Following AGENTS.md, the plan gives no effort or duration estimates for the work; each step names its scope and its acceptance instead.

**Question.** A pull request waits about 24 minutes for CI, and so does every push to main. Agents and the owner push many times a day. Which levers of the write-up apply here, in what order, and what does each need?

**Short answer.**

- **The wait is not the machine; it is the shape of the job.** A job gets a runner in 3 s (median; 25 s at most) on GitHub's `ubuntu-24.04`. `check` is one job of 28 steps that run one after another: 1,427 s of steps (*measured*). `node-image` runs beside it in 536 s and is not on the critical path today.
- **Four steps are 90 % of `check`:** the native runtime and contracts step (501 s), the TypeScript tests (403 s), the node agent's kernel test (239 s) and the Rust tool setup (145 s). Together 1,288 of 1,427 s. The static checks (checkout, install, diagrams, plan privacy, lint, format, typecheck) are 79 s together.
- **Rust is compiled from nothing up to five times in a run** and no Rust cache exists. Only the pnpm store is cached (one entry, 143 MB, on `main`).
- **The order of work:** (1) split `check` into jobs that run at the same time and measure each; (2) cache what Rust compiles, but only where the result is a verdict, never a shipped byte; (3) shard the TypeScript tests where the measurement says; (4) a pre-push hook for the cheap checks that fail runs today; (5) skip what a pull request cannot affect; (6) a bigger runner only if all that is not enough, and only with the owner's costed go.
- **Not adopted, because the measurement says there is no problem:** a faster runner provider (queue 3 s), Oxlint (lint 8 s), a faster typechecker (typecheck 26 s). A runner provider would also widen the release-signing trust (2.1).
- **Estimate after step 1 alone:** the longest job becomes the Rust job, about 11 minutes, from about 24. Target after the steps that apply: under 10 minutes for a successful pull request run, to be confirmed by the owner (section 5).

---

## 1. What CI costs today (*measured*)

Source: the jobs API of the last 50 runs of `ci.yml` on the current job layout (`check`, `node-image`, `sign-release`), created 2026-10-25 to 2026-10-31, push and pull request. Medians unless stated.

### 1.1 Wall clock, waste and queue

| Fact | Value |
| --- | --- |
| Successful pull request run (20 runs) | 1,439 s median, 1,113 to 1,561 s |
| Successful push to main (19 runs) | 1,476 s median, 1,141 to 1,678 s |
| Docs-only pull requests (3 runs, branches `docs-events-deployed`, `docs/used-by`, `docs/readme-generic-vps`) | 1,330 s, 1,382 s, 1,530 s: the same as a code change |
| Queue before a job starts | 3 s median, 25 s at most (`check`), 13 s at most (`node-image`) |
| Runs that did not succeed (50) | 8 failed, 3 cancelled (22 %) |
| Why the 8 failed | Rust and contract checks 4, TypeScript tests 2, the diagram check 2 |

### 1.2 `check`: 28 steps, one after another, 1,427 s of steps

| Step | Seconds | Note |
| --- | --- | --- |
| Check the native runtime and Worker contracts | 501 | Four generator checks, `cargo fmt`, `cargo test --workspace`, `cargo clippy --workspace --all-targets`, `cargo clippy` for `wasm32`. Each cargo command builds on its own; nothing is cached. |
| Test | 403 | `pnpm test` runs the packages one after another (`--workspace-concurrency=1`), then the `node --test` suites of `scripts/`. The API package alone has 129 test files in Workerd with `maxWorkers: 2`. The split among packages is not measured yet. |
| Check the node agent against the actual Linux kernel | 239 | A `docker build` that compiles the agent's tests from nothing, then `docker run` with a 90 s limit. |
| Set up the pinned Rust and Worker build tools | 145 | `rustup toolchain install` and `cargo install worker-build`, which compiles it. The split between the two is not measured yet. |
| Build the Worker once for actual Workerd tests | 44 | `pnpm -r build` (`worker-build --release`). |
| Typecheck | 26 | |
| Everything else (22 steps) | 69 | Install 9, diagrams 11, format 10, lint 8, PostgreSQL package 12, Node 7 and the rest |

### 1.3 `node-image`: 536 s of steps, runs beside `check`

| Step | Seconds |
| --- | --- |
| Download the locked packages and build the image | 267 |
| Build the node binaries with the pinned Rust toolchain (`cargo build --release`, from nothing) | 180 |
| Boot the image in QEMU and assert the boot test | 56 |
| Install, setup, tooling tests | 33 |

### 1.4 Where Rust is built from nothing in one run

1. `cargo test --workspace` and `cargo clippy --workspace --all-targets` in `check` (two profiles, two builds).
2. `cargo clippy -p pgcf-edge-rust --target wasm32-unknown-unknown` in `check`.
3. `cargo install worker-build` in `check`, then `worker-build --release` of the Edge Worker.
4. `docker build` of the node agent's kernel test in `check`.
5. `cargo build --release` of the four node binaries in `node-image`.

### 1.5 How the numbers were taken

For each run, `gh api repos/<repo>/actions/runs/<id>/jobs`; per job the time from `created_at` to `started_at` is the queue, per step `completed_at` minus `started_at` is the step. Only successful jobs count. Every step below is re-measured the same way over at least 20 runs of each event, and the result is written to 11.1 of the ULTRA plan.

---

## 2. The levers of the write-up against this repository

| Lever of the write-up | Applies here? | Basis | Decision |
| --- | --- | --- | --- |
| 1. Runners other than GitHub's | **No** | Queue is 3 s. The write-up's gain was an 11-minute queue. The signer also requires a GitHub-hosted runner (2.1). | Not adopted |
| 2. Oxlint instead of ESLint | **No** | Lint is 8 s, format 10 s. | Not adopted |
| 3. A faster typechecker | **No** | Typecheck is 26 s. | Not adopted |
| 4. Shard tests onto bigger machines | **Later** | Tests are 403 s, but the split among packages is unknown. | Step 3, after the split of step 1 |
| 5. Do not reload the app for every test file (`isolate: false`) | **Maybe** | API tests run 129 files in Workerd; whether the Workers pool allows it, and what leaks, is unknown. | Step 3, kept only if all files pass and the time falls |
| 6. Fix setup (dependency cache from `main`, blobless clone, cache `node_modules`) | **Partly** | pnpm is cached from `main` and costs 9 s. The setup that costs is Rust: 145 s of tools and cold builds in five places (1.4). | Step 2 |
| 7. Run everything in parallel | **Yes, the biggest** | `check` is serial: 1,427 s become the longest of its parts. | Step 1 |
| 8. Only run what a change touches | **Yes** | Three docs-only pull requests ran the full 22 to 25 minutes. | Step 5 |
| 9. Run the checks before every push | **Yes** | 8 of 50 runs failed; two in the diagram check, four in the Rust and contract step. | Step 4 |
| Match parallelism to cores | **Check in step 3** | The API tests use `maxWorkers: 2` on a 4-vCPU runner. | Step 3 |
| Delete tests | **No** | The write-up found almost nothing to cut, and AGENTS.md already forbids test matrices. | Not adopted |

### 2.1 Why the runner provider is not adopted

- The queue is not the problem here (3 s), so the write-up's first and biggest gain does not exist for this repository.
- The release signer accepts the identity token of `sign-release` only when the token's `runner_environment` is `github-hosted` (`apps/release-signer/src/github-token.ts`, `docs/operations/release-signing.md`). `sign-release` trusts the binaries `node-image` built; running `node-image` or `check` on a third party's machines would widen that trust root for no measured gain.
- A larger GitHub-hosted runner is a different matter and is step 6.

---

## 3. The plan

Every step maps to a measured cost above. Each step ends with the audit of 1.5 and a row in 11.1 of the ULTRA plan. There is still one workflow file (AGENTS.md); a step adds jobs to it, not workflows.

### Step 1: split `check` into jobs that run at the same time

**Scope.** Replace the serial `check` by parallel jobs in `ci.yml`, one command per step so that the audit shows every command's time:

| Job | Holds | Steps it replaces (seconds) |
| --- | --- | --- |
| `static` | diagrams, plan privacy, lint, format, typecheck of every tsconfig | 79 |
| `rust` | pinned toolchain, generator checks, `cargo fmt`, `cargo test --workspace`, both `cargo clippy` runs | 145 + 501 |
| `ts-tests` | the Worker build, the pinned PostgreSQL if the TypeScript tests need it, the package tests one package per matrix entry, the `scripts/` tests, the Rust Edge artifact binding and upload | 44 + 403 |
| `kernel` | the node agent's kernel test | 239 |
| `check` (kept) | only a gate: `needs` all of the above, `if: always()`, fails unless every one succeeded | 0 |

- **Why `check` stays as the gate.** `sign-release` has `needs: [check, node-image]` and `scripts/ci/release-signing-workflow.test.ts` asserts exactly that line; `docs/operations/release-signing.md` states it. With the gate, a commit whose tests failed is still never signed and neither the test nor the runbook changes. No branch protection or ruleset requires a check by name today, so no required-check name moves.
- **The Rust Edge artifact** (`pgcf-rust-edge-<sha>-<attempt>`) is built and tested in the same job, so the bytes that were tested are the bytes that are kept.
- **Whatever reads `ci.yml`** changes in the same commit: the Mermaider CI diagram (`.mermaider/config.json` includes `.github/workflows/**`; run the pinned local `update` and `check` first), `scripts/ci/toolchain.test.ts` and `scripts/ci/release-signing-workflow.test.ts` if they name a step or job.
- **Duplicate work seen on the way.** `packages/contracts` runs the generator checks again in its `test` script, after the contracts step ran them. They are seconds; one place keeps them.
- **Cost.** Each job repeats checkout and `pnpm install` (about 20 s). The repository is public, so GitHub-hosted standard minutes are free; the added jobs buy no paid resource.

**Acceptance.** Every successful job of a pull request run and of a push to main is green; `sign-release` still runs only on a push to main after the gate; the audit lists the time of every command that 1.2 lumps together (the split of the 145 s tool setup, of the 501 s Rust step and of the 403 s tests). Estimate: the longest job is `rust` at about 650 s, so the run takes about 11 minutes, from 24.

### Step 2: cache what Rust compiles, where the result is a verdict

**Rule.** *A cache may feed a verdict, never a shipped byte.* The write-up's cache lesson was that PR runs missed a cache because nothing seeded one from `main`. GitHub lets a pull request read the caches of `main` and its own ref, not the other way round; this repository has the pnpm entry on `main` only, and no Rust cache at all.

**Scope.**
- `rust` and `kernel` jobs (verdicts: tests, clippy): restore `~/.cargo/registry`, `~/.cargo/git` and `target/` with `actions/cache/restore` (pinned by commit like the other actions), keyed on `Cargo.lock`, `rust-toolchain.toml` and `infra/platform/versions.lock.json`; save with `actions/cache/save` only on a push to `main`, so pull requests never write caches and the 10 GB budget holds. Separate keys for the test, clippy and `wasm32` profiles, which write different artifacts.
- `node-image` (`cargo build --release` of the binaries that `sign-release` signs) and the Rust Edge build (the Worker bytes that are kept): no `target/` restore. At most the crate downloads (`~/.cargo/registry`), which Cargo checks against the checksums in `Cargo.lock`. A clean release build stays clean. `sign-release` restores no cache another job wrote, as the comment above that job states.
- `worker-build`: measure first what the 145 s are made of (`rustup` or `cargo install`). Only if `cargo install worker-build` is most of it, keep the installed binary in the cache keyed on `rustVersion` and the `workerBuildVersion` of `infra/platform/versions.lock.json`, written only by `main`. It builds the kept Edge bytes, so the owner's rule above applies: the decision waits for the measurement.
- Set `CARGO_INCREMENTAL=0` in CI, so the cache holds dependencies, not incremental state that one source change invalidates.

**Acceptance.** On pull requests, `cargo test`, `cargo clippy` and the kernel job build only the workspace crates, not their dependencies (visible in the step logs and in the audit); the cache size stays well under the 10 GB budget (read `actions/cache/usage`); a pull request run after a cache hit is shorter than before by the dependency build time.

### Step 3: the TypeScript tests (403 s)

**Scope.** Decide from the matrix of step 1 which package dominates; the API package (129 files) is the expected one. Then, in this order, keeping each change only if all test files pass and the measured time falls:
1. `vitest --shard=i/N` of the API package over N jobs (the API tests use local bindings, `remoteBindings: false`, so a shard needs no database of its own).
2. `maxWorkers` of the API package (2 today) against the 4 vCPUs of the runner; the write-up's lesson was that cores mattered more than shards, because most CPU went to loading modules.
3. Whether the Workers pool can reuse its isolate between test files (`isolate: false` in the write-up, which cut each shard from 100 to 35 s). Leaking state between files is the price: add a reset after every file, or drop the change.
4. A larger runner for these jobs only through step 6.

**Acceptance.** `ts-tests` is not the longest job after step 2; no test file passes only because of the order of the files (run once with a shuffled order).

### Step 4: the cheap checks before every push

**Why.** 8 of 50 runs failed and each cost a full cycle: 2 in the diagram check and 4 in the Rust and contract step, whose generator checks and format check, like the diagram check, also run locally. Which command failed in the Rust step is read from the logs of those runs when step 1 is built. The write-up puts the checks in a hook because agents skip a line in AGENTS.md.

**Scope.** A `pre-push` hook, installed by `pnpm install` (a `prepare` script setting `core.hooksPath` to a checked-in directory), that runs on the changed files only: `prettier --check`, `eslint`, the generator `--check` commands, `cargo fmt --check` and the Mermaider `check` (the local tool at the pinned revision of `.mermaider/tool-revision`). It does not run `cargo clippy` or tests. A `--no-verify` push is the owner's override; CI is still the gate.

**Acceptance.** The hook runs in under 30 s on a laptop for a typical change (*target*); the share of failed runs caused by formatting, generated files or diagrams falls to none in the next 20 runs.

### Step 5: skip what a pull request cannot affect

**Why.** Three docs-only pull requests ran the full 22 to 25 minutes (1.1).

**Scope.** A `changes` job computes, from `git diff --name-only` against the base of the pull request, which of Rust, TypeScript and the node image a change touches, in a script under `scripts/ci/` with its own test. **Only on `pull_request`.** A push to main always runs everything, because `sign-release` signs that commit and the gate must have seen all of it. A path that no rule names runs everything (the safe default). The write-up's warning is the acceptance: a change that is hidden from the rules on purpose must fail the run, not report green.

**Acceptance.** A docs-only pull request finishes in about the time of `static`, under 2 minutes (*estimate*); a test changes one path of each rule at a time and a hidden-change fixture fails the run; the push to main of the same commit still runs all jobs.

### Step 6: a bigger runner, only if it is still needed

**Condition.** After steps 1 to 5 the run is still over the target (section 5) and the audit shows the longest job is CPU-bound (Rust compile, Workerd tests).

**Scope.** GitHub's larger hosted runners for named jobs (more vCPUs for the same job), measured on one job first. They are paid per minute even in a public repository, so this step needs **the owner's explicit, costed go** (AGENTS.md). They are GitHub-hosted, so `runner_environment` should stay `github-hosted` at the signer; verify that claim before relying on it, and never move `sign-release` off the standard runner.

**Acceptance.** The measured saving in seconds per run, against the price per run, goes to the owner before any switch.

### 3.1 After step 1: where the time goes next

Once `check` is parallel, the longest job is `rust` (about 650 s); with step 2 it falls, and `node-image` (536 s) becomes the longest. Its two big costs are the image build (267 s, mostly package downloads and the image assembly; not split yet) and the cold release build (180 s, which stays clean by the rule of step 2). The audit after step 2 decides whether the image build is worth its own step; none is planned now, since the problem is not yet observed.

---

## 4. Risks

| Risk | Handling |
| --- | --- |
| A cache hides a real build break | The cache key holds `Cargo.lock`, the toolchain and the lock file; `main` runs the same jobs, so the shortcut is a speed-up of the same compile, not a different one. Shipped bytes (node binaries, Edge Worker) are never built from a restored `target/`. |
| A skipped job lets a bad change merge | Step 5 runs only on pull requests; the push to main runs everything and gates `sign-release`. |
| More jobs, more failure surface (a flaky job blocks the gate) | The aggregate gate shows which job failed; a flaky test is fixed, not retried (AGENTS.md: delete or fix). |
| Test isolation leaks (step 3) | Kept only if all files pass in a shuffled order; otherwise dropped. |
| The diagram and workflow tests lag behind `ci.yml` | They change in the commit that changes `ci.yml` (step 1); the pre-push hook of step 4 catches the stale diagram. |

## 5. Decisions for the owner

The plan proceeds with the recommended answer unless the owner says otherwise.

| # | Decision | Recommended |
| --- | --- | --- |
| CI-1 | Target for the median wall clock of a successful pull request run | Under 10 minutes (*target*); steps 1 and 2 are expected to reach it (*estimate*) |
| CI-2 | The cache rule: a cache may feed a verdict, never a shipped byte (step 2) | Yes |
| CI-3 | Skip jobs on pull requests by path, never on a push to main (step 5) | Yes |
| CI-4 | A larger GitHub-hosted runner (step 6) | Not now; costed go only if steps 1 to 5 miss CI-1 |

## 6. Source

- Owen Gretzinger, "How I made our CI 20x faster (steal this)", 2026-10-30: <https://x.com/owengretzinger/status/2116291924219060319>. The numbers in it are its author's; none of them is used here as ours. Only the levers are.
