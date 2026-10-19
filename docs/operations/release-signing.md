# Release signing

A node runs a release as root: its agent downloads four binaries and installs the packages of a lock
with apt. The release key makes sure that only what CI built and signed gets there. Without it, whoever
held an administrator API key and write access to the archive bucket could have registered a release of
binaries of their own and had every node run them. With it, such a release is refused by every node,
because the agent checks a signature that only CI can make. The design is in the
[ULTRA plan](../architecture/cloudflare-convergence-and-serverless-plan.md) (sections 8 and 9.3).

## How it works

- **The key.** An Ed25519 key pair. The private half is the GitHub Actions secret `RELEASE_SIGNING_KEY`
  and is in no other place. The public half is the file `apps/node-agent/release-signing.pub` (64
  lower-case hex digits), which the agent's build reads as a constant. A node has no setting, file or
  flag that changes the key it trusts.
- **What is signed.** The manifest of the release, one fixed text: the line `pgcf-release-manifest/v1`
  (so that a signature made for anything else never verifies as a release's), then `release=<id>`, the
  `<sha256>:<size>` of `pgcf-agent`, `pgcf-native-gateway`, `pgcf-archive` and `pgcf-wal-fetch`, the
  Debian snapshot, and the `<sha256>:<size>` of the package lock, one `name=value` line each, every
  line ended by a line feed. The lock in turn pins every package and every download (cloudflared)
  a maintenance cycle installs, so the signature reaches all of them. The contract is
  `signedReleaseManifest` in `packages/contracts/src/releases.ts`; the agent builds the same text of its
  desired page, and a shared vector keeps the two equal.
- **Who signs.** CI, in the `node-image` job, after it built the image and before it keeps the release
  files: `scripts/operations/sign-release.ts sign` writes `release.sig` beside the files. Only a push to
  `main` of this repository signs. A pull request has no secret and signs nothing; its dry run says
  "not signed".
- **Registration.** `register-node-image.ts` reads `release.sig`, checks it against
  `apps/node-agent/release-signing.pub` and stops before it uploads anything if it does not verify, so
  that no release that every node would refuse is ever registered. It sends the signature in the
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

## Making the key (once, by the owner)

The private key must never be on a disk or in a terminal. The command writes the public key to the file
and the private key only to its standard output, which it refuses to do on a terminal, so pipe it:

```sh
node scripts/operations/sign-release.ts keygen --public apps/node-agent/release-signing.pub --replace \
  | gh secret set RELEASE_SIGNING_KEY
```

The repository holds a public key of which nobody has the private half, so that every build compiles
before the real key exists. `--replace` swaps it for the real one. Commit the changed
`release-signing.pub` in the commit that ships the first agent that verifies. The order matters:

1. Make the key as above, and commit the public key file.
2. Merge to `main`. Until the secret is set the `node-image` job fails at "Sign the release" with
   `RELEASE_SIGNING_KEY is not set`, and a pull request never fails for it. Nothing reaches a node
   from a build that did not sign.
3. Deploy the API of that commit (migration `0076` removes the releases that were registered without a
   signature and the region assignments that name them; the nodes keep what they run).
4. Download the artifact of the signed build and register it (the registration section of
   [infra/node-image/README.md](../../infra/node-image/README.md)). Assign it to the region.
5. The agents that are running now know no signatures: they install the release by its digests, as
   before. The agent that starts from it is the first that verifies, and every later release is
   checked.

## Rotating the key

The key changes only through a release that the **old** key signed and that ships an agent with the
**new** public key. Until every node runs that release, the nodes trust the old key.

1. Make the new key, and keep its private half out of any file: pipe it into a password manager or the
   clipboard (`| pbcopy`), not into the secret yet. `--replace` changes `release-signing.pub`; commit
   that. The secret `RELEASE_SIGNING_KEY` still holds the old key.
2. Merge to `main`. CI builds the release with the new agent and signs it with the old key. Its dry run
   reports that the signature does not verify with this checkout's key; that is the expected state of
   this one release.
3. Register it with the old public key, which is in git history:
   `git show <commit before step 1>:apps/node-agent/release-signing.pub > .local/old-release.pub`, then
   `register-node-image.ts ... --release-key .local/old-release.pub`. Assign it to every region, and
   wait until `GET /v1/nodes/{id}/release` says `converged` for every node, `fenced` ones excepted
   (those are reinstalled).
4. Set the secret to the new private key (`gh secret set RELEASE_SIGNING_KEY` from the clipboard) and
   clear it. The next build on `main` is signed by the new key and is the first the fleet accepts under
   it.

A node that missed the transition (it was offline) still trusts the old key and refuses the releases
of the new one: reinstall it, as for a lost node.

## If the key is lost or leaked

- **Lost** (the secret is gone and nobody has the PEM): the nodes keep running, serve their databases
  and keep their data, but no release can reach them any more, because no signature a node accepts can
  be made. Make a new key, build an image with its public key, and reinstall every node from that
  image (AddNode in recover mode, plan 9.2 and [recovery.md](recovery.md)). The reinstall restores
  each database from its archive.
- **Leaked**: the same, and at once, because whoever has the key can sign a release that every node
  accepts. Also remove the secret first (`gh secret delete RELEASE_SIGNING_KEY`), so that CI cannot
  sign with it, and treat every release signed since the leak as untrusted.

## What it does not cover

- **A new node's image.** A node installed by AddNode runs the image the installer wrote, which the
  installer checks against the sha256 in the release's spec, not against the signature: a release
  registered with another image would install other code on a new node. The agent baked into an image
  verifies from its first pull; the image itself is outside the signature until the installer has a
  key of its own (open, plan 11.2).
- **Which signed release is current.** The signature says what a release is, not that it is the newest.
  An administrator can still assign an older, signed release to a region. That is how a bad release is
  rolled back, so it stays possible.
- **The key's custody.** Whoever can push to `main` or change the workflow can have CI sign. GitHub's
  branch protection and the secret's scope are the controls here.
- **Binaries after install.** The agent checks digests when it downloads; an attacker who is already
  root on a node is outside this control.

## Checking it

- `node --test scripts/operations/*.test.ts` and `cd packages/contracts && npx vitest run` make
  throwaway keys at test time; no key material is in the repository.
- A node that refuses a release says so in its events (`release_refused`, Workers Logs line
  `node_event`) and with `POST /v1/nodes/{id}/diagnostics`
  ([recovery.md](recovery.md#looking-at-a-node)).
