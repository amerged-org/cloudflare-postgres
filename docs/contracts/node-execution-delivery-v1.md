# Private node execution-delivery protocol v1

This is an operator-only Kubernetes Exec protocol, not a customer endpoint.
The separate delivery image/profile has node-administration filesystem authority.
The existing observation command/profile remains read-only. The regional broker
must authenticate and pin the delivery Namespace, Node, DaemonSet, Pod,
container/image and restart identity around the complete exchange. That regional
transport is implemented by `node-delivery.ts`; post-birth broker custody is
implemented by `execution-broker.ts`. Resident/bootstrap wiring and live
qualification remain implementation work.

## Channel and framing

Invoke `/node-execution-delivery --endpoint unix:///run/cri.sock` with TTY disabled.
Each frame is a four-byte big-endian unsigned length followed by exactly that
many UTF-8 JSON bytes, from 1 to 16,384. The shared strict parser rejects duplicate
object keys, excessive nesting/collections, malformed JSON and trailing content.
Typed initialization/authorization decoding rejects unknown fields. Booleans are
valid private transport values; signed manifest/permit schemas remain closed.

The client must keep stdin open through the receipt. The pinned client-node v4
transport closes the WebSocket when stdin ends, so EOF is not a phase delimiter.
The agent duplicates inherited pipe/socket descriptors, makes them nonblocking,
then registers owned wrappers with Go's poller before applying read/write
deadlines. Ordinary files and TTYs are refused. The whole command has a
ten-second deadline; cancellation interrupts pipe waits.

## Exchange

1. Send initialization version one with request UUID, installation/region/Node
   scope, actual target Pod/container/mount projection, kubelet root, private IPC
   child, nonroot guard UID/GID, nonce, complete signed expected manifest and
   installation-pinned public key. All configuration comes from the authenticated
   installation/broker. Downward API environment values bind the delivery process
   to its own Pod/namespace/node and installation/region.
2. The node samples original boot time, opens one retained `ExecutionExchange`,
   verifies the exact challenge and emits `type: challenge` with request ID,
   complete self identity, actual challenge, its SHA-256 and decimal boot anchor.
   File descriptors remain open while the broker rechecks current target/peer
   identities and lease/funding authority and requests one issuer response.
3. Send version one, `type: permit`, the same request ID/challenge hash and the
   signed permit. The node reuses the existing guard verifier for key ID,
   signature, nonce and complete execution binding. Its publication authority
   expires at the original anchor plus the shorter of the signed duration and
   ten seconds; a slow response never resets the anchor.
4. The node publishes under retained runtime/filesystem custody, closes that
   custody, and emits `type: receipt`, self identity, request/challenge hashes,
   exact permit SHA-256, decimal deadline and `published`, `replayed` or
   `uncertain`. A receipt is file-publication evidence, not process-start evidence.

The implemented regional transport accepts success only with matching receipt, Kubernetes
Success, completed stdout/socket closure and unchanged final peer identities.
It requests one issuer response through its mandatory authority callback and
does not mint another permit on a lost response or treat disconnect after
sending the permit as proof that execution stopped.

## Authority and limitations

The authenticated broker supplies the original manifest and public-key pin;
the node does not establish installation key provenance by receiving them.
Guard image/Pod capabilities must be verified separately. The signature proves
the issuer's bounded grant, not instantaneous later revocation. The node can
enforce its local finite deadline offline; it cannot observe every concurrent
Cloudflare policy change during publication. The actual PID1 guard independently
verifies the permit and its own immutable boot-time window.

An uncertain post-visibility result preserves artifacts and accounting holds
until the existing runtime/stop evidence resolves it. No uncertain customer SQL
write is replayed by this protocol. No real node-agent/issuer/CNPG deployment is
qualified by the source or dependency fixtures alone.

The regional caller supplies mandatory current-authority and target/funding
revalidation callbacks. Its issuer response is copied and the exact frame is
constructed before final revalidation; those bytes cannot change while awaiting
fresh metadata. Current authority is checked immediately before sending. The
transport's callbacks are not a production-broker activation claim.

The post-birth broker derives those callbacks from original capacity/manifest,
current funding and exact target/recipe checks. It durably claims the attempt
before dispatch, seals issuing before the one ControlClient request, and records
publishing before returning exact permit bytes. In-progress or uncertain reopen
does not issue again. An already-recorded receipt is historical evidence only.
Pre-birth admission and protected-input/nonce bootstrap remain separate.
