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
  is write-only through the API and the dashboard: no person, no CI job and no other Worker can read it
  back, and the key pair is made in the memory of `provision` and never written to a disk, a log or a
  terminal, so there is no copy to steal. **The signer's own code can read it**, because it is bound to
  the Worker as `env.RELEASE_SIGNING_KEY`: whoever can deploy a version of that Worker (a member of the
  Cloudflare account, or any API token with Workers Scripts: Edit) can deploy code that returns the key,
  keep it for good, and redeploy the real code afterwards without a trace in the Worker's behaviour.
  Edit access to Workers in the account is therefore access to the key (see "The trust root" and "If the
  secret is lost or may have been disclosed"). The public half is the file
  `apps/node-agent/release-signing.pub` (64 lower-case hex digits), which the agent's build reads as a
  constant. A node has no setting, file or flag that changes the key it trusts.
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
  | `repository_id`, `repository_owner_id` | the variables `SIGNER_REPOSITORY_ID` and `SIGNER_REPOSITORY_OWNER_ID`, GitHub's numeric ids, which a rename, a transfer or a deletion of the name does not move | `claim_repository_id`, `claim_repository_owner_id` |
  | `ref` | the variable `SIGNER_REF` (`refs/heads/main`) | `claim_ref` |
  | `event_name` | `push` (not a pull request, not a dispatch) | `claim_event_name` |
  | `job_workflow_ref` | `<repository>/<SIGNER_WORKFLOW>@<ref>` (`.github/workflows/ci.yml`) | `claim_job_workflow_ref` |
  | `runner_environment` | `github-hosted` | `claim_runner_environment` |
  | `sha` | 40 hex digits, and the manifest's release id is `sha-<its first 12 digits>` | `claim_sha`, `release_not_of_commit` |

  The variables are in `apps/release-signer/wrangler.jsonc`, which holds no secret and no account id and
  is tracked; a fork changes them (`gh api repos/OWNER/REPO --jq '.id, .owner.id'` prints the two ids).
  The ids matter because a name can be freed and taken by someone else: whoever re-creates
  `amerged-org/cloudflare-postgres` after a rename, a transfer or a deletion and pushes a `ci.yml` to its
  `main` gets tokens with the right names and other ids, which the signer refuses. After a transfer or
  rename of the repository the signer refuses everything until the variables are updated and the Worker
  is deployed again. The signer validates the manifest's fields strictly (no key
  beyond them, every value against its pattern; `manifest_invalid`), builds the text itself with the
  domain line above, signs it with WebCrypto Ed25519 and answers with the signature as text, 128 hex
  digits and a line feed, which is the format that is stored. It signs nothing else. It logs the
  release id of what it signed and the code of every refusal, and no token, key or digest.
- **The signer keeps no state, and needs none.** Ed25519 is deterministic: the same facts give the same
  signature byte for byte, so asking twice with the same facts changes nothing. It does **not** limit
  what one token can have signed: the same token gets a valid signature for different digests under the
  same release id, and the signer cannot tell whether the digests are the build of that commit. What it
  ties together is the release id and the commit: a token can have `sha-<its own commit>` signed and no
  other name, with whatever digests it posts, until its `exp` plus the minute of skew. Which content a
  release id has is decided where it is registered: the API refuses a second, different spec for a
  registered version (409 for whoever registers second), R2 never overwrites a file of one, and every
  node checks each digest of its release against the signed text. So a leaked token, or any code that
  runs in the signing job, can have a signature made for digests of its own as the release of that
  commit, and the signature can be used by whoever holds an administrator key and write access to the
  bucket, the very threat the key exists for. Only the owner registering the real build first (the
  API's 409 goes to whoever registers first, and the run's artifacts stay downloadable for 7 days) keeps
  such a release from being installable. Trusting the digests is trusting the workflow file on `main`,
  which is the next point.
