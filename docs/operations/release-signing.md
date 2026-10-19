# Release signing

A node runs a release as root: its agent downloads four binaries and installs the packages of a lock
with apt. The release key protects the **update path of the nodes that are running**: their agent
checks a signature that only a push to `main` of this repository can have made, and refuses every other
release. Without it, whoever held an administrator API key and write access to the archive bucket could
have registered a release of binaries of their own and had every running node run them. The design is in
the [ULTRA plan](../architecture/cloudflare-convergence-and-serverless-plan.md) (sections 8 and 9.3).

It does **not** yet protect the install path. A node that AddNode installs or recovers runs the image of
the registered release, which the installer checks only against the sha256 in the release's spec, which
an administrator wrote, and the API stores any 128-hex string as the signature without checking it (it
holds no key). So the holder of an administrator key and write access to the bucket can still register a
release with an image of their own and any signature, assign it to a region, and add or recover a node:
that node boots their image, whose agent trusts their key. That is an open decision, below.

## How it works

- **The key.** An Ed25519 key pair. The private half is the secret `RELEASE_SIGNING_KEY` of the signer, a
  Cloudflare Worker (`apps/release-signer`, deployed as `pgcf-release-signer-dev`). A Cloudflare secret
  is write-only: no person, no CI job and no other Worker can read it back, and the key pair is made in
  the memory of `provision` and never written to a disk, a log or a terminal, so there is no copy to
  steal. The public half is the file `apps/node-agent/release-signing.pub` (64 lower-case hex digits),
  which the agent's build reads as a constant. A node has no setting, file or flag that changes the key
  it trusts.
- **Why not a GitHub secret.** A repository secret is handed to every workflow run of the repository, so
  a pull request from a branch of the same repository, or a run dispatched from any branch, with an
  edited `ci.yml`, could print it; an environment secret needs a branch policy that has to be created
  and checked before the secret is set, and it can be read by any job the policy admits. A secret that
  GitHub holds is also a secret that the job's code can read. Here no job holds a key at all.
- **What is signed.** The manifest of the release, one fixed text: the line `pgcf-release-manifest/v1`
  (so that a signature made for anything else never verifies as a release's), then `release=<id>`, the
  `<sha256>:<size>` of `pgcf-agent`, `pgcf-native-gateway`, `pgcf-archive` and `pgcf-wal-fetch`, the
  Debian snapshot, and the `<sha256>:<size>` of the package lock, one `name=value` line each, every
  line ended by a line feed. The lock in turn pins every package and every download (cloudflared)
  a maintenance cycle installs, so the signature reaches all of them. The contract is
  `signedReleaseManifest` in `packages/contracts/src/releases.ts`; the agent builds the same text of its
  desired page, and a shared vector keeps the two equal. The image is not in it.
- **The signer** takes `POST /sign` and nothing else (every other path is 404, every other method 405).
  The caller sends the manifest's fields, which `ReleaseManifestFields` in the contracts defines, as
  JSON, with a GitHub Actions OIDC identity token as the bearer credential. The signer checks the
  token's RS256 signature against GitHub's keys (`token.actions.githubusercontent.com/.well-known/jwks`,
  kept for five minutes and fetched again, at most once in half a minute, for a key id it does not
  know), and then these claims, each with a refusal of its own:

  | Claim | Must be | Refusal |
  | --- | --- | --- |
  | signature, `alg` | GitHub's key, `RS256` | `token_signature`, `token_algorithm`, `token_key_unknown` |
  | `iss` | `https://token.actions.githubusercontent.com` | `token_issuer` |
  | `aud` | the signer's own https origin, the address the run reached it at | `token_audience` |
  | `exp`, `nbf` | current, with a minute of skew | `token_expired`, `token_not_yet_valid` |
  | `repository`, `repository_owner` | the variable `SIGNER_REPOSITORY` and its owner | `claim_repository`, `claim_repository_owner` |
  | `ref` | the variable `SIGNER_REF` (`refs/heads/main`) | `claim_ref` |
  | `event_name` | `push` (not a pull request, not a dispatch) | `claim_event_name` |
  | `job_workflow_ref` | `<repository>/<SIGNER_WORKFLOW>@<ref>` (`.github/workflows/ci.yml`) | `claim_job_workflow_ref` |
  | `runner_environment` | `github-hosted` | `claim_runner_environment` |
  | `sha` | 40 hex digits, and the manifest's release id is `sha-<its first 12 digits>` | `claim_sha`, `release_not_of_commit` |

  The three variables are in `apps/release-signer/wrangler.jsonc`, which holds no secret and no account
  id and is tracked; a fork changes them. The signer validates the manifest's fields strictly (no key
  beyond them, every value against its pattern; `manifest_invalid`), builds the text itself with the
  domain line above, signs it with WebCrypto Ed25519 and answers with the signature as text, 128 hex
  digits and a line feed, which is the format that is stored. It signs nothing else. It logs the
  release id of what it signed and the code of every refusal, and no token, key or digest.
