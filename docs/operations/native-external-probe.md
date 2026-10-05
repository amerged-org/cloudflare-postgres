# Native external TCP probe

Phase 1 E6 scans every node address from the operator and from outside the firewall allowlist.
Cloudflare Workers cannot open outbound TCP connections on port 25, so their scan cannot prove
that port is unreachable. The harness requires an independent native probe for that gap.
[Cloudflare documents this restriction](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#connections-to-port-25-are-prohibited).

The existing `.github/workflows/ci.yml` has an opt-in `external_probe` job on the standard
GitHub-hosted `macos-15` runner. It runs only for a manual dispatch on `main` in a public repository;
the normal checks and image publication are excluded for this dispatch. Standard hosted runners
are free for public repositories under the
[GitHub runner terms](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories).
This procedure needs no extra VPS or paid runner. It is an acceptance tool, not a completed live
acceptance result.

## Complete node installation proof

The same workflow's opt-in `node_network_probe` dispatch uses that free native runner to scan
all 65,535 TCP ports on each approved IPv4 node address. It does not run the ordinary build or
publish jobs. This is the full IPv4 measurement for node preparation/post-join, separate from
the supplemental E6 report described below.

Deploy the temporary `scripts/e2e/probe/source-control-worker.ts` observer from its adjacent
example configuration. Give it a new Ed25519 signing key and bearer, its exact HTTPS origin,
and a canonical UTC expiry no more than ten minutes ahead. Keep logging disabled. Its signed
receipt observes the actual `CF-Connecting-IP` and binds a fresh nonce, timestamp and origin;
it refuses Worker subrequests and ambiguous/pseudo IPv4 headers. Select and record one actual
Cloudflare IPv4 and IPv6 destination from that origin's DNS. The native helper pins each literal,
TLS hostname and actual socket endpoints. The Worker does not claim to observe its CDN address.

Prepare `PGCF_NETWORK_HOSTED_CONFIG` privately as version `1`, with a random 64-hex `nonce`,
`created_at`, `expires_at` (a maximum ten-minute interval), a random 32-byte `encryption_key`
in canonical base64url, an independent measurement `signing_jwk`, and `network`. The latter is
the existing `CommonConfig` from `node-network-proof.ts`: exact plan/readback binding, key ID,
measurement/control public keyrings, and `scan.https_control` containing the observer's
`origin`, private `bearer` and `expires_at`. `scan.tcp25_control` is the independently authorized
public IPv4 SMTP control used by the supplemental probe. Its address is distinct from every
node. The full scan connects to that control on TCP/25 immediately before and after testing
the node's TCP/25; either failed control keeps the entire measurement unproven.

Set only the temporary Actions secret `PGCF_NETWORK_HOSTED_CONFIG` and dispatch:

```sh
gh workflow run ci.yml --repo "$PGCF_E2E_REPOSITORY" --ref main -f node_network_probe=true
```

The runner determines its actual local IPv4 route, binds every scanner/control socket to it,
and obtains its public source from the signed observer. Since NAT may choose different public
addresses for different destinations, it additionally requires the entire fresh published
`actions_macos` pool to be disjoint from every effective node firewall source rule, and requires
the observer's source to be within that pool. Refusals/timeouts with socket errors, incomplete
coverage, changed sources or failed controls do not become a passing scan.

Download the `pgcf-node-network` artifact into an ignored private directory. It contains
`pgcf-node-network.enc.json`, AES-256-GCM encrypted with the one-time configuration key and
attested as its exact encrypted bytes. No raw address or signing key is uploaded. Retain the
same private configuration locally and supply `PGCF_NETWORK_HOSTED_EXPECTATION` with exact
`repository`, `commit`, `run_id` and `run_attempt`; set `PGCF_NETWORK_HOSTED_ARTIFACT` to the
downloaded absolute filename and `PGCF_NETWORK_OUTPUT` to a fresh private receipt filename.
Then run `node scripts/e2e/src/node-network-hosted.ts consume`. Consumption verifies the hosted
main-workflow attestation, exact successful run/artifact and current checkout, decrypts with
bound run/nonce data, rechecks the current source pool and verifies the signed full measurement.
Its original two-minute freshness requirement remains in force; prepare consumption promptly.

IPv6 uses `node-network-proof.ts scan` locally with an actual bound global interface address
outside the complete effective allowlist, and the same `scan.https_control` configuration.
Omit the hosted IPv4 `scan.tcp25_control` from this IPv6 configuration: an IPv4 SMTP control
cannot establish IPv6 egress, and the native helper refuses mixed-family control connections.
Only an independently authorized same-family IPv6 SMTP control can populate that field for IPv6.
The signed observed public IPv6 must equal the bound local IPv6 exactly. An operator sibling
is outside only after the actual firewall uses the reviewed exact `/128`, never while a broader
allow rule still includes it. Supply both independently verified family receipts to the existing
`prepare`/`verify` flow. Every node address still needs a complete 65,535-port measurement.

After success or failure, delete the temporary Actions configuration secret, encrypted GitHub
artifact and observer Worker, and destroy the one-time encryption/signing/bearer inputs. Upload
only the existing final signed preparation/verification artifact to its operation-owned R2 key.
The product proof schema and its allowlist, identity, freshness and quarantine guards are unchanged.

## Prepare the approved Dev run

The operator holding the serial live lane performs the following steps after the relevant live
preparation and supervisor gates are satisfied. Use only the approved Dev inventory and the
reviewed, pushed `main` revision. Do not run against production or broaden a firewall allowlist
to accommodate the probe. The native job needs no Cloudflare, Kubernetes or database credentials.

Obtain the complete, authoritative effective firewall allowlist, including operator and peer
entries, and all node addresses from the same approved inventory. An abbreviated operator-only
list is insufficient. Select an authorized, already available public IPv4 control service that
accepts TCP/25, distinct from every target. Private, loopback, link-local, multicast and other
non-global proof addresses are rejected. Before relying on the probe, verify that this control
service is intended to accept such connections; no messages or application data are sent.

Prepare the version-1 JSON input privately and supply it only through
`PGCF_E2E_EXTERNAL_PROBE_CONFIG`. Do not place it in a tracked file, issue, dispatch input, log,
command-line argument or pasted configuration example. The required fields are:

| Field                         | Required value                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `version`                     | `1`.                                                                                                             |
| `nonce`                       | A new cryptographically random 32-byte value encoded as 64 lowercase hex characters.                             |
| `salt`                        | A new cryptographically random 32-byte HMAC key in canonical unpadded base64url, 43 characters. Keep it private. |
| `created_at`, `expires_at`    | UTC timestamps; creation is not in the future, expiry is in the future, and the interval is at most 30 minutes.  |
| `targets`                     | The exact full set of node addresses used by E6: 1–16 distinct address literals.                                 |
| `control`                     | The public IPv4 control address accepting TCP/25.                                                                |
| `operator_allowlist`          | The complete authoritative firewall allowlist as CIDRs, at most 256 entries.                                     |
| `operator_allowlist_complete` | `true`, asserted only after checking the actual full allowlist.                                                  |

The job fetches GitHub's published `actions_macos` address pool and requires every range to be
disjoint from the complete allowlist. A favorable result from one selected source address is not
enough. Overlap, an unavailable pool or an incomplete allowlist leaves the outside-allowlist source
unproven.

Current source proof covers IPv4 only. IPv6 targets remain `native_source_proven=false`, are not
dialled by this candidate and cannot pass E6 through it. An IPv4 control does not establish IPv6
egress. Keep E6 blocked for any required IPv6 address until an independently verified IPv6 source
and same-family control are implemented and exercised.

## Dispatch and collect

Temporarily set the repository Actions secret named `PGCF_E2E_EXTERNAL_PROBE_CONFIG` from the
private input using the operator's approved secret-injection method. Retain the same input
privately for local verification. Keep debug tracing disabled and never display its value.
Only this configuration secret reaches the native job.

In the examples below, `PGCF_E2E_REPOSITORY` is the public repository selected by the operator,
`PGCF_E2E_EXTERNAL_PROBE_RUN_ID` is the resulting GitHub run ID, and `PGCF_E2E_RUN_ID` is the
existing local acceptance run ID. These are operator template inputs, not additional harness
configuration fields.

```sh
gh workflow run ci.yml --repo "$PGCF_E2E_REPOSITORY" --ref main -f external_probe=true
```

Record the exact commit, run ID and run attempt from that dispatch. Wait for successful completion;
do not assume that a report artifact alone means the run succeeded. Download only the sanitized
artifact to the ignored evidence directory:

```sh
gh run download "$PGCF_E2E_EXTERNAL_PROBE_RUN_ID" \
  --repo "$PGCF_E2E_REPOSITORY" --name pgcf-e6-native \
  --dir .local/evidence/phase1
```

Preserve `pgcf-e6-native.json` exactly as downloaded. Do not parse and rewrite, pretty-print or
combine it with another report before verification. It contains HMAC-SHA256 identifiers scoped
by the private key and nonce, timestamps, address families and TCP states. Raw addresses, CIDRs
and the HMAC key are omitted. Plain unsalted address hashes would permit address enumeration and
are not a substitute.

For each proven IPv4 target, the job connects to the control on TCP/25 immediately before and after
probing the target. Both control connections must succeed; the three sample timestamps must be
ordered and span at most 20 seconds. A target connection is an open-port failure. A refusal or
timeout qualifies only with successful adjacent controls and proven source separation. Failed
controls, unsupported address families and other socket errors are inconclusive. A generic egress
timeout is never treated as proof of the server firewall.

## Verify and resume E6

Supply the following local environment variables through the private operator environment:

| Variable                              | Content                                                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PGCF_E2E_EXTERNAL_PROBE_CONFIG`      | The exact private configuration used for this dispatch.                                                                                                                         |
| `PGCF_E2E_EXTERNAL_PROBE_EXPECTATION` | JSON fields `repository`, `commit`, `run_id`, `run_attempt` and `nonce`; use the exact dispatched repository, full commit, decimal run/attempt strings and configuration nonce. |
| `PGCF_E2E_OPERATOR_ALLOWLIST`         | JSON array of the current complete authoritative effective allowlist; it must match the configuration after CIDR normalization.                                                 |

Resume from the exact `main` commit that produced the report, using the existing acceptance ledger
whose E5 step completed:

```sh
CI=true pnpm --filter @pgcf/e2e accept --run-id "$PGCF_E2E_RUN_ID" --step E6
```

E6 invokes `gh attestation verify` on the downloaded file with the repository and signer workflow
`.github/workflows/ci.yml`, `refs/heads/main`, exact source and signer commit digests, and rejection
of self-hosted runners. It binds the parsed original bytes to the verified SHA-256 subject digest.
It also checks the GitHub OIDC issuer, public source repository, hosted runner, manual trigger,
workflow identity, commit, run ID and attempt, and verified signing timestamps. A separate GitHub
API check requires that exact run to have completed successfully and retain its unexpired
`pgcf-e6-native` artifact. The local checkout must be `main` at the same commit.

The report must start after configuration creation, finish before its expiry, be no older than
15 minutes and use a source-pool observation no more than 10 seconds before it starts. Verification
fetches the current published pool again, compares all keyed identities and requires exact full
target coverage. Missing, stale, altered, foreign-run or partial reports fail closed.

E6 keeps resumable scan ranges in the private ledger and scans at most one 4,096-port range per
invocation. Repeat the command while it reports incomplete coverage. `--scan-address-index` can
select an address from the current inventory. A valid native report is required when its range
includes port 25 and again for every address before final E6 completion. Renew the private
configuration and dispatch if freshness expires during a longer scan; never reuse stale evidence
or remove the final proof check. Full E6 also requires the operator port scan, remaining outside
scan and cluster listener audit; this supplement proves only the TCP/25 gap.

## Cleanup

The workflow retains the sanitized artifact for one day. After verification, or on any failed or
abandoned run, remove the temporary configuration secret, delete the downloaded artifact when
no longer required and delete the GitHub artifact rather than relying solely on retention. Clear
the private configuration, expectation and allowlist environment values; destroy the temporary
private input through the operator's credential-handling procedure. Do not print any of them.

The native job has no provider resources to remove. The main acceptance harness owns its separate
temporary Dev resources; its recovery path is:

```sh
CI=true pnpm --filter @pgcf/e2e accept --run-id "$PGCF_E2E_RUN_ID" --cleanup-only
```

Keep the ledger until cleanup succeeds. Record actual E6 results and remaining gaps in
[PLAN.md Status](../../PLAN.md#11-status) only after verification; a signed report or successful
workflow by itself does not complete Phase 1 acceptance.
