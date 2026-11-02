# Proposal: a faster CI

**Status:** plan for the owner, 2026-11-01. Steps 1, 2 and 5 are built on the branch `ci-parallel` (pull request 35, "Built" in each step); merged as `eb5df36a`; four runs took 606 to 739 s (1.7); steps 3, 4 and 6 are not built. The owner pointed to a write-up on making a CI about 20 times faster ([Owen Gretzinger, "How I made our CI 20x faster", 2026-10-30](https://x.com/owengretzinger/status/2116291924219060319)). This document checks each of its levers against this repository's measured CI and orders the ones that apply. The status row is in the [ULTRA plan](cloudflare-convergence-and-serverless-plan.md), 11.2; completed steps and their measured numbers are recorded there, in 11.1, as they land.

Each number carries its basis: *measured* (the GitHub Actions API, see section 1), *estimate* (not measured) or *target* (an acceptance threshold proposed here for the owner to confirm). Following AGENTS.md, the plan gives no effort or duration estimates for the work; each step names its scope and its acceptance instead.

**Question.** A pull request waits about 24 minutes for CI, and so does every push to main. Agents and the owner push many times a day. Which levers of the write-up apply here, in what order, and what does each need?

**Short answer.**

- **The wait is not the machine; it is the shape of the job.** A job gets a runner in 3 s (median; 25 s at most) on GitHub's `ubuntu-24.04`. `check` is one job of 28 steps that run one after another: 1,427 s of steps (*measured*). `node-image` runs beside it in 536 s and is not on the critical path today.
- **Four steps are 90 % of `check`:** the native runtime and contracts step (501 s), the TypeScript tests (403 s), the node agent's kernel test (239 s) and the Rust tool setup (145 s). Together 1,288 of 1,427 s. The static checks (checkout, install, diagrams, plan privacy, lint, format, typecheck) are 79 s together.
- **Rust is compiled from nothing up to five times in a run** and no Rust cache exists. Only the pnpm store is cached (one entry, 143 MB, on `main`).
- **The order of work:** (1) split `check` into jobs that run at the same time and measure each; (2) cache what Rust compiles, but only where the result is a verdict, never a shipped byte; (3) shard the TypeScript tests where the measurement says; (4) a pre-push hook for the cheap checks that fail runs today; (5) skip what a pull request cannot affect; (6) a bigger runner only if all that is not enough, and only with the owner's costed go.
- **Not adopted, because the measurement says there is no problem:** a faster runner provider (queue 3 s), Oxlint (lint 8 s), a faster typechecker (typecheck 26 s). A runner provider would also widen the release-signing trust (2.1).
- **Estimate after step 1 alone:** the longest job becomes the Rust job, about 10 minutes, from about 24. Target after the steps that apply: under 10 minutes for a successful pull request run, to be confirmed by the owner (section 5).

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

### 1.6 First measurement of steps 1, 2 and 5 (*measured*, one pull request run)

Run `41409201398` of the pull request that builds them (a change to `ci.yml`, so the scope ran everything). One run is not the median over 20 that the audit requires (1.5); it shows where the time went. The cache step ran but found no entry, because main holds none yet.

| Job | Seconds | Longest steps |
| --- | --- | --- |
| `rust` | 587 | `cargo test --workspace` 482 (dependencies compiled from nothing), `cargo clippy` 33 and 21, PostgreSQL 17, toolchain 9 |
| `node-image` | 461 | image build 257, node binaries 120, boot test 55 |
| `api-tests` | 325 | the API's tests 293 |
| `edge-tests` | 303 | `cargo install worker-build` and the toolchain 150, Worker build 47, Workerd test 70 |
| `kernel` | 199 | the kernel test 183 |
| `other-tests` | 126 | contracts 21, Edge 28, end-to-end package 12, scripts 11, PostgreSQL 11, install 11 |
| `static` | 69 | typecheck 20, format 8 |
| `changes`, `check` (gate) | 17, 18 | |

- **The run took 647 s, against 1,439 s (median of pull requests before).** The longest job is `rust`, and 482 of its 587 s are `cargo test`. The plan expected most of that to be compiling dependencies; 1.7 shows it is not.
- **The 145 s "Rust and Worker tool setup" of 1.2 were almost all `cargo install worker-build`.** The pinned toolchain alone is 9 s in `rust`; the same step with `worker-build` is 150 s in `edge-tests`. That settles the split the plan left open.
- **Two things show for the next steps.** For a pull request that skips the native jobs, the longest job is now `api-tests` (325 s), then `edge-tests` (303 s); the first needs shards (step 3), the second a cached `worker-build` (step 2, the decision named below).
- **`changes` and the gate `check` cost 17 and 18 s** at the two ends of the critical path.

### 1.7 After the merge (*measured*, runs on main)

| Run | Wall | `rust` | `node-image` | `api-tests` | `edge-tests` | `kernel` | `other-tests` | `static` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pull request `41409201398`, no cache | 647 | 587 | 461 | 325 | 303 | 199 | 126 | 69 |
| Pull request `41410630564`, no cache (the merged tree) | 734 | 599 | 521 | 233 | 310 | 271 | 110 | 89 |
| Push to main `41455586482`, saves the cache, `sign-release` 26 s | 739 | 622 | 676 | 246 | 249 | 278 | 110 | 72 |
| Dispatch on main `41457457107`, restores the cache | 606 | 525 | 582 | 355 | 313 | 240 | 125 | 94 |

- **Before:** 1,439 s (pull request) and 1,476 s (push), medians of 20 and 19 runs. **After:** 606 to 739 s in four runs, about half. Four runs are not a median: a job's time moves by 60 to 100 s between runs on the same code, so the number to quote is the median of at least 20 runs of each event, which is still to be taken.
- **The cache works and was the smaller lever.** The restore takes 14 s and saves 780 MB; `cargo test` compiled only the seven workspace crates, in 57.75 s. But `cargo test` fell from 499 to 445 s and the workspace lint from 38 to 21 s, about 70 s together. The rest of `cargo test` is running tests: the node agent's library has 934 tests that take about 305 s (of the 387 s of test runs) and the other test binaries together about 80 s. The plan's expectation that the 482 s were mostly dependency compiling was wrong; the first build of the plan measured the step, not its parts.
- **On a full run the longest job is now `node-image`** (582 to 676 s on main) and `rust` (525 to 622 s) is next; both are over 9 minutes. The image build (257 s) and the cold `cargo build --release` of the node binaries (120 s) are the two parts, and the cache rule keeps the second cold on purpose.
- **A change that skips the native jobs is bounded by `api-tests`** (233 to 355 s) and `edge-tests` (249 to 313 s), as 1.6 said; 12 of the last 40 commits of main were of that kind and 7 were documents only.

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

**Built.** `check` is replaced by jobs that run at the same time in the one `ci.yml`; every command is its own step, so the audit shows its time:

| Job | Holds | Replaces (seconds, *measured*) |
| --- | --- | --- |
| `changes` | decides the scope of the run (step 5) | new |
| `static` | diagrams, plan privacy, lint, format, typecheck | 79 |
| `rust` | pinned toolchain and PostgreSQL, `cargo fmt`, `cargo test --workspace`, both `cargo clippy` runs | 501 and part of 145 |
| `edge-tests` | the pinned Worker build tools, the Rust Edge Worker build and its Workerd test, the artifact binding and upload | 44, part of 145 and part of 403 |
| `api-tests` | the API package's tests (129 files) | most of 403 (not measured per package) |
| `other-tests` | the image tooling and installer checks (moved from `node-image`), the tests of the contracts, the Edge, the release signer, the CLI and the end-to-end package, the `scripts/` tests | rest of 403 |
| `kernel` | the node agent's kernel test | 239 |
| `check` (kept) | only the gate: `needs` all of the above and fails unless each has passed or was left out by the scope | 0 |

- **Why `check` stays as the gate.** `sign-release` has `needs: [check, node-image]` and `scripts/ci/release-signing-workflow.test.ts` asserts exactly that line; `docs/operations/release-signing.md` states it. A commit whose tests failed is still never signed and neither the test nor the runbook's rule changes (the runbook's description of what `check` holds is updated). No branch protection or ruleset requires a check by name (read from the API, 2026-11-01), so no required-check name moves.
- **Where the old step went.** The 501 s step also ran four generator `--check` commands; the contracts package's own `test` script runs them (and two more), so they live there only. `pnpm test` ran the packages one after another; each package is now named in a step (`pnpm --filter <name> test`) and `scripts/ci/ci-jobs.test.ts` fails if a package with a `test` script is in no job or in two, which is the new way to lose a test.
- **What the test `toolchain.test.ts` allows.** A job that installs no packages (the scope, `rust`, `kernel` and the gate) has no `pnpm install` to order after the toolchain check; the test accepts that and still requires the check before any install and any Docker build.
- **Dependencies found while splitting** (each decided where a test lives): `apps/edge-rust/test` runs the API's `DatabaseActor` and reads the API's migrations, so `edge-tests` belongs to the Workers part of the scope; `infra/node-image/gateway-socket.test.ts` reads `apps/api/src/domain/node-tunnel.ts`, so the image tooling checks run in `other-tests` (they take 4 s) and `node-image` is left with the build, the boot and the release files; `scripts/e2e`'s local tests require PostgreSQL when `CI` is set, so `other-tests` installs it as `rust` does, through `scripts/ci/install-test-postgres.sh`.
- **The Rust Edge artifact** (`pgcf-rust-edge-<sha>-<attempt>`) is built and tested in `edge-tests`, so the bytes that were tested are the bytes that are kept.
- **Whatever reads `ci.yml`** changed in the same commit: the Mermaider CI diagram, `toolchain.test.ts` and the release-signing runbook.
- **Cost.** Each job repeats checkout and `pnpm install` (about 20 s). The repository is public, so GitHub-hosted standard minutes are free; the added jobs buy no paid resource.

**Acceptance.** Every job of a pull request run and of a push to main is green; `sign-release` still runs only on a push to main after the gate; the audit lists the time of every command that 1.2 lumps together (the split of the 145 s tool setup, of the 501 s Rust step and of the 403 s tests). Estimate: the longest job is `rust` at about 540 s, so the run takes about 10 minutes, from 24.

### Step 2: cache what Rust compiles, where the result is a verdict

**Rule.** *A cache may feed a verdict, never a shipped byte.* The write-up's cache lesson was that PR runs missed a cache because nothing seeded one from `main`. GitHub lets a pull request read the caches of `main` and its own ref, not the other way round; this repository had the pnpm entry on `main` only, and no Rust cache at all.

**Built** in the `rust` job only: `actions/cache/restore` of `~/.cargo/registry/index`, `~/.cargo/registry/cache`, `~/.cargo/git/db` and `target`, keyed on `Cargo.lock`, `rust-toolchain.toml` and `infra/platform/versions.lock.json` with no fallback key (a changed lock compiles once cold on main and is then cached; the cache cannot grow by restoring an old one and adding to it); `actions/cache/save` only on a push to `main` and only after a miss, so pull requests write no cache and the 10 GB budget holds. `CARGO_INCREMENTAL=0`, so the cache holds dependencies and not incremental state that one source change invalidates. The workspace crates are rebuilt every run (their files are new); the dependencies are not.

- **No cache in `node-image`, `edge-tests` and `sign-release`.** `node-image` compiles the binaries that `sign-release` signs and `edge-tests` builds the Worker bytes that are kept; both compile from nothing, and `scripts/ci/ci-jobs.test.ts` fails if a cache step appears in either. `sign-release` restores no cache another job wrote, as the comment above that job states.
- **`worker-build`** (`cargo install` in `edge-tests`, about 140 of the job's 303 s, 1.6) is not cached: it builds the kept Edge bytes, so the rule above decides it. It is not on the critical path of a full run (`rust` 587 s, `node-image` 461 s); it is for a pull request that skips the native jobs. A cache of the installed binary, keyed on `rustVersion` and `workerBuildVersion` and written only by main, is the next candidate, and the owner's rule (CI-2) says whether a binary that builds kept bytes may come from a cache.
- **The kernel job is not cached, and cannot be by this step.** It compiles the agent's tests inside `docker build`, where a layer cache is dropped whenever a copied source file changes, so it would rebuild every dependency anyway; reusing compiled dependencies needs a different build (the test binary built on the runner against the cached `target/` and copied into the container, or a dependency layer). It is 239 s and not the longest job, so it is left until it is.

**Result (1.7).** The cache works (restore 14 s, 780 MB) and saves about 70 s in `rust`; it is not the lever the plan expected, because most of `cargo test` is test execution, not compiling.

**Acceptance.** After the first push to main saves the cache, `cargo test` and `cargo clippy` in a later pull request build only the workspace crates (visible in the step logs and in the audit); the cache stays well under the 10 GB budget (read `actions/cache/usage`); the `rust` job is shorter than before by the dependency build time. The pull request that adds the cache cannot show this, because it runs before main holds an entry.

### Step 3: the TypeScript tests (403 s)

**Scope.** Step 1 already runs the API package in its own job (`api-tests`), so its time is known on its own; the other packages share `other-tests`, whose steps are timed one by one. Then, in this order, keeping each change only if all test files pass and the measured time falls:
1. `vitest --shard=i/N` of the API package over N jobs (the API tests use local bindings, `remoteBindings: false`, so a shard needs no database of its own).
2. `maxWorkers` of the API package (2 today) against the 4 vCPUs of the runner; the write-up's lesson was that cores mattered more than shards, because most CPU went to loading modules.
3. Whether the Workers pool can reuse its isolate between test files (`isolate: false` in the write-up, which cut each shard from 100 to 35 s). Leaking state between files is the price: add a reset after every file, or drop the change.
4. A larger runner for these jobs only through step 6.

**Acceptance.** `api-tests` is not the longest job after step 2; no test file passes only because of the order of the files (run once with a shuffled order).

### Step 4: the cheap checks before every push

**Why.** 8 of 50 runs failed and each cost a full cycle: 2 in the diagram check and 4 in the Rust and contract step, whose generator checks and format check, like the diagram check, also run locally. Which command failed in the Rust step is read from the logs of those runs when step 1 is built. The write-up puts the checks in a hook because agents skip a line in AGENTS.md.

**Scope.** A `pre-push` hook, installed by `pnpm install` (a `prepare` script setting `core.hooksPath` to a checked-in directory), that runs on the changed files only: `prettier --check`, `eslint`, the generator `--check` commands, `cargo fmt --check` and the Mermaider `check` (the local tool at the pinned revision of `.mermaider/tool-revision`). It does not run `cargo clippy` or tests. A `--no-verify` push is the owner's override; CI is still the gate.

**Acceptance.** The hook runs in under 30 s on a laptop for a typical change (*target*); the share of failed runs caused by formatting, generated files or diagrams falls to none in the next 20 runs.

### Step 5: skip what a pull request cannot affect

**Why.** Three docs-only pull requests ran the full 22 to 25 minutes (1.1), and most pull requests change only the Workers' TypeScript, which the Rust crates, the kernel test and the node image do not read.

**Built.** The job `changes` runs `scripts/ci/scope.ts scope` and outputs two parts: `native` (the Rust crates, `kernel`, `node-image`) and `workers` (`api-tests`, `edge-tests`). `static`, `other-tests` and the gate run for every change.

| Changed files of a pull request | `native` | `workers` |
| --- | --- | --- |
| Only documents: `docs/**`, top-level `*.md` and `.mermaider/**` (the diagrams' bookkeeping, which only `static` reads) | no | no |
| Only documents and the Workers' TypeScript: `apps/api/**`, `apps/edge/**`, `apps/release-signer/**`, `packages/cli/**` | no | yes |
| Anything else, a path no rule names, or no file at all | yes | yes |

- **Only on `pull_request`.** A push to main, which `sign-release` signs, a dispatch and every other event run everything; the gate needs every job to have succeeded then.
- **Replayed on history (*measured*).** The rules applied to the file lists of the last 40 commits of main: 21 would run everything, 12 would skip the native jobs and 7 would skip both parts. The first replay put none in the middle class, because every API change also regenerates `.mermaider/manifest.json`; the class was added after that. The replay is a check of the rules against real changes, not a prediction of time.
- **How the rules were found.** By reading what the native and image jobs read: no Rust source, `Cargo.toml` or script of the image reads these TypeScript apps (the only hits are comments), and the one test of the image tooling that reads the API moved to `other-tests`. A nested `README.md` is not a document in the rule, because a test may read it; it runs everything.
- **The gate** (`scope.ts gate`, tested in `scope.test.ts`) accepts a skipped job only when `changes` said its part was left out; a skipped job whose part is in scope, a failed or cancelled job and a missing answer fail it. `ci-jobs.test.ts` fails if the gate's `needs` or a job's condition drifts from the one table in `scope.ts`.

**Acceptance.** A docs-only pull request finishes in about the time of `static`, under 2 minutes (*estimate*); a change to the Workers' TypeScript no longer waits for Rust or the image; a hidden-change test fails the run (`scope.test.ts`: one Rust path among 100 other files runs everything); the push to main of the same commit still runs every job.

### Step 6: a bigger runner, only if it is still needed

**Condition.** After steps 1 to 5 the run is still over the target (section 5) and the audit shows the longest job is CPU-bound (Rust compile, Workerd tests).

**Scope.** GitHub's larger hosted runners for named jobs (more vCPUs for the same job), measured on one job first. They are paid per minute even in a public repository, so this step needs **the owner's explicit, costed go** (AGENTS.md). They are GitHub-hosted, so `runner_environment` should stay `github-hosted` at the signer; verify that claim before relying on it, and never move `sign-release` off the standard runner.

**Acceptance.** The measured saving in seconds per run, against the price per run, goes to the owner before any switch.

### 3.1 Where the time goes next (*measured*, 1.7)

On a full run `node-image` (582 to 676 s) and `rust` (525 to 622 s) are the longest jobs. Neither is shortened by a cache under the rule of step 2. What the measurements name as candidates, each to be taken only against a problem still seen after the median over 20 runs:

- **`rust`:** the node agent's library tests are about 305 s of its `cargo test`, and the other test binaries about 80 s. Running the agent's library tests as a job of their own would cut `rust` by about two thirds, but a full run would still wait for `node-image`. A test inside the agent's 934 that dominates would be found with the per-test times (`cargo test -- --report-time` needs nightly; `cargo nextest` prints them) before anything is split.
- **`node-image`:** the image build is 257 s and not split yet (package download against assembly); the cold release build is 120 s.
- **`api-tests` and `edge-tests`:** 233 to 355 s and 249 to 313 s; the shard of step 3 and the cached `worker-build` of step 2 (decision CI-2) are for the pull requests that skip the native jobs.

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