- **The signer keeps no state, and needs none.** Ed25519 is deterministic: the same facts give the same
  signature byte for byte, so asking twice reveals and changes nothing, and nothing has to be counted to
  rate-limit it. Which content a release id may have is decided where it is registered: the API refuses
  a second signature for a registered version, R2 never overwrites a file of one, and every node checks
  each digest of its release against the signed text. What the signer ties together itself is the
  release id and the commit: a run can have `sha-<its own commit>` signed and no other name. What it
  cannot know is whether the digests belong to the build of that commit: that is the trust in the
  workflow file on `main`, which is the next point.
- **Who asks.** The job `sign-release` of `.github/workflows/ci.yml`. It `needs: node-image`, runs only
  on a push to `main` of this repository (not of a fork), has `id-token: write` and holds no secret and
  no environment, downloads the artifact of the release that `node-image` built, and runs
  `scripts/operations/sign-release.ts sign`: it asks GitHub for an identity token for the signer's
  address (the repository variable `RELEASE_SIGNER_URL`, an origin) as its audience, posts the manifest's
  facts to the signer and keeps the answer as `release.sig` in the artifact
  `pgcf-node-signature-<commit sha>-<run attempt>`. It installs dependencies with `--ignore-scripts`,
  so that the only code that runs with the runner's token credential is that script. It **fails**, it is
  never skipped, on a push to `main` when `RELEASE_SIGNER_URL` is not set, when the signer cannot be
  reached or answers anything but 200 with a signature, and while `release-signing.pub` still holds
  the placeholder key. `scripts/ci/release-signing-workflow.test.ts` fails if the job names a secret or
  an environment, if `id-token: write` is granted to any job but this one and the dispatch-only
  `external_probe` (which attests its report and whose token says `workflow_dispatch`, which the signer
  refuses), or if a step could pass over the signing. A pull request, a run of another branch or a
  dispatched run, even with an edited `ci.yml`, gets no signature: its token names another `ref`,
  `event_name` or `job_workflow_ref`, and the signer does not accept it.
- **Registration.** `register-node-image.ts` reads `release.sig`, checks it against
  `apps/node-agent/release-signing.pub` of **its own checkout** and stops before it uploads anything if
  it does not verify, so that no release that every node would refuse is ever registered. That key must
  be the one the build's agent carries: **register only from a checkout of exactly the commit that was
  built** (`git switch --detach <sha>`), never from another one. It sends the signature in the
  registration. The API requires a signature of 64 bytes in hex, stores it in the release's immutable
  spec and cannot check it: it holds no key. `GET /v1/fleet/releases/{id}` shows it as `spec.signature`,
  and the Worker serves it, to anyone, as the text of `/node/v1/releases/{id}/release.sig`.