- **Who asks.** The job `sign-release` of `.github/workflows/ci.yml`. It `needs: [check, node-image]`,
  so a commit whose tests failed (`check` runs `cargo test`, which includes the agent's verification
  tests) or whose image did not build and boot is never signed; it runs only on a push to `main` of this
  repository (not of a fork), has `id-token: write` and holds no secret and no environment, downloads
  the artifact of the release that `node-image` built, and runs `scripts/operations/sign-release.ts
  sign`: it asks GitHub for an identity token for the signer's address (the repository variable
  `RELEASE_SIGNER_URL`, an origin) as its audience, posts the manifest's facts to the signer and keeps
  the answer as `release.sig` in the artifact `pgcf-node-signature-<commit sha>-<run attempt>`. It
  installs dependencies with `--ignore-scripts` and restores no cache that another job wrote. **That
  does not keep other code away from the token's credential:** with `id-token: write`, the runner's
  `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` are in the environment of every
  step of the job (the actions it uses, `toolchain.mjs`, pnpm, the registration script's dry run and
  every module `sign-release.ts` imports), and `node-image` runs the locked dependencies and produces the
  bytes that get signed. See "The trust root". The job **fails** on a push to `main` when
  `RELEASE_SIGNER_URL` is not set, when the signer cannot be reached or answers anything but 200 with a
  signature, and while `release-signing.pub` still holds the placeholder key; it is not run, and the run
  is red, when `check` or `node-image` failed. `scripts/ci/release-signing-workflow.test.ts` fails if
  the job names a secret or an environment, drops a need, takes more permissions than the checkout and
  the token, restores a cache, if `id-token: write` is granted to any job but this one and the
  dispatch-only `external_probe` (which attests its report and whose token says `workflow_dispatch`,
  which the signer refuses), or if a step could pass over the signing. A pull request, a run of another
  branch or a dispatched run, even with an edited `ci.yml`, gets no signature: its token names another
  `ref`, `event_name` or `job_workflow_ref`, and the signer does not accept it.
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
   fork edits the variables in `wrangler.jsonc` first (the repository, its numeric id and its owner's, the
   ref and the workflow file).

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
   else about the key. It **never replaces a secret**: it refuses, whatever else is given, while the
   Worker already holds `RELEASE_SIGNING_KEY` (it lists the secrets by name first), because the secret
   cannot be read back and the one in the Worker may be the only copy of the key every node trusts. It
   also refuses while the committed public key is not the placeholder; `--rotate` lifts only that second
   refusal, for the key change below (to a Worker that holds no secret), never for a second first key.
   A failure of any step leaves the previous state: nothing is written to the file unless the API
   accepted the secret, and the file is replaced all at once. If the file cannot be written after the
   secret was set, the error contains the public key to put there (it is no secret). If the API's answer
   to the secret never arrives, the error says that it is not known whether the Worker holds a new key,
   gives the public half, and leaves the file unchanged; the Worker held no secret before the command,
   so delete the one it may hold with `npx wrangler secret delete RELEASE_SIGNING_KEY --name <worker>`
   and run the command again.

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
   and writes its public half to `release-signing.pub`. **Keep the `--worker` flag:** the command
   refuses a Worker that already holds the secret, whatever else is given, so run without it, it
   stops at the live signer after listing its secrets and changes nothing. The old signer still holds
   the old key, and the nodes trust it.
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
of the new one: reinstall it, as for a lost node. There is no rotating in place: `provision` never
replaces a secret. Deleting the signer's secret by hand (`npx wrangler secret delete
RELEASE_SIGNING_KEY --name <worker>`) and provisioning again is a cut-over with no transition: the
old key stops signing at once, and no running node accepts a release again until it is reinstalled,
which is the loss case below.

## If the secret is lost or may have been disclosed

**The secret cannot be recovered, and there is no backup, by design.** The key was never written
anywhere, so nobody can leak a copy and nobody can restore it. If the Worker is deleted, the secret
is removed or overwritten by mistake, or the Cloudflare account is lost, and no other signer holds the
key, no signature that a node accepts can be made any more: the nodes keep running, serve their
databases and keep their data, but no release can reach them again, and **every node has to be
reinstalled** from an image built with a new key's public half. Deploy a signer, run
`provision --rotate` against a Worker that holds no secret (a new Worker name, or after
`npx wrangler secret delete RELEASE_SIGNING_KEY --name <worker>` for one whose secret is lost or
wrong; `provision` never replaces a secret itself), commit the new public key, build and register the
image, and reinstall every node (AddNode in recover mode, plan 9.2 and [recovery.md](recovery.md));
each database is restored from its archive.

**A key that may have been disclosed is a lost key, and the procedure is the same.** Whoever can
deploy a version of the signer Worker can read the key out of it and keep it, and redeploying the real
code afterwards does not undo that. So apply this procedure not only when the account is under someone
else's control but to any suspected misuse of Workers edit access: an API token with Workers Scripts:
Edit that leaked, a member of the account who should not have had that access, an unexplained version
of the signer Worker in its deployment history. Delete the secret first if you still can (`npx wrangler
secret delete RELEASE_SIGNING_KEY --name pgcf-release-signer-dev`) so that the old key signs nothing
more through the Worker, and treat every release signed since the suspected misuse as untrusted: the
holder of the key can also sign a transition release that carries their own key.

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
- **The trust root.** Two things, and nothing smaller.
  - *The workflow on `main`.* The signer authenticates the workflow, not the bytes. The identity token's
    credential is in the environment of every step of `sign-release`, so what can sign is the file
    `ci.yml` on `main`, the pinned actions it uses, and the locked dependencies that `node-image` (which
    builds the bytes that are signed) and `sign-release` run. Whoever can push to `main`, change
    `ci.yml` there, or get code into one of those dependencies can have digests of their choosing signed.
    A token that leaks, or is taken by any code in that job, can have **any** digests signed as
    `sha-<its own commit>` until its `exp` plus a minute of skew (a few minutes after it was issued);
    only the owner registering the real build first, which the API's 409 enforces for the second
    registrar, stops that release from being installable.
  - *Workers edit access to the Cloudflare account.* Whoever can deploy a version of the signer Worker
    (an account member, or any API token with Workers Scripts: Edit) can deploy code that returns
    `env.RELEASE_SIGNING_KEY` and keeps the key permanently, or that signs anything. Redeploying the real
    code does not undo a disclosure: see "If the secret is lost or may have been disclosed".

  Branch protection of `main`, who holds administrator rights on the repository, the lockfile review, and
  who holds Workers edit rights or API tokens in the account are the controls here.
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
