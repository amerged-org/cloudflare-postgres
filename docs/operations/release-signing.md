# Release signing

A node runs a release as root: its agent downloads four binaries and installs the packages of a lock
with apt. The release key protects the **update path of the nodes that are running**: their agent
checks a signature that only CI can make and refuses every other release. Without it, whoever held an
administrator API key and write access to the archive bucket could have registered a release of
binaries of their own and had every running node run them. The design is in the
[ULTRA plan](../architecture/cloudflare-convergence-and-serverless-plan.md) (sections 8 and 9.3).

It does **not** protect the install path. A node that AddNode installs or recovers runs the image of the
registered release, which the installer checks only against the sha256 in the release's spec, which an
administrator wrote, and the API stores any 128-hex string as the signature without checking it (it holds
no key). So the holder of an administrator key and write access to the bucket can still register a release
with an image of their own and any signature, assign it to a region, and add or recover a node: that node
boots their image, whose agent trusts their key. See [What it does not cover](#what-it-does-not-cover).

## How it works

- **The key.** An Ed25519 key pair. The private half is the secret `RELEASE_SIGNING_KEY` of the GitHub
  **environment** `release-signing`, whose deployment branch policy allows only `main`, and is in no
  other place unless the owner decides to keep a backup (see [Custody](#custody-and-backup)). The public half is the file
  `apps/node-agent/release-signing.pub` (64 lower-case hex digits), which the agent's build reads as a
  constant. A node has no setting, file or flag that changes the key it trusts.
- **What is signed.** The manifest of the release, one fixed text: the line `pgcf-release-manifest/v1`
  (so that a signature made for anything else never verifies as a release's), then `release=<id>`, the
  `<sha256>:<size>` of `pgcf-agent`, `pgcf-native-gateway`, `pgcf-archive` and `pgcf-wal-fetch`, the
  Debian snapshot, and the `<sha256>:<size>` of the package lock, one `name=value` line each, every
  line ended by a line feed. The lock in turn pins every package and every download (cloudflared)
  a maintenance cycle installs, so the signature reaches all of them. The contract is
  `signedReleaseManifest` in `packages/contracts/src/releases.ts`; the agent builds the same text of its
  desired page, and a shared vector keeps the two equal. The image is not in it.
- **Who signs, and why an environment.** CI, in the job `sign-release` of `.github/workflows/ci.yml`.
  It `needs: node-image`, runs only on a push to `main` of this repository (not of a fork), is bound to
  the environment `release-signing`, downloads the artifact of the release that `node-image` built,
  runs `scripts/operations/sign-release.ts sign` and keeps `release.sig` as the artifact
  `pgcf-node-signature-<commit sha>-<run attempt>`. The key is not a repository secret: a repository
  secret is handed to every workflow run of the repository, so a pull request from a branch of the
  same repository, or a run dispatched from any branch, with an edited `ci.yml`, could print it. An
  environment secret is handed only to a job whose run the environment's branch policy admits; a run
  of any other branch is refused the environment and sees nothing. The job `node-image`, which runs
  the cargo build scripts and the image build, holds no key, and `scripts/ci/release-signing-workflow.test.ts`
  fails if any other job names the secret. `sign` fails, and writes nothing, while the secret is
  missing and while `release-signing.pub` still holds the placeholder key (below). A pull request
  signs nothing, and its dry run says "not signed".
- **Registration.** `register-node-image.ts` reads `release.sig`, checks it against
  `apps/node-agent/release-signing.pub` of **its own checkout** and stops before it uploads anything if
  it does not verify, so that no release that every node would refuse is ever registered. That key must
  be the one the build's agent carries: run the registration from a checkout of exactly the commit that
  was built (`git switch --detach <sha>`), never from another one. It sends the signature in the
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

The order matters, because of what each step makes possible. Nothing in these commands is a secret.

1. **Create the environment with its branch policy, and check it.** Do this first: GitHub creates an
   environment without any policy when a workflow names one that does not exist, and a secret set into
   an environment before its policy exists is readable by every branch. `gh` fills `{owner}` and
   `{repo}` from the checkout:

   ```sh
   gh api --method PUT "repos/{owner}/{repo}/environments/release-signing" \
     -F "deployment_branch_policy[protected_branches]=false" \
     -F "deployment_branch_policy[custom_branch_policies]=true"
   gh api --method POST "repos/{owner}/{repo}/environments/release-signing/deployment-branch-policies" \
     -f name=main -f type=branch
   # Check: custom_branch_policies true, protected_branches false, and the one name main.
   gh api "repos/{owner}/{repo}/environments/release-signing" --jq .deployment_branch_policy
   gh api "repos/{owner}/{repo}/environments/release-signing/deployment-branch-policies" --jq '.branch_policies[].name'
   ```

2. **Make the key, once.** The command writes the public key to the file and the private key only to
   its standard output, which it refuses to do on a terminal, so pipe it into the environment secret:

   ```sh
   node scripts/operations/sign-release.ts keygen --public apps/node-agent/release-signing.pub \
     | gh secret set RELEASE_SIGNING_KEY --env release-signing
   ```

   **Run it once.** The secret cannot be read back, so the private key exists in that one place, and the
   public key file is the only other trace of it. The repository holds a placeholder public key of which
   nobody has the private half, which the first run replaces without a flag; a second run refuses,
   because it would overwrite the file of a key that is now in use. A different key is a key change, and
   that is the [rotation](#rotating-the-key) below, never a second first key. If `gh secret set` fails
   in the pipe (no login, no environment), the file has already been replaced and the private key is
   gone: run the command again with `--replace` before you commit anything, then check that the secret
   exists with `gh secret list --env release-signing`.
3. **Commit the changed `apps/node-agent/release-signing.pub`** on the branch that ships the first agent
   that verifies, and merge only that commit (or a later one) to `main`; do not merge the branch before
   this commit is on it. A commit of `main` whose key file is still the placeholder is never signed:
   `sign` fails with a message that says so, even when the secret is already set, because a build of the
   placeholder would be signed with a key that its agent does not trust. The run of that commit stays red
   and nothing reaches a node; the run of the commit that carries the real key is the one to register.
   While the secret is missing, a push to `main` is red at "Sign the release" and nothing else; once the
   secret is set, re-run the failed jobs of the run of the commit that carries the real key: the signing
   job downloads the artifact of the build job by id and does not build again.
4. **Deploy the API of that commit.** Migration `0077` removes the releases that were registered without
   a signature and the region assignments that name them; the nodes keep what they run.
5. **Download the artifacts and register.** A run of `main` keeps two artifacts for 7 days: the release
   files (`pgcf-node-release-<sha>-<attempt>`) and the signature (`pgcf-node-signature-<sha>-<attempt>`).
   Check out the commit that was built (`git switch --detach <sha>`), then register with
   `--signature` naming the downloaded `release.sig`; the registration section of
   [infra/node-image/README.md](../../infra/node-image/README.md) has the commands. Assign the release to
   the region.
6. The agents that are running now know no signatures: they install the release by its digests, as
   before. The agent that starts from it is the first that verifies, and every later release is
   checked.

## Custody and backup

The only copy of the private key is the environment secret. If it is lost (the environment or the
repository is deleted, or the secret is removed by mistake) and nobody has a copy, no release can reach
the nodes any more and every node has to be reinstalled (below). Whether to keep an offline backup in a
password manager is a **decision for the owner**: a copy protects against that loss and is a second place
from which the key can leak. It has to be decided before step 2, because the key cannot be fetched
afterwards (a backup later is a rotation): a backup is made by letting the command's output pass through
the password manager's command line tool on its way to `gh secret set`.

## Rotating the key

The key changes only through a release that the **old** key signed and that ships an agent with the
**new** public key. Until every node runs that release, the nodes trust the old key.

1. Make the new key, and keep its private half out of any file and out of the clipboard (a clipboard
   history is kept on disk): pipe it into your password manager's command line tool (for 1Password,
   `op document create`; see its `--help` for reading standard input), not yet into the secret.
   `--replace` is required and changes `release-signing.pub`; commit that. The secret
   `RELEASE_SIGNING_KEY` still holds the old key.
2. Merge to `main`. CI builds the release with the new agent and signs it with the old key (the job
   refuses only the placeholder, not a key that differs from the file). Its dry run reports that the
   signature does not verify with this checkout's key; that is the expected state of this one release.
3. Register it with the old public key, which is in git history, from a checkout of that commit:
   `git show <commit before step 1>:apps/node-agent/release-signing.pub > .local/old-release.pub`, then
   `register-node-image.ts ... --release-key .local/old-release.pub`. Assign it to every region, and
   wait until `GET /v1/nodes/{id}/release` says `converged` for every node, `fenced` ones excepted
   (those are reinstalled).
4. Set the secret to the new private key by reading it from the password manager into the pipe, never
   through a file or the clipboard (for 1Password,
   `op document get "<title>" | gh secret set RELEASE_SIGNING_KEY --env release-signing`). The next
   build on `main` is signed by the new key and is the first the fleet accepts under it.

A node that missed the transition (it was offline) still trusts the old key and refuses the releases
of the new one: reinstall it, as for a lost node.

## If the key is lost or leaked

- **Lost** (the secret is gone and nobody has the PEM): the nodes keep running, serve their databases
  and keep their data, but no release can reach them any more, because no signature a node accepts can
  be made. Make a new key, build an image with its public key, and reinstall every node from that
  image (AddNode in recover mode, plan 9.2 and [recovery.md](recovery.md)). The reinstall restores
  each database from its archive.
- **Leaked**: the same, and at once, because whoever has the key can sign a release that every node
  accepts. Also remove the secret first (`gh secret delete RELEASE_SIGNING_KEY --env release-signing`),
  so that CI cannot sign with it, and treat every release signed since the leak as untrusted.

## What it does not cover

- **The install and reinstall path (open decision).** A node installed by AddNode, new or in recover
  mode, runs the image the installer wrote. The installer checks that image only against the sha256
  in the release's spec, which an administrator wrote, and the API does not check the signature it
  stores. So with an administrator key and write access to the bucket, someone can register a release with
  an image of their own and any 128-hex string as the signature, assign it, and add or recover a node;
  the agent in that image trusts their key and verifies nothing of ours. The installer is not out of
  reach of a signature, though: its script is Worker code (`node-installer-files.generated.ts`,
  generated from `infra/node-image/installer/install.sh`), which an administrator key cannot change.
  The Worker can therefore carry the release public key to the installer, and CI can sign the image's
  digests. That is a follow-up that is not built; whether to build it or to accept the risk is the
  owner's decision (plan 11.2, "Signed node image").
- **Which signed release is current.** The signature says what a release is, not that it is the newest.
  An administrator can still assign an older, signed release to a region. That is how a bad release is
  rolled back, so it stays possible.
- **The key's custody.** Whoever can push to `main` or change the workflow there can have CI sign, and
  a repository administrator can change the environment's branch policy. Branch protection of `main`
  and who holds administrator rights on the repository are the controls here.
- **Binaries after install.** The agent checks digests when it downloads; an attacker who is already
  root on a node is outside this control.

## Checking it

- `node --test scripts/operations/*.test.ts scripts/ci/*.test.ts` and `cd packages/contracts && npx vitest run`
  make throwaway keys at test time; no key material is in the repository.
- A node that refuses a release says so in its events (`release_refused`, Workers Logs line
  `node_event`) and with `POST /v1/nodes/{id}/diagnostics`
  ([recovery.md](recovery.md#looking-at-a-node)).