- **The node.** Before it downloads, stages or installs anything of a release, and before a maintenance
  cycle plans the packages of its lock, the agent reads that file, builds the manifest of its desired
  page and checks the signature with the compiled-in key. A release that fails stays where it is: the
  node keeps running its current binaries, nothing of the release is fetched, and the node reports
  the event `release_refused` with the class `release_signature_missing` (the API has no signature
  for it) or `release_signature_invalid` (it is not the key's signature of this release). A maintenance
  order for it fails with the same class as `result_reason`. A signature that could not be read (the
  network, a server error) is not a verdict: the agent tries again with the next page, and an order
  fails with `signature_not_read`.

## Setting it up (once, by the owner)

The order matters, because of what each step makes possible. Nothing in these commands is a secret, and
no step prints one.

1. **Deploy the signer.** From `apps/release-signer`, with the Cloudflare credentials of the account
   that holds the control plane (the variables Wrangler reads; `pnpm install` has been run):

   ```sh
   cd apps/release-signer && npx wrangler deploy
   ```

   The Worker is `pgcf-release-signer-dev`, reachable at its `workers.dev` address (Wrangler prints it;
   it is also in the dashboard under Workers). It has no secret yet, so every request is refused. A
   fork edits the three variables in `wrangler.jsonc` first.

2. **Provision the key, once.** The command makes the key pair in memory, sets the private half as the
   Worker's secret through the Cloudflare API, and only after the API accepted it writes the public key
   to `apps/node-agent/release-signing.pub`. The API token (permission Workers Scripts: Edit on the
   account) and the account id are read from the environment variables whose **names** you give; a
   value never goes on the command line:

   ```sh
   node scripts/operations/release-signing.ts provision \
     --token-env CLOUDFLARE_API_TOKEN --account-env CLOUDFLARE_ACCOUNT_ID
   ```

   It prints the public key's fingerprint (the sha256 of its 32 bytes) and the next steps, and nothing
   else about the key. It **refuses** while the Worker already holds the secret (it lists the secrets
   by name) or the committed public key is not the placeholder, because the secret cannot be read back
   and a second key would replace the one the nodes trust; `--rotate` overrides both and is the key
   change below, never a second first key. A failure of any step leaves the previous state: nothing is
   written to the file unless the API accepted the secret, and the file is replaced all at once. If the
   file cannot be written after the secret was set, the error contains the public key to put there (it
   is no secret); if the API's answer to the secret never arrives, the error says that it is not known
   whether the Worker holds a new key and gives the public half, and the file is unchanged.

3. **Commit the public key and set the variable.** Commit the changed
   `apps/node-agent/release-signing.pub` on the branch that carries this design, and set the repository
   variable to the signer's origin (no path, no trailing slash needed):

   ```sh
   gh variable set RELEASE_SIGNER_URL --body "https://pgcf-release-signer-dev.<subdomain>.workers.dev"
   ```

4. **Merge only with the real key on the branch.** This is a precondition: **the real public key must be
   on the branch before it merges.** A commit of `main` whose key file is still the placeholder is
   never signed: `sign-release.ts` fails with a message that says so, because a build of the placeholder
   would be signed with a key that its agent does not trust, and every push to `main` is then red at the
   job `sign-release` and nothing reaches a node. The same is true while `RELEASE_SIGNER_URL` is unset
   or the signer is not deployed. Once the cause is fixed, re-run the failed jobs of the run of the
   commit that carries the real key: the signing job downloads the artifact of the build job by id and
   does not build again.

5. **Deploy the API of that commit.** Migration `0077` removes the releases that were registered without
   a signature and the region assignments that name them; the nodes keep what they run.

6. **Download the artifacts and register.** A run of `main` keeps two artifacts for 7 days: the release
   files (`pgcf-node-release-<sha>-<attempt>`) and the signature (`pgcf-node-signature-<sha>-<attempt>`).
   Check out the commit that was built (`git switch --detach <sha>`), then register with
   `--signature` naming the downloaded `release.sig`; the registration section of
   [infra/node-image/README.md](../../infra/node-image/README.md) has the commands. Assign the release to
   the region.

7. The agents that are running now know no signatures: they install the release by its digests, as
   before. The agent that starts from it is the first that verifies, and every later release is
   checked.

## Rotating the key

The key changes only through a release that the **old** key signed and that ships an agent with the
**new** public key. Until every node runs that release, the nodes trust the old key. One Worker holds
one secret and a secret cannot be read back, so the new key cannot wait in the old Worker: it is made
in a second signer, and the cut-over is the repository variable.

1. Deploy a second signer from the same code under another name, with the same variables:
   `cd apps/release-signer && npx wrangler deploy --name pgcf-release-signer-next`.
2. `node scripts/operations/release-signing.ts provision --rotate --worker pgcf-release-signer-next
   --token-env … --account-env …` makes the new key in memory, sets it as the second signer's secret
   and writes its public half to `release-signing.pub`. The old signer still holds the old key, and
   the nodes trust it.
3. Commit the changed `release-signing.pub` and merge. CI builds the release with the agent that trusts
   the new key, and `RELEASE_SIGNER_URL`, still the old signer's address, has it signed with the **old**
   key. The dry run reports that the signature does not verify with this checkout's key; that is the
   expected state of this one release. Merge nothing else to `main` until step 5: every build before it
   is signed by the old key and is refused by the nodes that already run the new agent.
4. Register it with the old public key, which is in git history, from a checkout of that commit:
   `git show <commit before step 3>:apps/node-agent/release-signing.pub > .local/old-release.pub`, then
   `register-node-image.ts ... --release-key .local/old-release.pub`. Assign it to every region, and
   wait until `GET /v1/nodes/{id}/release` says `converged` for every node, `fenced` ones excepted
   (those are reinstalled).
5. Point `RELEASE_SIGNER_URL` at the second signer (`gh variable set RELEASE_SIGNER_URL --body …`), set
   `name` in `apps/release-signer/wrangler.jsonc` to the second signer's name so that later deploys
   update it, and delete the old Worker (`npx wrangler delete --name pgcf-release-signer-dev`), so that
   the old key can sign nothing more. The next build on `main` is signed by the new key and is the first
   the fleet accepts under it.

A node that missed the transition (it was offline) still trusts the old key and refuses the releases
of the new one: reinstall it, as for a lost node. Rotating in place (`provision --rotate` against the
same Worker) is a cut-over with no transition: the old key stops signing at once, and no running node
accepts a release again until it is reinstalled.

## If the secret is lost

**The secret cannot be recovered, and there is no backup, by design.** The key was never written
anywhere, so nobody can leak it and nobody can restore it. If the Worker is deleted, the secret is
removed or overwritten by mistake, or the Cloudflare account is lost, and no other signer holds the
key, no signature that a node accepts can be made any more: the nodes keep running, serve their
databases and keep their data, but no release can reach them again, and **every node has to be
reinstalled** from an image built with a new key's public half. Deploy a signer, run
`provision --rotate` against it (the committed key is not the placeholder), commit the new public key,
build and register the image, and reinstall every node (AddNode in recover mode, plan 9.2 and
[recovery.md](recovery.md)); each database is restored from its archive. If the account is under
someone else's control, treat the key as lost and do the same, and also delete the secret first
(`npx wrangler secret delete RELEASE_SIGNING_KEY --name pgcf-release-signer-dev`) if you still can, and
treat every release signed since the compromise as untrusted.

## What is and is not protected

- **Protected: the update path of the nodes that are running.** An agent installs only a release that
  the key signed, so an administrator API key together with write access to the archive bucket can no
  longer make a running node run a binary of its own.
- **Not protected: the install and reinstall path (open decision for the owner).** A node installed by
  AddNode, new or in recover mode, runs the image the installer wrote. The installer checks that image
  only against the sha256 in the release's spec, which an administrator wrote, and the API does not
  check the signature it stores. So with an administrator key and write access to the bucket, someone
  can register a release with an image of their own and any 128-hex string as the signature, assign it,
  and add or recover a node; the agent in that image trusts their key and verifies nothing of ours. The
  installer is not out of reach of a signature, though: its script is Worker code
  (`node-installer-files.generated.ts`, generated from `infra/node-image/installer/install.sh`), which
  an administrator key cannot change. The Worker can therefore carry the release public key to the
  installer, and CI can have the signer sign the image's digests. That follow-up is not built; whether
  to build it or to accept the risk is the owner's decision (plan 11.2, "Signed node image").
- **Which signed release is current.** The signature says what a release is, not that it is the newest.
  An administrator can still assign an older, signed release to a region. That is how a bad release is
  rolled back, so it stays possible.
- **The trust root.** Whoever can push to `main`, or change `ci.yml` there, can have CI ask for a
  signature of digests of their choosing; the signer authenticates the workflow, not the bytes. Whoever
  can deploy the signer's code (the Cloudflare account) can deploy a signer that signs anything with the
  secret it is bound to. Branch protection of `main`, who holds administrator rights on the repository
  and who can deploy Workers in the account are the controls here. A token that leaks from a job is
  valid for a few minutes and signs only the release of its own commit.
- **Binaries after install.** The agent checks digests when it downloads; an attacker who is already
  root on a node is outside this control.

## Checking it

- `cd packages/contracts && npx vitest run`, `cd apps/release-signer && npx vitest run` (the signer's
  tests run in workerd, with a key and an RSA JWKS made at test time, and check a signature with the
  text the agent verifies) and
  `node --test scripts/operations/*.test.ts scripts/ci/*.test.ts` (the provisioning command against a
  Cloudflare API on the loopback interface, the CI step against a stand-in signer and token endpoint, and
  the structure of the workflow). No key material is in the repository.
- The first push to `main` after the setup is the live check: the job `sign-release` is green and its
  dry run says `signature verifies`. The signer's logs (Workers Logs of `pgcf-release-signer-dev`) hold
  one `signed` line with the release id for it, and a `refused` line with a code for every other
  request.
- A node that refuses a release says so in its events (`release_refused`, Workers Logs line
  `node_event`) and with `POST /v1/nodes/{id}/diagnostics`
  ([recovery.md](recovery.md#looking-at-a-node)).
