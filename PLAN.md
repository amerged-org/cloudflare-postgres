# cloudflare-postgres — Plan

Status (2026-10-09, corrected): **Overall product goal NOT achieved. The EU/US database lifecycle and RAM-trigger tests passed; uniform fleet configuration, autonomous rollout, patch management and the approved fast-start architecture remain incomplete.**

Latest owner correction (2026-10-09): remove the fixed three-VPS ceiling and this installation's
personal email setup. PGCF must expose the regional RAM expansion threshold and automatic-purchase
on/off setting through its authenticated Cloudflare management API. Operators configure and enable
their own provider/profile and optional email delivery;76% remains this installation's selected
threshold, not a fixed software rule. Optional Resend-backed notifications may remain available
when the operator supplies credentials, sender, recipient and warning policy. Fresh installations
send no email and do not purchase automatically. Both live node ceilings and the personal
capacity-mail credentials/recipient have now been removed. The configurable thresholds and
opt-in warning policies are implemented locally and still await the consolidated release.

The corrected API and both regional runtimes now run source `6978033`, accepted by CI
`37851000610`. Both live regional policies now have `max_nodes:null`; this latest update preserves
every other policy field. Both regions use the same actual-RAM policy, with a128MiB PostgreSQL request and
4096MiB maximum. The controlled EU transition completed in135s through confirmed suspension and
fresh startup admission; all3 retained databases returned Ready with unchanged storage and
application table hashes. The exact V159 standing authority is recorded in both regions.
Automatic expansion remains off until the current approved installation templates
and full release are ready; the missing EU installation profile is a configuration gap, not
missing owner permission. The notification receiver is deployed from source `f08b9cc0`, full CI `37860011792`; its earlier75%
warning/delivery/dedupe tests remain historical evidence. Personal capacity credentials and recipient
are removed; shared Resend credentials remain. Matching Regional images do not close the
remaining Kubernetes, Talos schematic, resource-policy, patch or fast-start gates.

The earlier broad completion claim is withdrawn. The owner now requires all three retained
servers to converge on one approved release, PGCF-owned Cloudflare customer configuration
managed exclusively through the authenticated API; a PGCF administration UI or dashboard is out of scope,
no permanent CPU debit for confirmed sleeping databases, no blanket physical allocation of
logical storage quotas, executable already-granted purchase authority, uniform patch management
and the fast-start architecture, explicitly including a shared pool of prestarted unassigned
compute rather than one permanently warm runtime per database. The implementation and acceptance
sequence is the [unified corrective plan](docs/architecture/cloudflare-convergence-and-serverless-plan.md).
It supersedes older reservation-preserving and EU-upgrade-deferral clauses. Source implementation
and live acceptance are tracked separately below; the corrective requirements are not a claim of deployment.

The measured successes below are partial acceptance evidence and remain valid. They are not a
substitute for the full completion gates in the corrective plan.


The original paid US1 reached Cloudflare Ready at16:50:20Z through the owner-authorized operator
postjoin/admission path in198.356 seconds. Its original purchase, installation, Node/Cluster
identities, join revision1 and all EU data remain. The programmed1GiB storage trial wrote, read
and physically reclaimed its volume in753.081 seconds; the operator did not repeat it. The one
consolidated Node correction, source `2bf52e0`, passed CI `37778960682` and was delivered once.
Automatic postjoin admission remains open for the next genuine authorized node purchase: a
report returned HTTP409 before pause, then its proof session renewed without admission. The
operator resolved a confirmed partial network result before obtaining fresh observations and
running the existing verifier, quarantine release and finalization. No replacement VPS was
purchased. EU upgrades and bootstrap-template activation were deferred during that partial
acceptance; the current corrective plan requires supported data-preserving convergence.

The database lifecycle passed on both customer nodes through `db.ohmyho.st`, with actual
PostgreSQL18.6, TLS1.3 and nonsuperuser application roles. EU SQL took2187ms; separate EU restore
108618ms and healthy-source EU-to-US restore87988ms include observation pacing. The original
two source markers survived, a third marker committed on US, and temporary restore administration
was removed. Four databases passed R2 base backups and exact committed WAL checks and were
subsequently deleted, physically reclaiming four5GiB volumes (20GiB total). All three existing
EU databases, source markers and encrypted custody are preserved. The older empty US trial had
timed out during the manifest failure; it was deleted through the supported API without an
allocation, then one fresh disposable database on the same US1 completed acceptance. No terminal
operation was reopened and uncertain SQL writes were resolved by reads before further work.

The observed CNPG webhook failure was256MB shared buffers with128Mi startup request and1024Mi
hard limit. One shared tuning function now bounds shared buffers by startup memory, SQL readiness
uses the same function and Pod verification distinguishes requests from limits. All12 resources
passed server dry-run;113 scoped cases, types/lint/format and independent review passed. Source
`11555215`, one complete CI `37815727563`, delivered the qualified Regional image only to US:
`sha256:1886a64e36d2b9ba45e4d876a0a9eb6bab3fb83a6b0fafcb18dbf8647ef66993`.
All10 image layers and89,782,247 compressed registry bytes were verified. EU Regional901 and
API/Native2bf remained unchanged. A separate configuration error omitted `/pg` from the US gateway
URL. One exact configuration CAS corrected only that path, preserving all EU and bootstrap fields;
Cloudflare SQL then passed without a redeployment or reset.

Initial association measured1 OAuth plus1 Contabo GET. Three nonempty30-minute routine windows
recorded zero provider attempts; the final window included390 proof/transport requests and the
HTTP409 report. Historical lifetime provider totals are unknown. These bounded counts do not
replace lifecycle accounting or imply zero historical purchase/firewall calls.

Ten real consecutive minute samples of the same physical US Node UID,18:43:01–18:52:04Z,
averaged79.9062% RAM under a3968MiB disposable allocation. Cloudflare persisted the same value
and expansion trigger. The existing suitable-node placement and hard CPU/storage/RAM plus512MiB
Barman startup checks still passed; the dry expansion decision was `disabled`, with zero provider
calls or purchases. The1024MiB smallest startup peak remained bounded. The first trial correctly
refused a missing minute when actual kubelet timestamps crossed18:36:59→18:38:00; no observation
was fabricated. It was deleted and recovered4,179,976,192 bytes before the independent successful
trial. Final successful-trial cleanup removed the exact Namespace/Pod and recovered4,177,731,584 bytes;
fresh available RAM returned within the recorded baseline tolerance. Both trials had4096MiB limits and720s
maximum lifetime. Actual timestamp drift can leave a validly unknown window; do not relax the
ten-consecutive-minute rule to manufacture an expansion decision.

Autonomous purchases remain disabled in the current live installation. The2026-10-08 three-node
ceiling and personal warning setup were implemented and tested, then superseded by the owner's
2026-10-09 generic-configuration decision above. Preserve the V159 monthly/no-add-on standing
selection while removing the fixed ceiling; make the actual RAM threshold and auto-purchase switch
operator-configurable. Historical cap/mail measurements below remain evidence of those tests,
not the current product requirement. Actual allocatable CPU is3000m, with platform reservations EU350m
and US1510m. The smallest configured database requires250m PostgreSQL plus100m Barman, so CPU
ceilings in the current rejected allocation model are7 EU/4 US minimum-class databases on
otherwise empty nodes. That model debits7700m and110GiB for22 US assignments against1490m/95GiB;
this is not proof of their actual workload requirements or achievable density. Existing eligible nodes remain available during expansion; there is no81% stop.

Actual software differences and the customer handover are documented in
`docs/operations/operator-installation.md`: Talos1.14.1/kernel6.18.51/containerd2.3.5 match;
Kubernetes is EU1.36.3/US1.36.5 and Flux differs; Regional source and RAM policy now match. No difference blocked the
accepted lifecycle. Customer migration remains separate and requires credential rotation after
the October5 revision1 exposure, the adopter's TCP-to-WSS adapter and deadline policy, restore
new-ID rebinding, and sufficient explicitly approved regional capacity.

The latest owner direction removes Contabo from routine transport and proof-resource cleanup.
Provider access belongs to purchase, initial association, firewall/rescue/hypervisor actions,
uncertain-action resolution and necessary lifecycle verification, including before the first
destructive installation checkpoint. Cloudflare persists one verified source association per
installation operation and renews only its bounded proof authority. Routine grants and relays
use the current operation, sealed addresses and credentials, while Native continues fresh
Talos/Kubernetes cluster and node identity checks. Identity changes fail closed. OAuth expiry,
credential changes, concurrent login coalescing and 401 invalidation remain; inventory and
authority are not cached. These API repairs are delivered; complete live acceptance remains
pending. The earlier prepared f6 API publication was held before its intent; the
existing US1 operation and paid instance are retained without a replacement or EU reset.

The integrated repair stores the proof-source association transactionally in the existing
operation Durable Object, serializes concurrent proof registration and carries the same
association through fresh preparation/postjoin sessions. Existing trusted inputs can seed
the association without reusing their expired authority; conflicting associations block.
Inspection grants similarly use the sealed initial assignment. Provider-free authority checks
retain current CF operation/binding/plan, fresh source Node UID/Ready observations and exact
encrypted cluster custody, while Native's fresh Talos/Kubernetes identities remain unchanged.
Confirmed rescue and later network/proof cycles no longer poll Contabo. Before the first
destructive checkpoint, a fresh provider inventory check and snapshot-bound CAS fence identity
changes and concurrent revocation. The firewall authentication regression reproduced three
OAuth calls across three checks; the shared credential-scoped client now makes one, while
retaining per-request and aggregate deadlines. Fixed-field wire events count actual OAuth and
resource HTTP attempts without logging provider payloads or credentials. Focused regressions,
types, lint and formatting pass. Source `44957bf4`, full CI `37578754570`, is delivered
API-only with the unchanged qualified Native `51dcfff4` image/configuration and retained EU/US
custody. One controlled resume retained the original created job with zero downloaded/written
bytes. The programmed path physically removed both older owned source namespaces, then created
fresh scanners. More than 200 captured routine ownership/transport requests returned HTTP200
with no provider calls in those request frames. The completed AddNode RPC frame is attributed
to the exact delivered Worker version, despite its older Workflow-definition UUID; no Workflow
migration is required. Its buffered wire events recorded 3 OAuth and 66 resource HTTP attempts,
all in the firewall stage. Repeated input preparation still rechecked a confirmed allocation
each cycle; a real-D1 regression reproduces that remaining provider poll, and the follow-up
uses the sealed binding plus fresh CF authority instead. The IPv6 scanner reported
`outside_scan_capability_gap_ipv6_eaddrnotavail`; its owned Pod uses host networking. A bounded
direct Talos mTLS read subsequently verified the same source Node/Cluster UID, boot ID and system
UUID before and after, with zero global IPv6 addresses and zero IPv6 default routes. The host
prerequisite gap is now established; the captured Pod manifest does not contain the separately
staged scan input, so it does not establish the exact selected-address equality. A read-only
administrator source-identity endpoint exposes the once-sealed public mapping and binding hashes
through fresh CF checks, without private access material, provider/Native calls, session issuance,
alarms or storage mutation. Its missing literal route first reproduced HTTP400 through the generic
mode route; 44 scoped cases, types, lint and formatting pass. Source `1b8e0ae`, full CI
`37585381991`, delivers this getter and the sealed-input allocation repair API-only, retaining
the qualified Native image and EU/US custody. Matching sealed/provider IPv6 facts and fresh
Node/Cluster/boot identity authorized one format-preserving source-network repair. The pinned
Talos1.14.1 dry run succeeded, then exactly one no-reboot apply was accepted at08:22:10Z.
Readback at08:26:26Z verified both persistent and active configuration hashes, the assigned
global IPv6 address and physical-interface default route, unchanged IPv4/MAC/boot/Node/Cluster
identity and all three existing database/storage/role/Secret/custody identities. No EU reset,
data migration or second apply occurred. A present empty RouteStatus destination represents the
default route in this pinned Talos release; a fixture regression corrected that comparator
without another OS write.

The original US Workflow resumed once at08:33:20Z. Fresh owned scanners failed at08:35:54Z;
Native reported `proof_source_pod_failed`. Their logs disappeared during programmed cleanup
before the operator could capture the underlying code. The same Workflow was paused at step328,
with the original installer still `created`, revision0 and zero downloaded/written bytes.
The completed 30-minute instrumented window contains555 owned request frames and zero actual
Contabo wire events in any stage; counts describe this capture window, not historical purchases.
A reproducing failed-Pod test now requires a bounded2KiB diagnostic read before cleanup, fresh
CF/source/Namespace/Pod/Cluster identity and actual image checks before and after, and only an
exact one-key JSON envelope carrying one of66 finite scanner codes. Missing, arbitrary,
oversized, revoked or identity-mismatched output retains the generic error.36 scoped Native
cases,180 full Native cases,5 contract cases, types, lint and formatting pass. Scan behavior,
timeouts, success handling and cleanup stay unchanged. Source `14b60d9`, full CI `37598961993`,
is delivered once with the matching finite API contract and qualified Native manifest
`sha256:62e13d74870a41aa71a1c29725c5afb3f5a98afdf8ee0ac5eda90faf13620a56`.
Qualification covered714,976,857 bytes/18 layers with zero unresolved findings; complete private
registry readback verified162,118,452 compressed and502,859,776 raw bytes. The completed rollout
and actual version19/placement19 Running match this image; the process was initially stopped
and aggregate active count0, so those observations alone did not claim execution. EU data/custody,
source-network repair and the whole original created US job were preserved.

The same US Workflow resumed once and fresh proof was issued at09:38:28Z. Programmed cleanup
removed prior owned resources, then both new scanners ran. The retained failure at09:45:50Z is
`outside_scan_control_session_changed`,441.785 seconds after issuance with98.215 seconds still
valid. This code is raised before response-body decoding by a physical TLS socket identity
comparison, not by a changed Cloudflare operation or signed source observation. A reproducing
signed-HTTPS fixture demonstrates rejection of a replacement authorized socket with valid
address/port/nonce/source binding. The follow-up removes only stored socket-object identity;
every fresh TLS authorization/443 check, signed nonce/origin/control-address/local/remote/key
validation and stable observed public source remains. The original Workflow is paused at
step412, with its installer still created/revision0 and zero downloaded/written bytes.15 affected
tests, Native types, scoped lint and formatting pass; reconnects succeed with fresh nonces while
unauthorized TLS and changed public sources still fail. No new
provider order, EU reset or source OS write occurred. US installation/admission and final live
acceptance remain pending, without a replacement order or weakened dual-stack proof.

Source `b9bbc99`, full CI `37604039662`, delivered the TLS reconnect repair once with qualified
Native manifest `sha256:0ba5a80744551fd856defd80dbfb59b193a60c45f609aee5f87ea5ca9fa4de51`.
All18 layers/714,976,857 qualification bytes passed; complete private readback verified162,118,420
compressed and502,859,776 raw bytes. Actual version20/placement20 Running matched the image,
with protected EU data/custody and the original created US job unchanged. Controlled resumes
then retained `outside_scan_capability_gap_ipv6_control_timeout` before expiry. A first passive
capture missed the scanner window and supplied no network conclusion. A second capture began
on fresh owned resource creation: five retransmitted SYNs reached the physical interface for
the exact sealed IPv6 control endpoint, with three unicast solicitations for the exact provider
gateway and no SYN-ACK, TLS, neighbor advertisement or ICMP error. Fresh before/after
Node/Cluster/boot/system/config/address/route/MAC identities matched.

The necessary source-firewall lifecycle observation found one attached active firewall, three
TCP/UDP accepts, permanent DROP and no ICMP accept; the source has no local NetworkRuleConfig
or NetworkDefaultActionConfig. Exactly one API PUT added only ICMP from the assigned IPv6
gateway/128, with empty ports and no IPv4 scope. GET-only reconciliation confirmed four accepts,
unchanged original TCP/UDP rules, permanent DROP, attachment identities and source custody at
11:26:12Z. The apply measured1 OAuth plus4 resource calls; reconciliation measured1 OAuth plus3
resource calls. The earlier read collector discarded four fixed wire emissions because the SDK
logged JSON strings; its zero capture is not a zero-call claim, and no read was repeated merely
to reconstruct the missing OAuth/resource split. These lifecycle measurements are separate from
routine transport. Completed additional transport windows recorded469 and496 owned frames over
30 minutes, then555 and420 over15 minutes, each with zero provider wire events. Overlapping
windows must not be summed into a lifetime count.

After the gateway rule, six source-matched IPv6 control requests returned HTTP200 in215–338ms;
the trace supports source attribution, not an exact operation attribution from redacted bearers.
The retained failure changed to `proof_source_namespace_children_unknown`; a later metadata-only
13-kind snapshot contained only the allowed default ServiceAccount/root CA ConfigMap. That
snapshot does not identify the earlier failing predicate. A SourceRunner regression reproduces
a valid measurement followed by a transient first inventory failure, confirmed second cleanup,
and an incorrectly retained first error. The repair retains the validated measurement only after
complete cleanup, matching receipt hash and fresh authority; scan errors and dirty/revoked state
still fail. A real-D1 regression also reproduces zero ICMP rules in initial plans with actual
inventory gateways. Initial-plan generation and exact readback gain IPv6 gateway/128 ICMP;
existing sealed plans remain unchanged. This narrow rule does not promise arbitrary-path PMTU
ICMP acceptance. The same US Workflow is paused at step696, still before disk writes. Full US
Ready/SQL/backup/WAL/restore/physical-reclamation acceptance remains outstanding.
The integrated repair passes41 Native source-runner cases and21 real-D1 network cases, types,
scoped lint and formatting. Existing legacy plans remain byte-exact and eligible; newly generated
gateway policies still reject a later provider-gateway change through the existing plan-hash gate.

Source `2c94ff59`, full CI `37618015121`, is delivered once with qualified Native manifest
`sha256:6983849487f21c9a56c7f7664f6077468c17d85a447682d3310a650affbee1e6`.
All 18 layers/714,977,367 qualification bytes passed; complete private readback verified
162,118,476 compressed and 502,860,288 raw bytes. The completed rollout and actual application,
deployment and placement version 21 match this image, with placement health Running. The
container was initially stopped and aggregate active count remained zero; normal Workflow
execution starts the process. Protected EU data/custody, the source IPv6 repair, gateway firewall
rule and the whole original created US job were unchanged. The same Workflow resumed once at
12:26:07Z. Its completed 30-minute capture contains 996 owned ownership/transport frames and
zero provider wire events. Additional retained owned routes show two access HTTP200 responses
and two report HTTP409 responses at 12:33:04.871Z and 12:38:22.151Z, taking 644 and 689 ms.
All 59 ownership and 937 transport responses were HTTP200 in that capture. Native's generic
`node_proof_authority_refused` is emitted by a failed internal POST; these captured conflicts
occurred at report submission, rather than a failed fresh transport authorization. The later
terminal at 13:04:16.610Z used that same generic code, 315.419 seconds after issuance with
224.581 seconds remaining and all 46 source journals cleaned; it falls outside the retained
Tail window, so its exact POST route is not established. The Workflow is now paused at step
1052, with the original installer still created/revision 0 and zero downloaded/written bytes.
Report validation diagnosis and full US live acceptance remain pending.

A real-D1 regression reproduces rejection of a Native-valid 80-second scan followed by 60 seconds
of cleanup: its completion is fresh but its historical start has aged beyond the report's
120-second check. Historical start/initial-control checks now use scan completion, retaining
120-second completed-observation/access/final-control freshness, exact timestamps and all
current authority/binding/nonce/source gates. Stale completion and excessive scan intervals still
reject before firewall or R2 writes; 14 artifact cases pass. Source-only control-to-report gaps
of 175.371 and 169.255 seconds also demonstrate a separate cleanup timing problem, without
establishing exact receipt timestamps. The affected intervals contain 95/94 successful transport
requests; transport wall time has a measured median of 1,833ms across the retained capture.
A no-discovery cleanup regression first failed against the former grouped kubectl reads. The
repair reads the same 13 explicit standard REST collections with four concurrent reads per
family, strict typed Lists/items and complete-list metadata, preserving the 256KiB total,
30-second command and expired-cleanup aggregate bounds. Foreign children, changed identities,
partial inventories and unknown outcomes still block namespace deletion. Source/runner checks
and the two new typed/partial inventory guards pass; slower grant models still refuse at the
existing deadline with namespace ownership retained. These software checks do not establish a
live cleanup duration or US readiness. Source `e3f73c2f`, full CI `37629855698`, is delivered once
with qualified Native manifest `sha256:1ce363daaa6049f0202ace78540692b03e98a744c36e11d72edebcdb0ab66585`.
All 18 layers/714,978,389 qualification bytes passed; complete private readback verified
162,118,733 compressed and 502,861,312 raw bytes. Actual application/deployment/placement version
22 matched the image, preserving all protected identities and custody. The original Workflow
resumed once at 13:57:35.722Z. Its fresh session reported `proof_source_pod_failed` at
14:01:29.812Z, 194.659 seconds after issuance with 345.341 seconds remaining. Both retained
owned Pods were Failed/exit 1 with no restart or OOM reason; their exact one-key logs reported
IPv6 and IPv4 control timeouts at 14:00:24Z and 14:00:44Z. Cleanup inventory had not completed,
so this attempt does not measure the new cleanup path. Both source Nodes remained Ready with
the same physical identities, but their CF observations became 319 seconds old during a
312-second regional observation gap. The agent retained its Pod/image and logged cycle/reconcile
failures plus one reconnect; fresh observations subsequently recovered naturally. A bounded
Talos read preserved Source UID/Cluster UID/boot/system identity, global IPv6 and network resources;
captured kernel logs contained no matching conntrack-full, watchdog, OOM or link-down pattern.
These facts do not isolate the initial network timeout's cause. The Workflow became errored at
step 1083 when the stale source check threw; no pause was dispatched and the installer remains
created/revision 0 with zero downloaded/written bytes.

A real-D1 regression now reproduces that headless recovery failure. A retained source with only
an observation older than 180 seconds makes the proof producer wait after all Node/provider/region,
Ready/lost, profile, decrypted cluster/certificate custody and target checks pass before and after
the asynchronous reads. Routine Native grants still reject stale observations. A real fresh
observation resumes the same association with new bounded claims; expired input is never reused.
Changed Node/Cluster identity, custody and future timestamps remain blocking. The 38 affected
source/execution cases pass. This is an API-only recovery correction; the qualified Native image,
source OS/firewall and original operation remain unchanged. Live installation/admission and final
acceptance are still pending.

Source `cc5dbeb5` passes full CI `37636098688`. Its API-only publication stayed before the
intent/CLI because scheduled capacity reconciliation had already restarted the same errored
Workflow. The original job remained created/revision0 with zero downloaded/written bytes;
no second order or adoption occurred. The completed 30-minute capture recorded696 owned
request frames and zero actual provider wire events across all seven lifecycle stages.
Subsequent programmed cleanup reported `proof_source_namespace_children_unknown`.
A bounded direct read of the two exact dirty namespaces verified all13 typed collection wrappers,
no continuation/remaining-item indication, preserved Node/Cluster identity and2866/10279 bytes.
The raw Kubernetes typed Lists omit item `apiVersion` and `kind`, unlike kubectl's merged List.
The new strict item check incorrectly rejected the permitted default ServiceAccount and root CA
ConfigMap. A reproducing test first fails with that exact error. The correction infers TypeMeta
only when both fields are absent from an exact validated collection; explicit mismatches or
partially present fields still reject. All namespace/system-child, complete-list, output,
identity and deletion guards remain. This changed Native path needs one qualified image delivery;
the queued API recovery correction is included in that stand. US live acceptance remains pending.

Source `9c02647b`, full CI `37638342051`, is delivered once with qualified Native manifest
`sha256:d4fbd0afebde3576c3db6822f3aad270da2cf82d6c4eed26d9e033e18872a752`.
All18 layers/714,978,391 qualification bytes passed; complete private readback verified
162,118,779 compressed and502,861,312 raw bytes. Actual application/deployment/placement23 and
one running/active process match the image. Protected EU state, the whole original created US
job, source IPv6/firewall repairs and all non-image configuration remained unchanged.
Automatic recovery started the process without a manual restart. The programmed raw inventory
then removed both previously dirty namespaces. Two fresh scanners completed and their owned
cleanup confirmed all54 journals cleaned. Access returned HTTP200, followed by report HTTP409
at15:03:56.402Z before any provider wire event. The retained generic terminal at15:04:00.886Z
was449.173 seconds after issuance with90.827 seconds remaining. Source control HTTP200 observations
at15:01:53.418Z/54.061Z preceded submission by122.984/122.341 seconds; redacted bearers support
source attribution, not an exact operation binding. Completion older than120 seconds remains
correctly refused. One controlled pause retained the same created/revision0 job at step276,
with zero downloaded/written bytes. Reduce duplicated cleanup command setup while preserving
all identity/deletion gates; do not extend observation freshness or increase proxy concurrency.
Full US admission and SQL/TLS/R2/WAL/restore/physical-reclamation acceptance remain pending.

A second in-flight report returned409 at15:08:51.666Z,125.904–126.603 seconds after the last
source controls. A third returned200 at15:13:24.555Z, recording1 OAuth and12 provider GET attempts,
all in the firewall lifecycle stage. Its handler took11,216ms. Native subsequently reported the
proof, but independent CF readback still showed awaiting_proof with no verified proof hash or
expiry; HTTP200 is not installation authorization. Its last controls were about128 seconds old
by handler completion. Preserve the120-second independent final gate and reduce cleanup setup
overhead instead. Batch the initial exact source identity and owned Pod read, plus the Pod-absence
and following exact Namespace read, while retaining immediate fresh source checks before each
DELETE, all13 collection reads and UID/resourceVersion preconditions. These changes require
reproducing and safety tests and one final qualified delivery before continuation.

The cleanup repair combines two pairs of reads into strict named core Lists, removing two
standalone kubectl/transport setups per ordinary cleanup. Separate fresh source identity checks
immediately before each DELETE, all13 raw inventories, concurrency4 and existing freshness,
command, aggregate, UID/resourceVersion and uncertain-write bounds remain. A further real-shape
regression reproduced empty successful kubectl stdout when both queried resources are absent;
only known-successful empty output confirms absence, while failed/unknown reads preserve dirty
ownership and never replay the DELETE.65 affected source/runner cases, Native types, scoped
lint, formatting and independent review pass. The46.965-second transport model is synthetic;
actual cleanup/admission timing still requires the next live continuation.

Source `64f3b93f`, full CI `37668646906`, is delivered once with qualified Native manifest
`sha256:74b88ee2fc03c62731270a6589d89b132340c0da4223739f71bc55b633bba7e3`.
All18 layers/714,980,441 qualification bytes passed; complete private readback verified
162,119,181 compressed and502,863,360 raw bytes. The first local build stopped before building
because Docker was unavailable; its artifacts remained, and one fresh local retry followed
confirmed daemon readiness. No provider action or CI rerun accompanied that retry. Application,
deployment and placement24 matched the image; the original created US job and all EU protection
remained. One controlled resume started at18:58:34.902Z. Two reports returned200 but did not
establish verified CF preparation. The completed30-minute capture contained356 owned requests,
2 OAuth plus24 provider GET attempts, all in the firewall stage, and zero routine transport
provider calls. One controlled pause at step349 retained zero downloaded/written bytes.

Exact signed-R2 readback and offline execution of the real proof verifier validated signatures,
scope, source, access, rules and all timestamp floors at signing. The first failing predicate
was IPv4 final-control freshness at120001ms. The latest signing age was119.163 seconds; its
provider-backed handler ended at130.487 seconds. Repeated provider checks inside routine proof
verification caused the refusal. Reproducing tests require real D1/R2/Ed25519 report verification
with provider fetch forbidden, while initial firewall/rescue provisioning remains explicit.
The repair verifies current sealed CF plan, region/member/config scope, allocation and lease
before/after signed-artifact reads and in the atomic proof CAS, without provider calls. It retains
the120-second gate. Before the first destructive checkpoint, fresh instance addresses/hardware
and read-only owned/assigned/exact firewall facts are mandatory, followed by an atomic network,
proof, expiry, region/member, lease/allocation and existing audit/receipt fence. Changed facts or
concurrent revocation block without a disk-write intent; later chunks make no provider reads.
40 network/report and42 callback cases, API types, scoped lint/formatting and reciprocal review
pass. This correction is API-only; live US Ready/SQL/TLS/R2/WAL/restore/reclamation remain pending.

The first integrated API-only stand `b6d0e330` failed CI `37676702755` on one stale
postjoin-test expectation: signed proof and quarantined admission succeeded, then the test
expected the removed routine firewall call. The corrected fixture forbids that call and retains
the necessary admission inventory read; all five postjoin cases pass. The stand was not published.
A CF-only live journal observation at19:45:20Z confirmed62 retained source journals, all cleaned.
The former64-row limit applied before filtering, so another preparation/postjoin renewal could
leave66 rows and block the next resume. Reproducing tests now require bounded pagination while
preserving every custody record and finding interrupted cleanup beyond a page of cleaned history.
The administrative projection includes only current or unfinished journals after validating
historical records; malformed/overflow history fails closed without partial authority. Native
runtime/image, observation freshness and owned-resource deletion guards remain unchanged.

Source `858abd572`, full CI `37678023727`, is delivered once API-only. The unchanged
qualified Native source `64f3b93f`/manifest `sha256:74b88ee2fc03c62731270a6589d89b132340c0da4223739f71bc55b633bba7e3`
and exact configuration were retained. Fresh before/after checks preserved both EU Nodes, all
three database/role/PVC/PV/Secret identities, encrypted EU/US custody and the entire original
created US job. One resume intent at20:23:51.374Z restarted the same Workflow. Its new session
issued at20:24:09.271Z and reported successfully after270.568 seconds; both current journals
were cleaned. CF preparation was actually verified atrevision3 with a stored signed hash and
109.911 seconds remaining at20:28:43.714Z. The captured access/report requests and routine
transport frames contained no provider wire events. This is successful proof admission, not
US node admission. Later cycles still left the addition audited/revision3 and installer created/
revision0/zero bytes despite another verified preparation. One controlled pause atstep604
preserved that entire job; the transition to installer authorization is under diagnosis.
The completed1,800-second instrumented capture contains615 owned frames and zero actual
provider wire events across all seven stages. This is a capture-window count, not lifetime
purchase/installation accounting. The installer transition regression reproduced with a real
accepted109-second-old scan: after advancing30 seconds, stored proof authority remained fresh
but the Workflow boundary returnedfalse. The correction reuses only the exact accepted R2 artifact hash and stored expiry, while
fresh CF plan/configuration/lease/allocation and current job checks fence the handoff. New
artifacts retain normal signature and120-second observation validation; revoked jobs fail
closed instead of falling back. 85 affected network/report/callback cases, API types, scoped lint/formatting and independent
review pass. Maintenance disk/stage checks remain mandatory, and exact checkpoint custody
is compared before/after accepted-proof reuse.
A separate authenticated EU read at20:58:24.649Z preserved both Node/Cluster/boot/system/config
identities, all three healthy PostgreSQL clusters and five Ready platform releases. Both Nodes
run Talos1.14.1, kernel6.18.51, containerd2.3.5 and kubelet1.36.3; the API server is1.36.3.
PostgreSQL Pods resolve the qualified18.6 image digest `sha256:5495f355719f24bd56219bc46825ecfa8771515a110ceca6e4d83331868bf115`.
Agent/gateway/relay Pods retain regional digest `sha256:eeaa6ab0c1fc182e9e050d6f104565ec0a3dc4e7482b1950287c31b62ebe607a`.
Actual platform versions are CNPG1.30.1, Barman0.15.1, Cilium1.20.2, cert-manager1.21.2 and
OpenEBS4.6.1. The customer installer is pinned by digest; the control-node desired installer
uses a1.14.1 tag, and per-node schematics differ with their network configuration. Kubernetes
1.36.3 differs from the reviewed fresh-node1.36.5 baseline. Supported data-preserving alignment
is being prepared, with no EU upgrade or reinstall dispatched. SQL server-version and actual
US inventory/readiness remain pending.
No replacement order, EU reset, source OS write or additional image delivery occurred.

Source `f5e7e048`, full CI `37693780073`, is delivered once API-only with the same
qualified Native64 manifest and exact configuration. Protected EU state and the original US
job were preserved. One original-Workflow resume initially returned a Cloudflare Container
availability error atstep607. Scheduled reconciliation automatically restarted the same
Workflow; the unchanged Native application24 became active with zero health errors. No manual
retry, new order or image delivery was used. Its fresh session issued at22:20:55.552Z and
reported after246.840 seconds, with both journals cleaned. CF preparation was verified at
revision6; the addition reachedbootstrapping/revision4/prepared and native rescue_verified/
revision1. Image download completed at232,141,432 compressed bytes; the first disk-write
checkpoint followed fresh provider verification, measured1 OAuth plus2 GET calls inprewrite
and zero calls in routine proof/transport frames. At22:27:31Z the job had48 MiB acknowledged,
then initial-proof expiry forced another full scan while retaining the pending chunk.
This observed coupling gates every installer authority/checkpoint and transport grant with
the120-second initial network-proof lifetime, although current job/native identity authority
is checked independently. The resulting repeated full scans are a programmed rollout delay.
A real-D1 regression reproduces403 after only that proof expires following a successful first
destructive checkpoint. The scoped correction prepares a once-set, bounded Cloudflare record
binding the original input/operation/plan/provider checks to that first authorization; short
transport grants, current CF revocation/scope, fresh native identities and postjoin proof remain.
Existing partial jobs must acquire the record once through fresh proof/provider verification
and an exact progress CAS, without resetting or replaying a disk write. One controlled pause
atstep88 retained jobrevision13,48 MiB acknowledged and the pending48 MiB offset, with sealed
input and permissions unchanged. 45 callback and39 transport/registration/Workflow cases, API types, scoped lint/formatting
and independent callsite review pass. The routine predicate is CF-only; legacy initialization
exists solely at the explicit Workflow boundary. Fresh initial and mandatory postjoin proof,
short signed grants, binding/region/member/lease/allocation fences and current job revocation
remain. Migration0022 adds only nullable bounded JSON plus a once-set immutable trigger;
the actual Dev migration ledger contains all21 previous migrations, with only0022 pending.
The additive migration remains unexecuted. US Ready/SQL/backup/WAL/restore/reclamation and
software alignment remain unaccepted.

Source `016e03a376`, full CI `37698285477`, is delivered API-only with one tracked
D1 migration0022. Fresh before/after checks confirmed every old field preserved, the new
column NULL on both existing jobs and the immutable trigger/ledger entry. The qualified
Native64 manifest and full configuration remained exact. One original-Workflow resume
retained the48 MiB acknowledged/pending checkpoint. A fresh preparation led to the explicit
legacy lifecycle authorization, bound to the same input/instance atrevision13; no disk reset
or blind write replay occurred. At23:03:55Z the original proof was expired by24.682 seconds,
yet the job wasrunning atrevision21 with112 MiB acknowledged. Subsequent progress reached
1.5 GiB without another scan or error. The completed preceding1,800-second capture contained
502 owned frames and only1 OAuth plus2 GET calls, allfirst-prewrite; routine stages remained
zero. The continuation capture separately observed1 OAuth plus2 GET at the legacy lifecycle
boundary; it remains open and must not be counted as a completed-window or lifetime total.

A retained policy audit found V155 in both order configurations and reserved RAM geometry.
All three actual EU PostgreSQL Pods request/limit1 GiB, so128 MiB activation requires a
data-preserving transition. A real-D1 regression now permits geometry changes only with the
entire assigned cohort confirmed manually suspended/hibernated at its current observed
generation, an owned succeeded suspend operation and no unsettled starts, atomically with
the policy write. Partial, idle and stale cohorts remain blocked.22 affected RAM/startup
cases, API types/lint/formatting and independent review pass; no EU suspension occurred.
Two once-only policy PUTs corrected the configured order toV159/one month/no add-ons and
activated USactual_ram/128 MiB/max4096 while the exact original demand was still unplaced.
EU remains reserved. Fresh readback preserved EU Nodes/data/storage/roles/custody/profiles,
the current US immutable input and monotonically advancing progress, with zero provider calls.
Caps remainEU3/US1; purchases_enabled1 permits costed individual orders, autoscale_enabled0
and standing_cost_profileNULL supply no autonomous purchase authority. Finite standing
spend/count/expiry and any cap increase still require explicit owner approval.

The owner requires the same reproducible EU/US software basis. Current EU1.36.3
material is immutable revision1, and prior current-source/worker composition selected1
unconditionally. A metadata-only administrator synchronization path now stages immutable
seed/join revision2 through the existing encryption functions, preserving every old key,
certificate, UID and ciphertext. An internal active-revision pointer defaults to1. Activation
changes only Kubernetes version metadata after administrator-verified native readback, with
exact old/new material hashes, complete fresh Node UID set/CUID and no active installation
operations. The final atomic CAS retains120-second readback freshness and180-second CF Node
observations; completed retries validate the exact committed provenance/body and historical
hashes without another write. New worker jobs persist the selected join reference and fence
the region revision in their initial INSERT. Historical job references and first-control
sealing remain1.150 affected API cases, types/lint/formatting and independent review pass.
Migration0023 and activation remain unexecuted. Existing Native/proof payload contracts and
the qualified Native64 image are unchanged; live US remains on the accepted016 API stand.

The original US job completed all4,453,302,272 raw image bytes at00:08:18Z, then
advanced through GPT completion, rescue reboot, authenticated maintenance and configuration.
The initial Talos reboot command timed out after its9-minute subprocess limit: pinned
talosctl defaults to waiting for MachineReady, while Kubernetes bootstrap follows that
command. Programmed re-entry confirmed changed boot ID and authenticated readback without
repeating reboot/apply, then entered Kubernetes bootstrap. A subsequent read failed once,
after which immutable join_bundle:1 was already sealed. Re-entry nevertheless requested
new kubeconfig credentials and attempted a second exact seal, producingcredentials_not_sealed.
The reproducing Native fixture fails with that exact code. The correction reuses the sealed
kubeconfig, freshly verifies the same kube-system UID and rechecks exact CF material before
continuing; first generation/sealing and strict unknown-seal recovery remain. The initial
reboot now uses--wait=false while retaining separate changed-boot/authenticated checks;
re-entry still skips reboot entirely.31 complete bootstrap cases, Native types/lint/format
and independent join review pass. One controlled pause atstep303 preserved the full image,
original operation/input and already-sealed join1 credentials. A changed qualified Native
image is required for these measured software corrections; no EU or provider action occurred.

Source `65f17cbd`, full CI `37723131617`, is delivered with newly qualified Native
manifest `sha256:8e24e5cb6bdee46eb1437b107996d9c974159bddf6ed507f457042d3bed873a7`.
Qualification passed18 layers/714,984,023 bytes with zero unresolved findings; complete
private readback verified162,119,661 compressed and502,866,944 raw bytes. One tracked
migration0023 retained all active revisions1/provenanceNULL, with no material activation.
All EU/data/custody and the complete original US image/join1 were preserved. Pre-intent
capture refused one waiting-diagnostic update640→641 and a normal regional heartbeat; exact
checkpoint/crypto equality and valid monotonic heartbeat handling resolved those metadata
guards without another build/push or unsafe mutation replay. One publication and one original
resume produced actualrunning Native placement/image evidence. The retained-join correction
advanced immediately tokubernetes_joined/revision642. Next, Helm preflight failed with
native_command_failed_helm_1 before Cilium install intent. The exact command was reproduced
offline against the actual qualified image: Helm4.3.0 rejects the obsolete`helm list --all`
flag and already lists every state by default. Removing only that flag retains exact
namespace/filter/JSON and existing-pending-release refusal.44 affected cases, Native
types/lint/formatting and independent review pass. One controlled pause atstep352 preserves
the joined cluster and full image. A changed Native delivery is needed for this concrete
compatibility defect; no existing cluster installation is repeated.

Source `888260d2`, full CI `37726457006`, delivered the Helm4 preflight correction once
with qualified Native manifest
`sha256:3a17c7ce025506c912c24b67b3d20f853e4981195505e0de270b40474f9d63fd`.
Qualification covered18 layers/714,984,025 bytes with zero unresolved findings; complete
registry readback verified162,119,652 compressed and502,866,944 raw bytes. The actual
running placement matched that image. The same US operation passed the preflight and
stored `cilium_install_intent`; subsequent reads found no Cilium Helm release, CRDs or
workloads. A pinned Helm server dry run reproduced a failed discovery lookup. Exact
local proxy tracing established the issuer: the fifth authorized CONNECT received a local
HTTP403 because four tunnels occupied eight entries in a set containing both socket ends.
The same authenticated Kubernetes discovery read succeeded separately. This is our Native
connection-accounting defect, not an observed Contabo or Kubernetes permission failure.
These diagnostics performed no provider calls or cluster writes and retained the same
sealed cluster identity. The original install response was discarded, so these three empty
resource groups alone do not authorize repeating its uncertain write. Full effect-absence
resolution and a bounded persisted recovery are required before the same job can continue.

The connection correction counts incoming clients once and retains both socket ends for
cleanup, including failed grants and clients closing before a grant completes. Actual Helm
server dry runs established that eight and sixteen incoming clients were also insufficient:
the sixteen-client run recorded11 connection drops. The bounded64-client correction passed
the same actual pinned-chart server dry run with42 CONNECTs, a peak of30 clients, zero drops
and exit0. It preserved the original cluster/certificate/join/job identities and left zero
Cilium CRDs, workloads or release records. Three proxy cases pass, including64 admitted clients,
the65th refused and failed/closed/pending grants releasing reservations. Targets, independent
transport grants, TLS, expiry and cleanup remain unchanged; these were read-only diagnostics
with zero provider calls. The original US Workflow was paused once atstep580 while the safe
same-intent recovery correction was prepared; no image reinstall or EU write occurred.

The recovery correction retains the original Cilium intent and appends exactly one attempt2
claim after the serialized executor confirms its prior command closed, the pinned chart has
no separate CRD/hooks, all rendered resources and complete Helm storage are absent, and
fresh Node ownership labels/address/version/quarantine, Node UID and sealed Cluster UID
match before and after. Cloudflare binds the receipt to the exact job, checkpoint, material
and revision with120-second freshness and an atomic single-winner claim. A lost claim
acknowledgement dispatches nothing; consumed authority cannot be erased or replaced, and
later resumes observe only. Existing deployed releases advance through readback without a
second install. Reproducing tests also exposed registration before reservation: a shared
reservation now precedes the asynchronous status read and all execution paths honor the same
busy guards.49 real-D1 callback cases,49 affected Native cases, two focused registration/
admission cases and three proxy cases pass, with types/lint/formatting and independent reviews.
These software results and the read-only dry run do not establish US1 Ready or final acceptance.

Source `8c670789`, full CI `37731717699`, delivered qualified Native manifest
`sha256:f892386bc55615820e45c2f34fa5d48f7b375b366b79513b19f95e431295030f` once.
All18 layers/715,002,457 qualification bytes passed with zero unresolved findings;
registry readback verified162,123,561 compressed and502,885,376 raw bytes. Actual running
image evidence matched. One original-operation resume retained the full Talos image,
sealed join1 and installation authority. At05:40:51Z the programmed recovery stopped
before consuming its retry claim with `cilium_recovery_chart_effects_unknown`.
The actual pinned image reproduces this offline: show-CRDs returns empty and the25-object
render includes the legitimate `v1/Namespace/cilium-secrets`. Our inventory incorrectly
rejected every Namespace. The correction includes this exact pinned Namespace as a
cluster-scoped effect and checks its absence alongside its rendered namespaced resources;
an existing Namespace blocks the claim. Hooks, CRDs and unknown scopes remain refused.
The reproducer fails before correction;17 affected installation cases, types/lint/formatting
pass afterward. The same Workflow was paused once for the changed image delivery. No
attempt2 install, provider action, disk rewrite or EU mutation occurred; US1 Ready remains pending.

Source `f0f7a732`, full CI `37734080038`, delivered qualified Native manifest
`sha256:b8d102c4d4c91dc57ca4316ebec446dad53ecb4d2343c80045e4c11a34d14b6d` once.
Qualification passed18 layers/715,002,969 bytes; full readback verified162,123,629 compressed
and502,885,888 raw bytes. Actual running image matched after one original-operation resume.
The complete absence path reached its claim, which received HTTP409 at06:10:53.548Z;
the saved job subsequently reported `checkpoint_acknowledgement_uncertain`, with no
attempt2 journal and no install dispatched. The historical response body/rejection branch
was not retained, so the precise rejected predicate is not established. The observed path
took several minutes and produced151 successful authority frames plus69 relay frames by
06:10:50Z, including redundant Kubernetes discovery. One controlled pause atstep752
retained the original image/join/intent. The completed earlier30-minute capture recorded
zero provider wire events; it covers that window only, and overlaps the later capture.

The follow-up uses exact typed REST collections and encoded name selectors for complete
absence, with four bounded concurrent reads. Unknown/partial lists, mismatched TypeMeta,
existing effects and changed identities still block. Static chart rendering precedes the
fresh physical observation window, which keeps the same120-second API limit. A delayed
130-second render reproduces the former prematurely aged window locally; this does not
prove the historical409 cause. The remaining sealed-cluster authorization read also uses
the exact Namespace REST path. Finite rejection diagnostics identify only fixed reasons,
the owned operation and bounded ages, without payloads, credentials, UIDs or hashes.
No authority, CAS, expiry, provider boundary or attempt limit is relaxed. Full US1 acceptance
remains outstanding.

Source `6b792ea9`, full CI `37738340444`, delivered Native
`sha256:a7b439aec4369fd4cfbe1001db169bec1716fc1b1f2105f2e1a96cbaf6107e2a` once.
Qualification passed18 layers/715,005,011 bytes; full readback verified162,124,143 compressed
and502,887,936 raw bytes. Actual running image matched. The original operation consumed its
single attempt2 claim after25 absent resources and zero Helm storage records, with matching
physical identities. Its fresh window measured46,129ms (06:54:46.922Z–06:55:33.051Z).
Programmed Cilium installation reached `cilium_installed` at06:59:41Z, then Flux intent at
07:03:56Z. Flux readback stopped with `platform_resource_mismatch`. One bounded read-only
probe confirmed the exact mismatch: expected ResourceQuota hard pod count `1000`, actual
Kubernetes canonical quantity `1k`; the Namespace and all ownership/custody/physical identities
matched, and the whole job stayed at revision679. No provider or cluster write occurred.
The correction uses the existing exact integral Quantity parser only for v1 ResourceQuota
`spec.hard.pods`, retaining all other predicates. The reproducer first fails, then26 affected
tests/types/lint/formatting and independent review pass. The integration resumes the retained
Flux intent without another Flux apply. The original Workflow was paused once for this
changed Native delivery; its consumed Cilium journal remains immutable. US1 Ready and the
SQL/backup/WAL/restore/reclamation acceptance are still pending.

Before publishing the quota-only local correction, a complete bounded43-object live readback
confirmed34 exact matches, six Ready Deployments with CPU limit `1000m` canonicalized to `1`,
and three genuinely absent objects: Services `source-watcher`/`webhook-receiver` and Deployment
`helm-controller` in `flux-system`. Whole job682, physical identities and sealed custody stayed
unchanged; provider/cluster writes were zero. One server dry run of each exact missing manifest
passed current Kubernetes admission, also without writes. This does not establish the cause
of the original partial apply. The composed correction narrowly normalizes the observed CPU
limits and adds one Cloudflare CAS-bound Flux repair journal. A fresh complete inspection must
confirm every present object is owned and bind its UID/spec set; only the exact absent pinned
objects may be created after acknowledged intent persistence. Namespace ownership is checked
again immediately before dispatch. Unknown claim or create outcomes retain the journal and
use readback only; existing Flux objects are never reapplied. A reproduced same-UID ownership
revocation blocks creation.66 affected Native and54 real-D1 callback cases, types/lint/formatting
and independent reviews pass locally. No repair dispatch or final US acceptance has occurred.

Source `001fadbc`, full CI `37745087265`, delivered Native
`sha256:8dbe6e380888c9d71bc5a2897522410dd22435795ea23495072a8af78482ce4b` once.
All18 layers/715,026,009 qualification bytes passed; complete readback verified162,127,757
compressed and502,908,928 raw bytes. The actual running image matched. The same operation
consumed its Flux subset repair at08:01:16Z, confirmed `flux_installed` at08:02:50Z and entered
`platform_sync_intent` at08:03:05Z. During reconciliation, Cilium readback remained blocked.
One bounded read-only probe established the exact cause: deployed chart version
`1.20.2+a7c12d330dd9` rather than literal `1.20.2`, with exact application version, bootstrap
operation label and values. The suffix matches the full pinned OCI digest. GitRepository,
Kustomization and Cilium HelmRelease were Ready. A subsequent bounded remaining-platform read
observed the four other HelmReleases Ready, exact OCI content/source and storage/CSI values;
one normal job revision/timestamp update693→694 prevents claiming whole-row equality for
that second probe, while checkpoint, input, authorization and custody remained exact.
No provider or cluster writes occurred in either probe.

The correction permits only the original chart version before platform synchronization and
the exact pinned digest suffix afterward, requiring current owned reviewed Git/Kustomization,
OCI digest plus original chart-byte hash, exact Ready HelmRelease and referenced values
ConfigMap ownership/content/UID, and stable physical identities. No wildcard version or
reinstall is permitted. The failure and a same-UID ConfigMap ownership/content failure were
reproduced first;41 affected cases, types/lint/formatting and independent review pass locally.
The original operation was paused once for the changed readback image. Both consumed journals
remain immutable; full US1 admission and customer-operation acceptance are still pending.

Source `49dadaa2`, full CI `37750099518`, delivered Native
`sha256:7c1251b3f6fb93cfa6dc6e5d5936fc567c0bf4b8ded1c8c3589ef20b7e69af5f` once.
Qualification passed18 layers/715,032,661 bytes; complete registry readback verified162,128,780
compressed and502,915,584 raw bytes. Actual running image matched. The same operation confirmed
`platform_ready` at08:55:03Z and entered regional installation at08:55:49Z. Regional readback
then reported `regional_deployment_mismatch`. One bounded read-only inspection established
that all three Deployments were owned/Ready with correct replicas and quarantine tolerations,
and the regional ConfigMap/Kustomization matched. Only Native's stale cloudflared image digest
differed: the deployed `sha256:9b49eed8f62806d5d45ddf59ecefb5710429598ea6d3fcccd2af938f621b2b07`
matches the unchanged reviewed Git manifest and version lock. Whole job702 and sealed physical
identities/custody stayed exact; provider/cluster writes were zero. The narrow correction binds
Native's expected image to that existing pin. The actual-pin reproducer fails first, then43
affected cases/types/lint/formatting and independent review pass; wrong digests still reject.
The original operation was paused once for readback delivery. No component reapply or source
pin update occurred. US1 admission and full SQL/backup/WAL/restore/reclamation remain pending.

Source `5f7972a0`, full CI `37754616319`, delivered the cloudflared readback pin once with
qualified Native `sha256:8701a358bc8e62a5cf5697d5064097d4bbbf7d9c9d8baa6569e23bf8b38efb89`.
All18 layers/715,032,665 qualification bytes passed; full registry readback verified162,128,802
compressed and502,915,584 raw bytes. The actual running image matched. The original operation
confirmed `regional_ready` at09:37:07Z, preserving both consumed repair journals and the complete
installed image. Its final bootstrap verification stopped at revision706 with the generic
`bootstrap_readback_failed` at09:47:57Z. One bounded read-only inspection confirmed every current
authenticated Talos prerequisite: exact version/disk, ready expected volumes/STATE and writable
LVM geometry. Whole job706 and sealed Node/Cluster/boot/system/configuration/custody identities
remained exact; provider calls and cluster writes were zero. These facts do not reproduce the
generic failure or establish which later publisher failed. Diagnose that exact path before
another delivery or mutation. US1 admission and all customer-operation acceptance remain pending.
The completed1,800-second capture ending09:53:17Z contains zero actual provider wire events;
this is a bounded-window measurement, not a historical lifetime count.

The retained storage trial proves the publisher was entered: its first intent is committed,
but every resource/volume UID and allocation field remains null. Its fresh sample preceded the
generic failure by80.147 seconds; this does not establish the earlier publisher start or prove
a timeout. A second bounded read-only inspection found all five exact planned trial objects
absent, with whole job706 and physical/cluster/custody identities unchanged. Provider/customer
reads and cluster writes were zero. Retained Tail data lacks statuses for some RPC frames, so
it does not prove every authority callback succeeded. Four failing regressions reproduce raw
authority transport/JSON/schema and storage-abort errors escaping as the generic diagnostic.
The narrow correction exposes only fixed error codes while preserving explicit BootstrapErrors,
all deadlines, authority validation and uncertain-write readback. No timeout increase, retry,
reinstallation or fictional progress is introduced. The underlying live cause remains unknown
until the same operation runs this diagnostic correction.

Before dispatching an operator pause, fresh authoritative readback found genuine forward
progress to revision708: the first storage trial is now `cleanup`, still with every resource,
volume and allocation field null, and the explicit error is `storage_trial_deadline`.
The earlier intent-only pause guard refused before any binding or mutation intent. This later
error establishes the producer's270-second deadline failure; it does not retroactively identify
the original generic exception. One subsequently bound pause succeeded, and readback confirmed
the original Workflow paused atstep496 with whole job708 unchanged. The performance correction
removes redundant Kubernetes discovery and batches independent read-only facts with a maximum
of four concurrent requests, draining failures before subsequent work. Original authority calls,
before/after Node/Cluster identity, Talos/PV/VG/LV/CSI comparisons, deadlines and mutation fences
remain; no observation cache or timeout increase is used. Live re-entry remains pending.
The regression's fixed20-second command latency makes the actual old serial reader exceed that
budget at300 seconds; the repaired reader completes at100 seconds with a peak of four and no
outstanding sibling. These are modeled test times, not live rollout measurements. Existing live
probe logs show2.172–2.970 seconds per Talos prerequisite and1.918–3.326 seconds for raw Kubernetes
identity reads. They support the optimization but do not prove the full producer fits its budget;
that includes allocation, writes, cleanup and publication and still requires live acceptance.
Final review also reproduced missing/null list metadata incorrectly establishing absence. The
strict metadata check now rejects those responses before creation.61 affected tests, Native
types/lint/formatting and independent review pass. The final source retains the same270/285-second
deadlines and every uncertain-mutation readback; one CI and qualified delivery are pending.

Source `d787e31f`, full CI `37763622970`, delivered qualified Native
`sha256:7da1bfa25a9dced925bffb05df32961c84d265051619c0b98720f736385a6221` once.
All18 layers/715,037,273 qualification bytes passed; full registry readback verified162,129,649
compressed and502,920,192 raw bytes. Actual running image/version33 matched. Protected EU data,
custody, API bindings, original US input/full image/join and both consumed repair journals stayed
unchanged. The same Workflow resumed at10:45:16.454Z. Fresh bounded captures confirmed current
bootstrap callback HTTP200 activity; they do not identify the executing publisher from routing
alone. The old empty trial was physically confirmed reclaimed at11:04:07.288Z, then round2 began
at11:05:01.210Z and its Namespace UID was durably recorded. Revision712 stopped with the explicit
`storage_trial_aborted`; no PVC/Pod/PV/LVM allocation or data write is recorded. One subsequent
pause succeeded atstep700 with whole job712 unchanged. The completed30-minute capture ending
11:12:49.173Z recorded zero provider wire events in all stages; counts apply only to that window.

A complete producer regression now advances both wall and monotonic clocks using the observed
3-second native and1.2-second callback latency model, including retained cleanup, creation,
physical allocation/write/reclamation and publication. The original270-second aggregate budget
fails after namespace progress. Raising only that aggregate still exposes the separate historical
300-second proof-start window. The corrected design keeps current authority, per-request deadlines,
transport expiry, stable identities and fresh completion/current capacity, while bounding the
entire guarded Native trial separately. Legacy manual proof rules remain unchanged. These are
modeled durations; final software checks, delivery and full live acceptance remain pending.
The complete upper-latency model uses3.5-second native commands,1.2-second fresh callbacks and
three callbacks per custody save. It completes in856.3 seconds, with554.9 seconds of historical
trial span and131.9 seconds from completion to publication. The bounded producer allowance is
900 seconds (the first whole-minute bound covering that model), plus the existing15-second outer
margin. An internal literal selector is supplied only by Native; no external setting is added.
Fresh completion remains300 seconds, all15/20-second request bounds and identities remain, and
the legacy manual300-second start-age/duration predicates are unchanged. Actual live timing is
still required; the model is not acceptance evidence.
77 affected tests, strict Native types, scoped lint and independent review pass. Negative checks
retain stale-completion, future, overlong-history and changed-identity rejection, and the manual
default rejects the same aged proof. One final CI and qualified delivery remain pending.

Final operator acceptance requires programmed US1 Ready, Cloudflare SQL with nonsuperuser
roles and TLS, R2 base backup and post-commit WAL, restore, and deletion with measured physical
LV/VG reclamation. Report the instrumented resume-to-Ready/first-SQL duration and actual provider
HTTP attempts separately from historical order timing; do not infer an undocumented lifetime
call count. Routine transport must show zero provider calls. The 76%/ten fresh consecutive
minute/physical Node UID rule, V159 one-month/no-storage-addon model and continued placement
under full PostgreSQL/Barman startup guards remain; finite recorded spend/node limits gate
purchases. No unlimited authorization or additional 81% placement cutoff is introduced.

Latest owner topology overrides the earlier V155 replacement/removal plan: retain the existing
EU control/relay VPS and the already-admitted EU worker, now customer **EU1**. Both customer
servers use **V159 / Cloud VPS Plus 4: 4 vCPU, 8 GiB RAM, 150 GiB NVMe**, not the prior 8-vCPU /
24-GiB V155 offer. Exactly one matching **US1** was purchased through the API with a one-month
term and no storage add-ons. HTTP201, the original-request CREATED audit and allocated
4 vCPU / 8,192 MiB / 153,600 MiB hardware are verified; provider state is Running. Advertised
US-central cost is EUR16.60 net/month and EUR0 setup (EUR20.09 at21% VAT). EU1 received only a
provider display-name update; its hardware, network, status, existing Node/data/custody remain
protected. Do not reset, re-adopt, decommission or wipe this retained customer EU1. US1 still
requires the programmed Cloudflare installation profile, bootstrap and admission; provider
Running is not Kubernetes/customer readiness. The 76% rolling-ten-minute purchase rule and
continued placement under hard capacity/startup guards remain unchanged.
The US installation profile is sealed and its canonical hash was confirmed by a separate GET.
The first adoption's same Workflow passed a real pre-installer pause/resume without another order.
Its first firewall inventory read rejected a real empty HTTP200 page with `totalElements:0`,
`totalPages:0` and an empty `last` link. Source `dd8f8648`, full CI `37531022272`, fixes that parser
and preserves the original firewall dispatch boundary on failed reads. Its single API publication
retained the native image/configuration/namespace, both EU Nodes, database/storage/role/Secret
identities, EU custody and US profile. Container application version11 uses the same qualified
native image. The old untouched audited adoption was cancelled through the guarded API and its
same Workflow was confirmed terminated; its permanent claim, receipt and audit remain unchanged.
A fresh adoption of the same paid US1 returned202, with no new order. Cloudflare created and
confirmed its owned free firewall, sealed one installation binding, verified network readback and
received one accepted rescue response. Hardware inspection has not yet reported, so there is
still no bootstrap job, admitted US Node or installation disk write. A bounded administrator
inspection status getter is delivered from `4b8dd167`, full CI `37534977719`;34 scoped tests,
types, lint, formatting and independent review passed. Its once-only publication preserved the
full native configuration and namespace, EU data/custody and US immutable input/claims. The same
US Workflow was paused and resumed; native inspection then reported `inspection_image_gpt_invalid`.
The exact official Talos1.14.1 image has232,141,432 compressed bytes and4,453,302,272 raw bytes,
raw SHA-256 `b915cdcdb1a6de6e8754a287c688083187eaab45d775917384a727df125d1064`.
Independent local verification passed both header and partition-array CRCs, reciprocal/end-of-file
header locations and four non-overlapping partitions. Linux `sgdisk`1.0.9 returned0, with a valid
success banner preceded only by its advisory about the gap from sector33 to first-usable2048.
The bytes remained unchanged. Source `51e35a70`, full CI `37538558462`, corrects only that known
advisory;151 native cases, types, lint and formatting passed. Local qualification covered
714,909,269 bytes and18 layers with zero unresolved findings. One private-registry push followed
by complete readback verified162,107,967 compressed and502,792,192 raw bytes. The new immutable
native manifest is `sha256:cdd073e15d520924f108cbb6b24c4cecfcc29086b1b142856fda89be2fecbe36`.
One publication and completed rollout preserved the full existing configuration except this
image, both EU Nodes/data/custody and the same US sealed input, firewall, rescue receipt and plan.
Actual running placement/image/version was separately verified. The original US Workflow resumed;
hardware inspection reported successfully at generation1, then the programmed installer job was
created and authorized. Its checkpoint remains `created`, before any installation disk write.
Preparation network proof is still pending. The bounded administrator proof-status getter
was delivered from `794ea48e`, full CI `37544949566`; its one API-only publication preserved
the native image/configuration, all EU identities/data/custody, US profile and the whole sealed
authorized created job. A single controlled resume of the same Workflow exposed
`node_proof_kubeconfig_identity_changed`. Authenticated offline decryption of the retained EU
join-bundle revision1 confirms that its entire clear object, kubeconfig, endpoint and cluster UID
match the protected source. Every identity/TLS predicate passes; only its ordinary
`context.namespace: default` was rejected by the native guard. Source `760b9d52`, full CI
`37546264388`, permits only absent or exact default and removes the field only in the derived
scratch copy. All154 native tests, types, lint, formatting and independent reviews passed.
Local qualification covered714,922,071 bytes and18 layers with zero unresolved findings;
private-registry readback verified162,109,966 compressed and502,804,992 raw bytes. The immutable
native manifest is `sha256:99a98cba6a6c75cfa933bb341b924a017b680f96fba126c418306e5ee679c101`.
One publication/completed rollout preserved all existing configuration except the image URI,
EU data/custody, US profile and whole created-job ciphertext; actual running image and positive
placement/version were independently verified. One controlled resume reached real source Pods,
both Ready with the qualified regional image and zero restarts. A scanner then reported
`outside_scan_control_invalid`; its control rejects bearers longer than256 characters, while
the authoritative signed `np1` session contract and issuer permit4096. Source `cc072011` fixes that producer/consumer
mismatch by sharing the existing exact `np1`/4096 schema; legacy bearers retain256 and every
other control guard remains. Both real-signed946-character regressions reproduced the rejection;
156 native,237 harness and151 contract tests, types, lint, formatting and independent review
passed. Full CI `37548806187` passed. Local qualification covered714,947,157 bytes and18 layers
with zero unresolved findings; complete private-registry readback verified162,113,966 compressed
and502,830,080 raw bytes. The new native manifest is
`sha256:4651403b9d4aac87bf272a2cd3040b91d7b41904691c777426a8effef62e8aaa`.
One publication/completed rollout preserved configuration except its URI, all EU/US custody and
the whole created job; actual running placement/version/image were independently verified.
Fresh attempts still reached no new source scanner. A bounded private Worker Tail confirmed
successful ownership/transport callbacks: ownership wall-time median383ms, transport median
3,681.5ms across9/18 requests, all HTTP200 in that sample. Both old exact source namespaces
remained Active without deletion timestamps. A real cleanup-path virtual-clock regression using
those measured3.7-second authorization/CONNECT and380ms ownership costs reproduced the30-second
aggregate cleanup exhaustion before any deletion. Source `14957682` changes only the explicit
expired-source aggregate budget to120 seconds, retaining30-second individual commands,540-second
session expiry and all ownership/UID/resource-version/foreign-child checks. A108,440ms virtual
cleanup path with29 measured-cost grants completes exact cleanup;30 seconds performs no deletion
and120,001ms is refused before grants. All157 native tests, types, lint, formatting and independent
review passed; local full qualification covered714,947,157 bytes/18 layers with zero unresolved
findings. CI `37552431256` then failed a test-only unbounded `apt` substring check against compressed
staging data. Deterministic gzip/base64 bytes reproduce that false positive; the test guard now
recognizes real package/filesystem/reboot commands and disk-write arguments while accepting the
encoded data. Production bytes are unchanged by this test correction. No149 image credential,
push or publication ran. Source `bae2bbb2`, full CI `37553462417`, passed158 native tests and
complete local qualification:714,947,157 bytes/18 layers/zero unresolved findings. One registry
push with complete readback verified162,113,993 compressed and502,830,080 raw bytes; manifest
`sha256:238240441908357b996e2d8c34279a96afb3037cb14eaf7cc3ffbe060c170d5d`.
One publication/completed rollout retained the full configuration except its URI, whole created
job/seals and EU/US custody. Direct running placement/version/image verification passed. Journal
retention is structural through the same DO namespace/configuration and absence of reset/write
commands; before/after journal-value equality was not directly inspected. One controlled resume
hit `ContaboError: unexpected_status`; this code is a provider GET failure, and the original
vendor status/route is absent from serialized Workflow error metadata. No mutation was replayed.
The existing same-ID recovery path restarted the Workflow automatically; that does not establish
proof acceptance. Preparation remains awaiting_proof with no signed artifact, and the original
bootstrap stayscreated/revision0/downloaded0/written0. Native proof attempts still fail or retry
before new scanners. The bounded administrator preparation-journal getter is delivered from
`770e00a6`, full CI `37557199208`; 48 scoped tests, types, lint, formatting and independent review
passed. Its one API publication reused the qualified native image/configuration and preserved
the whole paused created job, both EU Nodes, database/storage/role identities and EU/US custody.
It reads current session timestamps and existing source stages/UID hashes locally, without
Container contact, session creation, authority or storage mutation. A controlled same-ID resume
then exposed a real native `job_cancelled` at 01:49:52.584 UTC for the session issued 01:48:19.009 UTC:
93.6 seconds elapsed, with 446.4 seconds remaining before its full 540-second expiry. Full-session
expiry is excluded; the exact cleanup command and abort origin remain unconfirmed. Both older
journals stayed at cleanup, with no new scanner or US installation write in that measured attempt.
The finite cleanup diagnostics are delivered from `2fce564f`, full CI `37560247666`;
161 native tests, types, lint and independent review passed. Local qualification covered
714,959,449 bytes/18 layers with zero unresolved findings; complete private-registry readback
verified 162,115,839 compressed and 502,842,368 raw bytes. Native manifest
`sha256:c8727fb4538592d667749ebcc1af4aa0d52d78052891755af8c7341b6e93f781` uses the same protected
namespace/configuration except its URI. Direct deployment version 16/current placement 16 is
RUNNING with that exact image, while the aggregate active counter remains 0; the discrepancy is
retained without assuming its cause. The original created job, EU/US data identities and custody
remain unchanged. A controlled resume then reported
`proof_source_cleanup_namespace_inventory_command_deadline` at 02:29:07.128 UTC, 97.945 seconds
after issuance at 02:27:29.183 UTC, with 442.055 seconds before expiry. The failing operation is
the combined thirteen-kind namespace inventory under the existing 30-second command bound.
Both old journals remained at cleanup and no US installation write occurred in that measured
attempt. The bounded inventory fix uses fixed 4/3/3/3 batches, at most two concurrent reads and
two fully settled waves. A measured-grant-cost virtual path completes in 115,840 ms; a serial
model exceeds the aggregate bound. All responses and foreign-child checks precede namespace
deletion, with the original total 256 KiB output bound and unchanged 30/120/540-second limits,
UID/resource-version checks and unknown-delete readback. The fix is delivered from `17b299a7`,
full CI `37563569399`; 165 native tests, types, lint, formatting and independent review passed.
Local qualification covered 714,959,961 bytes/18 layers with zero unresolved findings; private
readback verified 162,116,097 compressed and 502,842,880 raw bytes. Native manifest
`sha256:8bbf705897fa1e0ff9030ebffdeb7ccf846d8af281966781155374c52a49c771` is verified in direct
RUNNING deployment/current placement version 17, with aggregate active counter 0 retained as a
discrepancy. One publication and same-Workflow resume retained the original created job and
all protected EU/US identities, seals and custody. Public monitoring then saw running,
unavailable/invalid status and programmed session turnover, without a captured valid terminal;
no exit/OOM cause is established. The shared getter contract omitted thirty reachable fixed
proxy/packet errors, so a matching failed native body could be hidden as invalid status. The
real D1 getter regression reproduced this rejection; the API-only contract repair adds exactly
those fixed codes without widening strings, changing response shapes or starting/minting work.
Source `e12a5602` CI `37567110056` failed only the existing actual-RAM placement fixture;
the diagnostic regressions passed and no API publication was attempted. The unchanged domain
and real fixture reproduce a strict-newer timestamp boundary: ten 75% observations are accepted,
ten 76% observations at the same timestamps are ignored, and ten at +1 ms trigger expansion.
The CI observation timestamps were not captured, so that collision is not claimed as recorded
in CI. The test now uses one fresh minute-contained anchor with explicit +1/+2/+3 ms chronology
and asserts each observation's acceptance; production threshold, freshness and monotonicity
guards are unchanged.
The API-only repair is delivered from `07c73d1f`, full CI `37567807420`; one publication retained
Native `8bbf7058`, its configuration/namespace and the original paused created job, followed by
one same-Workflow resume. The finite-code monitor caught `proof_source_deadline` at
03:54:27.235 UTC, 123.838 seconds after the 03:52:23.397 issuance, with 416.162 seconds remaining.
This proves the expired-source aggregate bound was reached; it is not a completed cleanup
duration or full-session expiry. Both old source namespaces remain Active and nondeleting,
one without a Pod and one with the same failed scanner Pod. The minimal round-trip reduction
coalesces fresh kube-system/known-Node identity reads into one strict two-object List at every
existing check, including before each delete. The observed 4,143 ms slow-grant scenario failed
before the change and completes in a 104,715 ms virtual model after it. This is not live acceptance;
all prior UID/provider/region/Ready/IP/deletion predicates, 13-kind foreign checks, 256 KiB bound,
uncertain-delete readback and 30/120/540-second limits remain unchanged.
The round-trip fix is delivered from `fb08b4c0`, full CI `37569774122`; local qualification
covered 714,964,047 bytes/18 layers with zero unresolved findings and private readback verified
162,116,642 compressed and 502,846,976 raw bytes. One image-only publication and same-Workflow
resume preserved the original created job and all protected state. Direct RUNNING deployment
and placement version 18 use qualified Native `51dcfff4`; aggregate active count 0 remains an
explicit discrepancy. The monitor caught `node_proof_transport_refused` at 04:24:00.463 UTC,
78.765 seconds after issuance, with 461.235 seconds remaining. Existing automatic work continued;
a bounded read-only Worker Tail captured 49 owned POST events, including one transport HTTP 500
with 855 ms elapsed beside HTTP 200 responses. The caught server exception had no recorded
exception or response code, so its failing stage remains unknown. The API-only diagnostic
change emits only nine fixed stages, fixed exception categories, a runtime-validated API code,
eleven known provider codes with bounded HTTP status and the existing server-generated
diagnostic UUID; it rethrows the original error with the same
operation order, requests, authority and time limits. Native `51dcfff4` remains unchanged.
The diagnostic API is delivered from `c528e280`, full CI `37572506643`, preserving Native
configuration, namespace, seals and custody through one publication and same-Workflow resume.
That monitored attempt ended with `proof_source_cleanup_namespace_inventory_command_deadline`
after 88.928 seconds, with 451.072 seconds remaining; it is not claimed to be the transport
refusal captured separately. The correlated owned transport trace recorded HTTP 500/848 ms
at `source_authority`, category `provider_error`, code `authorization_unavailable`, provider
HTTP 400, beside HTTP 200 requests. The provider client emits that code for its OAuth password
grant response. The factory created a new client on every source authorization, discarding its
existing token expiry and concurrent-authentication state. A real-client regression reproduced
two OAuth calls for two concurrent fresh GETs; the bounded one-slot credential-scoped reuse
reduces this to one OAuth call while retaining both GETs. Exact credential change, early expiry,
401 invalidation and caller-abort isolation remain tested; no inventory, authority, token
persistence, retry or Native behavior is added. This authentication fix still requires live acceptance.
US installation/admission is not accepted.
Never reset or replace the job, sealed input, source journals or custody.
The retained EU control node's UID-guarded new-database placement flag is now
false; its Kubernetes/platform readiness and schedulability, and customer EU1, remain preserved.
Actual-RAM mode and automatic purchases remain disabled pending accepted US/recovery tests,
reviewed test cleanup and explicit finite numeric standing limits.
The first EU node and five Flux platform releases are Ready, with 95 GiB measured storage.
Its node identity, storage and protected cluster custody are preserved. The second existing EU
VPS has passed signed network verification and admission, with 95 GiB measured capacity.
Actual capacity demand placed databases on both EU nodes and SQL passed through Cloudflare.
Exactly one new EU and one new US-central Cloud VPS 8 were ordered through the Contabo API.
After payment, both original instances were allocated with 8 vCPU, 24,576 MiB RAM and
307,200 MiB SSD. The owner cancelled these incorrect storage orders; provider readback records
a 2026-11-05 cancellation date while both remain in rescue. Neither has an installer job or disk
write. Replacement EU1 and US1 must use Cloud VPS 8 with 150 GB NVMe; the owner requires API-only
ordering. One further owner-authorized EU V155 / one-month request with the NVMe ExtraStorage
array returned201 and a matching original-request CREATED audit, but final hardware is
8 vCPU, 24,576 MiB RAM and614,400 MiB SSD. It fails the required150 GB NVMe selection.
No US counterpart, installer job or disk write has been triggered for this test. Neither
replacement has passed installation/admission yet.
The original SSD additions are now logically cancelled through the reviewed API: their claims,
receipts, audits and protected EU source/custody remain unchanged, and both reserved slots are
released. The exact original EU Workflow is errored and US is terminated; neither target has
a job, node or disk write. Provider cancellation remains scheduled for 2026-11-05.
No customer or platform production database has been migrated. The approved final topology is
the retained EU control/relay server, the retained admitted customer EU1 (formerly EU2) and one
new US regional/customer server. Existing EU1 is retained; earlier EU2 decommissioning and
destructive loss-drill instructions are superseded by the latest owner topology.
The US Cloudflare region, separate archive bucket, scoped S3 credentials, private data Tunnel
and gateway VPC service are configured. The private bootstrap relay now allows both EU and US.

The current regional image is
`sha256:eeaa6ab0c1fc182e9e050d6f104565ec0a3dc4e7482b1950287c31b62ebe607a`
from `901b3228`, CI `37506713888`, with consumer `b8238bf2` / CI `37514069179`.
Qualification covered 658,637,376 bytes and ten layers with zero unresolved findings.
Anonymous manifest, configuration and every compressed/uncompressed layer verification passed,
with 89,781,987 compressed bytes read back. Agent, both gateways, relay and regional tunnels
passed exact running-image checks and at least 60 seconds of continuous health; five platform
releases are Ready, including Barman plugin v0.15.1 / chart0.8.1. Both EU Node UIDs, all three test databases'
namespace/Cluster/PVC/PV/Secret identities and three EU encrypted custody records are preserved.
The management API now uses headless source `26ab9ee1`, CI `37510045964`; Edge and the regional
image uses `901b3228`; Edge remains at `ab678993`. Complete pending-payment inventory now parses without fabricating
hardware, and configuration, network, relay and proof consumers reject unallocated resources.
Both purchases have original-request-correlated D1 receipts; no order was replayed. The private bootstrap
Workflow, Container and VPC bindings are activated. EU firewall/rescue/operator-source
inputs are now bound. The current native bootstrap image is
`sha256:06a1a6c938f78e64250883d6f3f063a76d029a3ee961b9a4a2456d0c4800e248`
from exact clean `901b3228`: qualification covered 714,834,399 bytes and 18 layers with zero unresolved
findings, followed by exact private-registry manifest, configuration and layer readback.
Direct application readback confirms version 10, the same application/namespace and the completed
exact-image rollout. The earlier `cf6d5d55` runtime was exercised during EU2 admission; the new
headless runtime still requires fresh-node execution. Regional runtime CI `37419289338` and
headless consumer CI `37510045964` are green. US installation and cross-region node-loss
recovery remain outstanding.
The complete headless implementation is committed from `781a48c3`, with clean-checkout test
asset generation and the proof signing alias in `901b3228`. Full CI `37506713888` passed all
software checks and three image jobs. Source `901b3228` produces regional
`sha256:eeaa6ab0c1fc182e9e050d6f104565ec0a3dc4e7482b1950287c31b62ebe607a`
(10 layers, 658,637,376 bytes), native bootstrap
`sha256:c68fe4375dd72c27d4d75fe3ef8d595da2b402d44f938e10bf3c7f96304c1089`
(18 layers, 715,162,096 bytes), and PostgreSQL
`sha256:2c0b286e616191e5103f972181fee2fa7481102bf1a8c0d19154d37f961f3d2d`
(one layer, 1,002,669,632 bytes), all with zero unresolved scanner findings. CI verified actual
SQL/pgvector, the unchanged engine and manifest/configuration bindings. Separate deployment
readback verifies every compressed and uncompressed registry layer. Local checks passed contracts 151,
API 502, Edge 80, regional 425, native 148, CLI 30, harness 237, infrastructure 21 and CI logic 71.
The headless API/native and regional/relay images and four additive migrations are delivered.
PostgreSQL delivery is complete. Profile activation, actual-RAM policy and fresh-node live acceptance remain outstanding.
The regional image’s anonymous readback verified 89,781,987 compressed bytes and all ten raw
layer hashes. Native and PostgreSQL private GHCR namespaces return HTTP 401 to anonymous token
requests. Native uses an independently qualified clean `901b3228` build in the private Cloudflare
registry; PostgreSQL uses the exact qualified public copy and credential-free readback recorded
below. Regional tags, package visibility and account permissions were unchanged.
The first common CI failed because source tests needed their compiled portable scanner; the test
command now builds it. The next PostgreSQL job failed on Docker 28's unsupported inspect platform
flag; explicit inspected architecture and configuration validation now use its supported command.
The retained relay key's kid collides with the legacy verifier's different public key. A tested
optional proof alias permits retaining both existing identities; deployment adds only its matching
public key and identifier, with no private-key rotation. Provider NVMe selection and real US-first /
EU automatic inspection, proof renewal, storage publication, installation and admission remain open.

The private native transfer is complete from exact clean source `901b3228`: immutable manifest
`sha256:06a1a6c938f78e64250883d6f3f063a76d029a3ee961b9a4a2456d0c4800e248`,
config `sha256:1ac27808be59f3cacf2ee872a6199deb1424cb183829a8a9f8eac531d79b2aa4`,
18 layers, 162,106,066 compressed and 502,782,976 raw tar bytes read back exactly. Full local
qualification covered 714,834,399 bytes with zero unresolved findings; full source CI passed.
One registry push occurred; the later API/native rollout below is complete, with no server action.
The attachment
permits private bootstrap storage; anonymous native access is not an acceptance gate.
Full CI `37511566358` passed source `0cf76655`. The exact qualified PostgreSQL manifest was
copied to the existing public runtime package under its distinct immutable `postgres-sha` tag,
without touching regional tags or changing package permissions. Anonymous manifest/configuration
and the complete single layer passed: 219,937,973 compressed bytes, 660,822,016 raw tar bytes,
exact CI hashes, zero unresolved findings. Its public immutable digest is
`sha256:5495f355719f24bd56219bc46825ecfa8771515a110ceca6e4d83331868bf115`.
GitHub owner login is therefore no longer a dependency for these artifact access paths.
PostgreSQL delivery is complete; profile activation and fresh VPS acceptance remain outstanding.
NVMe API selection is
still unverified; the owner explicitly requires API-only ordering.

Headless API/native delivery from exact consumer `26ab9ee1` is complete. A fresh D1 export
rehearsed migrations 0018–0021 against 31 tables and 105,617 rows, preserving every previous
column/value fingerprint with clean integrity and foreign keys. One migration apply and one
API/native publish succeeded. Direct Container application/version readback confirms version 10
and the exact qualified native digest above; the collection endpoint still reported version 9,
so final verification used the direct endpoint without repeating either write. Both old EU Node
UIDs, all three database namespace/Cluster/PVC/PV/Secret identities, role rows, admitted job and
three encrypted EU custody records remain exact, with physical database health confirmed. All
existing policies remain reserved; no profile, provider order, rescue dispatch or disk write ran.
Full consumer CI `37514069179` passed `b8238bf2`, including all three image jobs.

Regional/relay delivery is complete using the already fully qualified image above. Exact running
image IDs and the same old Node, database/storage/role/Secret and encrypted-custody identities
passed. No OS reset/reboot or Flux-controller upgrade occurred. A read-only PostgreSQL baseline
confirms all three databases on18.4, no installed vector extension, zero/zero/one application
relations and both original recovery markers. The first image-only Cluster patch was explicitly
rejected by CloudNativePG with `invalid version tag`: the public `postgres-sha` tag needs a
PostgreSQL version prefix. Readback confirms zero image patches applied, all three physical
databases healthy and protected identities unchanged. The corrected version-prefixed reference
passed actual server dry-run, and full CI `37520820885` passed source `eb995eb8`. One guarded Flux
source update, one non-overlapping Recreate-agent reload and three new UID/RV-guarded image-only
patches completed. All three databases now run PostgreSQL18.6 from the same qualified digest,
with Vector0.8.7 actually available and none installed. Read-only SQL compared the original
application schema/row SHA-256 fingerprints and both recovery markers exactly; no extension
update was needed. Both old Nodes, all database/storage/role/Secret and encrypted custody
identities remain unchanged, and all three physical databases are healthy.

The owner reiterated API-only ordering. Three deliberately unorderable schema-validation probes
used the NVMe shop slug as product ID and snake/camel storage keys. All returned the same HTTP400
base-field validation; the complete provider inventory remained unchanged. These responses do
not prove that any storage selector is supported, and no replacement order was accepted.

The subsequent explicit EU purchase authorization produced exactly one accepted API order using
`addOns.extraStorage.nvme: [{ "sizeTB": 0.15, "quantity": 1 }]`. Its correlated CREATED audit and
allocated hardware confirm **600 GiB SSD**, not150 GB NVMe, with8 vCPU and24 GiB RAM. No US
copy or installation was started. This is a failed variant-selection test despite HTTP201;
physical admission and automatic purchase activation remain blocked on a supported NVMe offer.

Release image signing remains Phase 5 work.

Phase 1's earlier real E0–E6, five create/delete cycles and ten agent restarts passed the complete
API/D1/RegionLink/agent/Tunnel/VPC HTTP/gateway path through `db.ohmyho.st`, with verified
PostgreSQL TLS and no public PostgreSQL port. Backup alarms, source-preserving R2 restore,
missing-ready-namespace protection and full storage reclamation passed. Ordinary deletion retains
archives; the harness purges only its own test objects. API PITR and restore after source deletion
have since passed as recorded below; node-loss and regional disaster recovery remain outstanding.

Phase 2's last complete cold series measured p50/p95/max 8.412/9.160/9.708 s across twenty
independent wakes, twenty distinct Pods and the same cluster/PVC. Each caused one wake and one
configuration revision, preserving data, rollback absence and role Secret identities. On 2026-10-05
the owner accepted the current cold-start times for v1. The original ≤8 s p95 target no longer
blocks current acceptance. The approved Rust runtime and cold-start workstream is described below
and in [the architecture proposal](docs/architecture/rust-runtime-and-cold-starts.md).
Ten simultaneous cold connections coalesced to one wake. A real
read-only transaction prevented idle sleep for 74 s. An always-warm diagnostic measured new
connection plus first read p95 734.438 ms; it is not an application or load-capacity guarantee.
Suspend/resume secured the closed WAL in R2. Hourly awake-time deviation was at most 19.748 s,
below the 60 s target. Resize preserved storage/data in 28.046 s; held-client reconnect counts
remain unmeasured. RAM/storage allocation and connection usage are measured. The new authenticated
kubelet collector measured 185,159,680 used bytes of a 5,368,709,120-byte volume on the recovery
source; missing volume observations remain unknown. Cost attribution is deferred: the owner supplied 13.55 EUR per existing
VPS per month. PGCF supplies resource/consumption metrics; adopter pricing and billing remain
exclusively in the adopter repository.

`pgcf connect` passed actual psql transactions, rollback and 105,216,021 identical binary COPY
bytes. The bridge now refuses MD5 and unknown authentication methods; all 30 CLI tests passed.
Unknown hints avoid D1 and gateway work. A shared Worker source address has no installation-wide
connection limit. Raw 100 MiB/1 GiB integrity, slow reception and 600 s idle passed. The earlier
735.604 SQL/s read test is a bounded measurement, not maximum throughput or customer density.
Decoded binary-result mode remains unsupported; raw COPY and default-text clients pass.

The current image's first fresh E3 failed its required Tail event and was cleaned up. A second
trial passed E0–E5, including exact 28P01 negative authentication, both correlated startup
mismatches, real R2 backup and zero remaining volumes/archives. Deletion took 103.498 s;
separate run cleanup passed. The earlier missing Tail event remains unexplained; bounded failure
diagnostics now retain counts and stages without trace content. Four diagnostic cold starts took
8.645/9.772/9.057/9.695 s with one wake and preserved data. Two initial Cluster PATCH failures
reported Invalid, unchanged UID and changed resource version; a server-only stale-version dry-run
also returned generic Invalid. The exact live rejection cause remains unproven. These four runs
do not replace the historical twenty-run measurement; its current latency is accepted for v1.

Archive-availability and authenticated-idle fixes are integrated and pass local checks, with API
delivery required before the new regional producer. Established readiness keeps every physical,
configuration, TLS, role and post-authentication identity guard but no longer depends on available
archive telemetry. Unknown health remains explicit and alarms after ten minutes across restart.
Only AuthenticationOk starts idle activity; quiescence drains pre-auth transports through bounded
actual close, preserving raw transport counts, authenticated transactions and SQL/WAL safety.
Unknown pipelined outcomes surface as transport failure and are never replayed. Backup metering
now walks up to 16 pages/16,000 objects within one two-second deadline and a 4 MiB key budget;
incomplete or oversized walks remain unknown. The scan is an interval observation, not an atomic
R2 snapshot. Tests pass: contracts 129, API 302, Edge 78, regional 385, native 27, CLI 30, harness
204, infrastructure 21 and CI logic 68, with zero skipped tests. API and regional delivery are
complete; their fresh E0–E5 passed, with deletion in 101.563 s and zero trial volumes/archives.
Two actual unknown archive-health observations preserved ready state and successful SQL;
the temporary metrics-only deny was removed and health recovered. An unauthenticated SCRAM
session with WebSocket pings did not prevent idle hibernation (82.635 s; no password or
AuthenticationOk). The ten-minute unknown alarm is locally tested, not yet live-proven. The later lazy
Actor schema patch passed all 304 API tests: unknown hints create no application tables, while
validated management seeding preserves existing persistent state. Its live delivery remains pending.

Phase 3 software and native images are delivered, not live-accepted. The Dev D1 export restored
locally with clean integrity/foreign-key checks; four additive bootstrap migrations rehearsed
against that export and applied in Dev. The existing first-node provider/Kubernetes identity and
three encrypted agent/seed/join custody records are now imported with fresh provider checks,
exact ciphertext readback and UID-guarded node labels. The existing agent key was retained;
no provider mutation, order or VPS bootstrap was triggered. The native
bootstrap image is qualified and mirrored into the private Cloudflare registry with a complete
readback comparison. A real Worker reached the first-node relay through the dedicated private
Tunnel/VPC service; anonymous calls were refused and the temporary probe was deleted.
The additive recovery migrations and API Workflow/Container bindings are delivered. All five
HelmReleases remain Ready on the preserved first node. Signed network evidence, real EU2 join
and new-region platform installation remain outstanding. The latest CI is green; fixed-port
regional test files now run serially with their original assertions.

API recovery now passes in Dev. Full restore recovered both confirmed markers in 82.531 s;
PITR recovered only the earlier marker in 65.562 s. After ordinary source deletion, another full
restore recovered both markers in 75.328 s from retained R2 data. All three targets have separate
PVCs, storage generation 2 and configuration revision 1, the correct SQL database mapping, a
nonsuperuser app role and no temporary administration Secret. The namespace quota and Barman
recovery-sidecar limits remain enforced. Earlier failed targets were deleted with the source
preserved before the final successful sequence. Node-loss recovery and regional installation
remain outstanding.

An isolated real Cloudflare Durable Object using the deployed DatabaseActor implementation and
real Dev D1 reads passed a two-attempt admission probe. The third registered-role attempt returned
53300 with zero D1 prepares; an unknown role returned 28P01 with zero D1 prepares. There were no
D1 writes, wake operations or lifecycle changes. This exercises the actual algorithm in a separate
namespace, not saturation of the main 12,000-attempt limit. The temporary Worker was deleted and
its absence verified. A fresh D1 export rehearsed the node-recovery migration locally: 31 tables
and 38,154 rows were preserved, including first-node identity, with clean integrity and foreign keys.

The operational failure/placement checks passed: a naturally 351.928-second-old report excluded
an otherwise physically Ready node from a new reservation; after the agent resumed, the same
pending database was placed and became Ready. A real Barman invalid-option failure appeared as
`failing` with the previous completed backup retained. Original archive configuration, agent and
Flux reconciliation were restored, fault Backup removed, and all recovery/stale trial namespaces
were deleted. The disposable integrator key was revoked. API capacity-policy response and private
rescue host-identity checks pass reproducing local tests and are deployed in Dev.

The EU capacity path now has two actual small databases on the first node and one unplaced request:
three 600-millicore reservations exceed the first node's 1,640-millicore headroom. An adoption of
the existing second VPS is audited, with purchases disabled and the two-node cap. The provider's
duplicate TCP/UDP display-name rejection is repaired with cosmetic wire labels; both firewall
assignments and exact rule readbacks now pass without changing the immutable security plan.
RAM rescue started, with strict verification of the pre-established host key and registered client
key. It reports one unmounted 161,061,273,600-byte disk, 8,326,418,432 bytes of RAM and no swap.
The first node's same-subnet peer /32 route was applied without reboot, preserving its identity
and readiness. The Talos image now includes the measured nonsecret early peer route while keeping
the provider's actual prefix. Its image hashes, GPT CRCs and installer digest are pinned; the
factory's published checksum service requires a paid tier, so these remain official-HTTPS
download measurements. The rescue root is an overlay with measured RAM-backed upper/work
directories, but its 832,643,072-byte `/run` cannot hold the 4,685,444,428 compressed/raw installer
bytes. Native portable-swap, overlay verification and operation-specific RAM scratch fixes pass
actual strict-SSH preflight. The isolated tmpfs measured 5,222,318,080 bytes with 5,222,313,984
bytes free; fresh setup, matching resume and pre-write guards passed before guarded unmount.
The corrected runtime is qualified, deployed and exactly bound in Cloudflare. The immutable
EU2 job is configured and has begun checkpointed image writes; join remains outstanding. Signed HTTPS source controls passed real
IPv4/NAT and direct IPv6 checks. Hosted runner assignment has recovered and current CI is green;
full 65,535-port IPv6 scans on both EU members and allowed-source management access passed.
The hosted IPv4 trials exposed masked control failures. Bounded diagnostics now retain the
control phase and safe timeout/status/socket reasons. Three actual HTTPS controls measured the
signed server clock 30/33/30 ms ahead of local receipt; control ordering now uses actual local
receipt after validating signed server freshness. A pinned control connection with fresh signed
heartbeats addresses the observed after-scan reconnection timeout. Focused regressions pass;
the combined proof passed in hosted run `37389964563`, with complete IPv4/IPv6 coverage,
attestation, actual access and current firewall readbacks. The proof was published and the native
job downloaded the exact 232,142,156-byte compressed image. Rescue has no `xz` executable;
Python 3.11.2 with its LZMA module is available. The job stopped before decompression or any disk
write. The portable xz/Python decoder passes 61 native tests; actual Python/LZMA decoding
produced the exact 4,453,302,272-byte RAW hash in RAM in 52.403 s with zero disk writes.
The decoder runtime is qualified and deployed with completed Cloudflare rollout and exact
instance image readback. Fresh full proofs resumed the same job through 536,870,912 acknowledged
disk bytes. Proof expiry paused it safely; every resume rechecked prior chunks through separate
connections. A single full-prefix comparison now preserves all-byte verification and passes 64
native tests plus actual 536,870,912-byte readback in 0.917 s with zero extra disk writes.
Its `bc04153d` runtime is qualified and delivered, with completed Cloudflare rollout and exact
instance image readback. The same job has acknowledged all 4,453,302,272 disk bytes, verified
every partition and GPT, and recorded the rescue reboot. Actual operator maintenance reads
confirm Talos 1.14.1, the exact disk and the intended peer route. The pinned client rejected
the original command-local `--insecure` flag before the subcommand; corrected ordering passes
all 65 native tests and is qualified and delivered from `da004fd6`, with exact registry and
Container image readback. The relay reaches genuine Talos port 50000 in 4 ms, while inactive
22/6443 time out despite the correct route and captured outbound resets. A narrow signed
maintenance observation and authoritative image/checkpoint binding preserve these outcomes
honestly; 17 API, 23 proof/hosted and five contract tests pass, with independent review.
This runtime is qualified and delivered with complete private-registry readback and exact live
instance image/completed rollout. Real relay observation and full dual-stack signed preparation
passed; the same job applied its configuration, confirmed authenticated reboot and joined
Kubernetes. EU2 is Ready under quarantine, with the unchanged first node and platform healthy.
A real 1 GiB allocation/reclamation restored all free space and measured 95 GiB total, but its
publication proof expired; no storage annotation was published. A fresh warm cycle is pending.
Native kubelet trust-map creation is unconfirmed: exact Linux Node child stdin reproduces
`/dev/stdin` reopening failure, while actual Dev server dry-run validates the manifest. Manifest
`-` and private regular patch-file corrections pass four reproducing regressions and all 65
native tests; the qualified correction is delivered and the exact trust map is read back.
Bootstrap is at `awaiting_verification`, revision 504. A warm 1 GiB allocation/reclamation cycle
completed and published actual 95 GiB in 124.433 s, with 178.9 s freshness headroom and all
trial resources removed. Unfiltered eight-second capture initially streamed 159,726,343 bytes,
99.67211% TCP 10250, exceeding the existing 32 MiB cap. Spooling before transfer preserves the
capture and cap: actual preflight measured 572,252 bytes, 498 encrypted peer packets, zero
plaintext Pod packets and zero kernel drops; all three kernel WireGuard projections passed.
The final collector's before-scan Node resource version rejects a harmless heartbeat update
with unchanged UID, labels, spec and capacity. A reproducing test and local observation-time
version binding pass 24 proof/hosted tests and independent review, retaining original scan
identity scopes and strict before/after capture plus native admission UID/version preconditions.
Fresh full verification passed in hosted run `37415715455`. Native admission released quarantine
at bootstrap revision 506; the addition reached Ready at revision 15 with the original EU2 Node
UID. All three actual capacity databases are Ready: two on EU1 and one on EU2. SQL over the normal
Cloudflare path verified their database identities and nonsuperuser application roles. The last
temporary capture Pod was removed and its absence verified. Expired preparation pauses progress
and fresh full outside proofs resume it. The unchanged first node, agent, both gateways and five
platform releases remain Ready. EU expansion is accepted; US installation and lost-worker recovery
are not yet accepted. The owner approved one automatic US1 purchase at a maximum of €20.09 gross
per month and €0 setup on 2026-10-06; the actual order and first-region installation remain pending.

The disposable EU2 recovery source has two confirmed commits, a completed real Barman base backup
and the post-commit WAL segment in the EU R2 archive. Both markers passed SQL readback. Its source
Cluster, PVC/PV and physical LV/volume-group identities were captured before the planned loss.
EU2 remains healthy; no failure intent, provider stop, loss record or source deletion has been
performed. The approved drill restores this source onto US1 after US admission. Cross-region
target selection and separate source archive access are implemented and locally checked:
contracts 148, API 379 and regional 417 tests pass, with package type checks. The source-read
credential map binds the exact original region, bucket and endpoint; target backups and temporary
administration retain the target's own credentials. API, Edge and the qualified regional image
are delivered; all existing bindings and secrets are preserved with only US archive/gateway
bindings added. Normal Cloudflare SQL still verifies all three capacity databases and both source
markers. Cross-region live acceptance remains pending.

US setup now has a default-jurisdiction archive with a North America location hint, separate
non-expiring bucket-scoped US write and EU read-only S3 credentials, a private Tunnel and a
hostname-based VPC HTTP gateway. The region's once-issued agent/route material is retained
privately. The original relay ConfigMap/deployment and first-node identity are preserved; its
new Pod/process epoch reports the same issuer and capabilities with EU and US targets allowed.
No provider order, US installation or EU2 failure action has been performed. A fresh public
one-month US quote shows €19.76 gross/month with 19% VAT and €0 setup; account billing country/VAT
remains unverified, so the purchase stays pending within the already-approved €20.09 gross cap.
The real US capacity path now has one owned pending database and one exact reserved addition.
Its one-node policy keeps purchases disabled; approval, dispatch and provider-instance fields
remain null. Actual provider inventory is unchanged, with zero US VPS and zero paid orders.
Independent local rescue key/custody preparation and the loss-drill helpers are reviewed and
checked; they require real provider/hardware and admitted US capacity before any failure action.
Local interruption checks confirmed helper descendants stop before releasing the live lock.
These preparations do not establish US installation or node-loss acceptance.

Operational Cloudflare, Barman R2 and PGCF admin/agent credentials have no configured expiry.
Routing/control tokens retain their short security deadlines. Read-only adopter inventory remains
private; ownership mapping, remaining extensions, peak connection rates and migration timing must
be verified before migration. Coordinated cluster credential rotation before Neon migration is
outstanding. Operator readiness remains incomplete; adopter migration and public release follow
separately.

On 2026-10-05 the owner approved native Rust for the regional gateway, controller, bootstrap relay
and node reclaimer, and Rust/Wasm for the Edge Worker. TypeScript remains the Cloudflare management
and orchestration language. This is the accepted target architecture; runtime migration and its
Dev acceptance are pending. The existing deployed TypeScript runtime and measured v1 acceptance
remain the current implementation. See the [Rust runtime and cold-start proposal](docs/architecture/rust-runtime-and-cold-starts.md).

This file is the canonical scope, architecture, roadmap and status. README.md summarizes it,
AGENTS.md is the contributor brief and THIRD_PARTY.md records component licenses. Detailed
architecture proposals live in `docs/architecture/`; measured phase results remain in this file.

## 1. Goal

An open-source, Neon-style serverless PostgreSQL service that anyone with a **Cloudflare account**
and **Contabo VPS** can run and scale horizontally:

- Databases are created, resized, suspended, restored and deleted through a versioned API.
- Every database is real, unmodified PostgreSQL (CloudNativePG on Talos/Kubernetes, local NVMe).
- All database traffic enters through Cloudflare. The VPS expose no PostgreSQL port.
- Databases sleep when idle and wake on the next connection.
- Every database is backed up to R2 continuously, with point-in-time recovery.
- Usage and the operator's own infrastructure cost are reported as **metrics**. The integrator
  (for example ohmyho.st) turns them into prices and credits. PGCF contains no pricing or wallets.
- Cloudflare places databases, watches capacity and adds Contabo VPS through the Contabo API.

First adopter: **ohmyho.st** replaces Neon with PGCF. Its provider adapter and commercial logic
live in the adopter repository. Customer databases and internal platform databases are both in
scope, first in Dev and then in production. US remains the default and EU remains selectable.

## 2. Principles

1. **Cloudflare is the control plane.** Workers (API, edge proxy), D1 (state), Durable Objects
   (per-region link, per-database lifecycle), Workflows (long operations), R2 (backups), Secrets
   and Containers (node bootstrap jobs). Nothing on a VPS is authoritative except the PostgreSQL
   data. Regional components execute desired state and report observations.
2. **Cloudflare is the only way in.** Clients connect to an edge Worker. The region keeps an
   outbound Cloudflare Tunnel. No inbound PostgreSQL port exists on any VPS.
3. **Real PostgreSQL.** Upstream PostgreSQL images managed by CloudNativePG, one CNPG Cluster per
   database, local LVM volumes, Barman Cloud to R2.
4. **Metrics, not money.** PGCF reports usage and its own cost. There is no budget enforcement:
   integrators call `suspend`/`resume`.
5. **Generic.** No adopter names, plans or defaults in code. Size classes and policies are
   installation configuration.
6. **Initial topology and recovery.** Retain the existing EU control-plane/relay VPS and exclude
   it from new customer database placement. The already-admitted EU worker becomes customer EU1
   and remains in that cluster. A matching V159 / Cloud VPS Plus 4 US control-plane/customer VPS
   starts the US region: 4 vCPU, 8 GiB RAM and 150 GiB NVMe. Preserve existing EU1 and validate
   source-preserving R2 recovery into US before customer migration. Do not reuse the superseded
   EU2 decommission/wipe drill. System and platform resources remain separately protected.
7. **Smallest thing that works end to end.** Add machinery only for an observed problem.
8. **Delete, don't park.** Unused code, files and branches are deleted. Git history is the archive.
9. **Real systems.** No mocks or hardcoded data in product code. A phase passes only through its
   live acceptance run in Dev.

## 3. Architecture

The diagrams are in [README.md](README.md#architecture). The component table and flows below
describe the current implementation. The owner-approved Rust target replaces the regional
gateway, agent/controller and bootstrap relay with native services, adds an isolated node
reclaimer, and moves the Edge Worker to Rust/Wasm. Management APIs, Durable Objects and Workflows
remain TypeScript. The [architecture proposal](docs/architecture/rust-runtime-and-cold-starts.md)
defines the warm route cache, direct Pod-IP/TLS path, configuration fingerprints and migration.

| Component                 | Runs on                              | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`                | Cloudflare Worker                    | `/v1` management API, API keys, D1 state. Durable Object `RegionLink` (one per region; holds the agent WebSocket); `DatabaseActor` (one per database; lifecycle, wake coalescing, idle timer, traffic counters) arrives in Phase 2. Workflows for restore and add-node arrive in Phase 3 and later. Phase 1 has neither `DatabaseActor` nor Workflows: an operation closes when the agent's observation arrives, and a cron marks stuck operations failed. Cron also covers usage rollups and capacity checks from their phases on. |
| `apps/edge`               | Cloudflare Worker                    | Data plane on **one endpoint hostname**, `db.<domain>`: PostgreSQL wire protocol over WebSocket. The approved path admits untrusted `database` and `user` URL hints against D1, signs a v2 routing token with mandatory `user`, and returns the unopened upstream WebSocket for native forwarding. Phase 1 routes only databases observed `ready`. `ensureAwake` through `DatabaseActor` is Phase 2. Records admission and upgrade events; the gateway measures stream bytes.                                                       |
| `apps/regional` `agent`   | Kubernetes Deployment (1 per region) | Holds an outbound WebSocket to `RegionLink` that only carries hints, and pulls full desired state (every 5 s while an operation is open, otherwise every 60 s, or immediately on a hint). Reconciles each database into Kubernetes resources (below) and reports observed state, node capacity and archive health. Hibernate/wake with safety checks and storage samples arrive in Phase 2.                                                                                                                                         |
| `apps/regional` `gateway` | Kubernetes Deployment (2 replicas)   | WebSocket-to-PostgreSQL bridge reached through the edge-to-region transport (section 6). Verifies the signed v2 token; handles SSL/GSS preludes, CancelRequest, startup parsing and the startup deadline; requires the actual StartupMessage database and user to match the token before dialing PostgreSQL. Negotiates TLS with the database's `-rw` Service (SSLRequest, then TLS with the CNPG CA), relays the raw stream, and measures bytes and connection events.                                                             |
| `cloudflared`             | Kubernetes Deployment (2 replicas)   | The region's outbound Cloudflare Tunnel; the only path from Cloudflare into the cluster.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/node-bootstrap`     | Cloudflare Container image           | Turns a Contabo VPS into a Talos node: rescue mode, verified Talos image, protected network, machine config, and worker join for an existing region or control-plane/worker bootstrap for a new region. Started by the add-node Workflow.                                                                                                                                                                                                                                                                                           |
| `packages/contracts`      | shared                               | zod schemas for the API, the agent protocol and the edge routing token.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Platform (Flux)           | Kubernetes                           | Cilium, OpenEBS LocalPV LVM, cert-manager, CloudNativePG, Barman Cloud plugin, cloudflared and the regional image, pinned in `infra/platform`.                                                                                                                                                                                                                                                                                                                                                                                      |

### Per-database Kubernetes resources (agent mapping)

- Namespace `pgcf-db-<id>` with PodSecurity `restricted`, a ResourceQuota, a default-deny
  NetworkPolicy and a `CiliumNetworkPolicy`. Ingress is allowed only from the gateway and the CNPG
  operator and plugin, plus the agent on authenticated readiness port 5432 and metrics port 9187; egress only to DNS, the Kubernetes API and the R2 host on 443 (the R2 rule
  needs an FQDN match, which plain NetworkPolicy cannot express).
- CNPG `Cluster`:
  - 1 instance, pinned PostgreSQL 18 image.
  - StorageClass `pgcf-lvm` with the size class storage.
  - Reserved mode requests the full class memory. The approved actual-RAM mode supplies an
    explicit PostgreSQL request (128 MiB in this installation) while retaining the assigned
    container limit. Barman has separate requests/limits. Actual mode requires fresh physical
    RAM and atomic transient startup admission; it is not enabled merely by lowering a request.
  - `nodeSelector` on the placed node; `enableSuperuserAccess: false`.
  - `initdb` database named after the database ID (the PostgreSQL database name equals the ID),
    owned by role `app`; additional roles via `managed.roles`.
  - PostgreSQL parameters derived from the size class.
  - Barman Cloud plugin as WAL archiver.
  - Sleep uses the CNPG hibernation annotation.
- Barman `ObjectStore` writing to `s3://<bucket>/<region>/<db-id>/g<storage-generation>-<opid>` on the region's R2
  endpoint (storage generation is 1 until a Phase 4 restore; `<opid>` is the operation that created
  that storage generation), plus a daily
  `ScheduledBackup`.
  EU backups use an EU-jurisdiction bucket and EU endpoint. US backups use a separate bucket on
  the general endpoint with a North America location hint; a hint is not a jurisdiction guarantee.
- Credentials: generated in the API Worker, stored AES-GCM-encrypted in D1 (key in a Worker
  Secret), delivered in the agent's authenticated desired-state pull and written as Kubernetes
  Secrets.

### Flows

- **Create:** `POST /v1/databases`
  1. The API writes the database row (desired `running`, configuration revision 1) and an operation.
  2. Placement picks a node.
  3. `RegionLink` sends a hint, the agent pulls the desired state and creates the resources.
  4. The agent reports `ready` (cluster ready and continuous archiving working), and the operation
     completes.
- **Connect:**
  1. The client opens `GET /v2?database=<id>&user=<role>` on `wss://db.<domain>` with the Neon
     serverless driver (`Pool`/`Client`, WebSocket mode). Its `wsProxy` configuration supplies
     these URL-encoded hints from the connection settings. The connection URI remains
     `postgres://<role>:<password>@db.<domain>/<db-id>`. Customers must set
     `pipelineConnect=false`. `pgcf connect` for psql and migration tools is Phase 2.
  2. The edge treats the hints as untrusted, applies connection admission, and looks up the role
     and database in authoritative D1 state. Unknown roles and unknown, deleted or unavailable
     databases are refused before any gateway upgrade or PostgreSQL dial. Admission failures
     return a small failure-only `101` WebSocket carrying a PostgreSQL SQLSTATE error. Both hints
     are required; missing or invalid hints are refused, and the bare `/v2` endpoint is
     unsupported. Phase 2 inserts `DatabaseActor.ensureAwake()` here.
  3. It signs a v2 routing token binding the admitted database and user, opens the regional
     WebSocket through the transport seam (section 6), and returns that WebSocket unopened.
     Cloudflare forwards the stream natively; Edge does not accept it for a JavaScript relay.
  4. The gateway verifies the token and reads the actual PostgreSQL StartupMessage. Its database
     and user must exactly match the signed claims before any PostgreSQL dial. SSL/GSS preludes,
     CancelRequest, startup parsing and the startup deadline belong to the gateway.
  5. The gateway negotiates verified TLS to PostgreSQL and forwards the original startup and raw
     stream. SCRAM authentication runs end to end with PostgreSQL; uncertain writes are never
     replayed. Stream bytes and connection lifecycle measurements come from the gateway.
- **Sleep (Phase 2):**
  1. `DatabaseActor` uses gateway client-activity measurements and the size class
     `sleep_after_seconds` to ask the agent to hibernate after the idle window.
  2. The agent refuses if `pg_stat_activity` shows active backends or prepared transactions.
     Otherwise it runs `pg_switch_wal()`, waits for the archive, sets hibernation and reports.
  3. Open idle connections are closed. Clients reconnect, which wakes the database.
- **Wake (Phase 2):**
  1. `ensureAwake()` coalesces all waiters into one wake.
  2. `RegionLink` tells the agent to remove the hibernation annotation.
  3. The agent reports ready, and the waiters continue. The server-side wake timeout is 30 s.
- **Suspend/resume (Phase 2):** an integrator call sets desired `suspended`. The edge refuses new
  connections and the database is hibernated. `resume` reverses it.
- **Resize (Phase 2):** `PATCH` the size class. The agent patches resources and CNPG restarts the instance
  (one reconnect). Placement must still fit, otherwise the request is refused.
- **Delete:**
  1. The API sets desired `deleted` (an explicit tombstone; absence from a pull never deletes).
  2. The agent patches the PersistentVolume reclaim policy to `Delete`, because `pgcf-lvm` is
     `Retain`.
  3. It deletes the namespace, then waits until the PV and the `LVMVolume` are gone, so the logical
     volume is not leaked, and reports `deleted`. R2 objects follow the retention policy.
- **Restore (PITR, Phase 4):** `POST /v1/databases/{id}/restore` accepts `{mode:"full",name}` or
  `{mode:"pitr",name,target_time}`. It creates a separate target ID in the source's project and region,
  with storage generation g+1 and its own archive path; the source remains unchanged. Publish the
  target only after SQL, role and storage checks and removal of temporary restore administration.
  The caller then changes its connection explicitly. Configuration revision is separate.
- **Add node (Phase 3):**
  1. The cron sees region headroom below the threshold. Autoscaling must be enabled and within the
     caps for maximum nodes and maximum monthly spend.
  2. The `AddNode` Workflow orders a Contabo instance, or adopts an existing instance ID.
  3. The `node-bootstrap` Container installs Talos, applies peer-only network protection and
     ensures the encrypted Cilium overlay is configured before joining. It applies the worker
     configuration for an existing region or bootstraps a control-plane/worker for a new region.
  4. The agent sees the Node `Ready` and reports allocatable resources. The node becomes
     schedulable after network verification and system/platform reservations.

### Capacity and placement

A node's allocatable resources are Kubernetes allocatable values minus platform scheduling
requests; these are not measured continuous CPU consumption. The current implementation still
charges sleeping assignments for full class CPU and disk sizes. That behavior is rejected by the
owner and must change through the corrective plan: actual active/pending compute admission and
physical disk usage, with logical quotas and explicit safety headroom.

Reserved mode is the compatibility default and reserves full PostgreSQL and Barman memory.
The owner-approved actual-RAM mode uses the node's measured working set divided by physical
memory capacity, sampled once per minute. Ten consecutive fresh buckets produce the rolling
average; unknown/null/gapped or changed-UID observations never become zero utilization.
At **at least 76%**, the capacity path requests one additional server in the same region,
within configured node and standing cost-profile caps. During installation, existing nodes
continue accepting databases under fresh physical RAM, CPU and storage guards; there is no
additional utilization cutoff. Newly Ready capacity can serve customers immediately from a valid latest
physical sample without waiting ten minutes for its first averaging window. The average remains
unknown until complete, and 76% purchase decisions require all ten measured buckets.
The EU control/relay node uses a separate placement flag, preserving its platform scheduling and
management of existing databases.

Admin class assignments use 256 MiB increments; this installation's actual mode permits up to
4096 MiB per PostgreSQL container. A smaller explicit Kubernetes request permits intentional
steady-state overbooking. Create, restore, wake, resume and running resize atomically hold the
full target PostgreSQL limit plus Barman's limit during startup. Accepted ready/hibernated/deleted
observations and a later physical sample settle holds; uncertain starts have no timeout release.
Pending demand caused only by startup RAM or held starts waits below the 76% rolling purchase threshold.
The current implementation also has independent CPU/storage/empty-pool purchase paths. These
are not the approved ordinary76% RAM trigger and must be removed or explicitly separately
configured under the corrective plan; do not silently buy because of static class sums.

Changing placement mode or the PostgreSQL request requires either no assigned databases or the
entire assigned cohort confirmed manually suspended and hibernated at its current generation,
with owned succeeded suspend operations and no unsettled starts. Unplaced demand may remain.
The policy write checks that complete cohort atomically. Apply this configuration after harness cleanup and
before customer migration. Updating cost or node caps with the same request geometry is allowed.
D1 keeps projects/external IDs, database/class/node assignments, physical memory history and
startup holds. Use the guarded admin API; direct table edits bypass lifecycle guards.

Contabo contracts are monthly. Any scale-in follows the provider's term/cancellation rules.

### Scaling and adopter connection capacity

The public data plane keeps one hostname. Regional routing and additional nodes provide
horizontal capacity behind it; extra public hostnames are not required for Worker throughput.
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) specify no general
requests-per-second cap. A new connection needs D1 admission and routing; SQL on an admitted
stream does not query D1. Measure connection creation separately from SQL requests and respect
[D1 throughput limits](https://developers.cloudflare.com/d1/platform/limits/).

Admission keys combine database, role and normalized source network; a separate database-wide
counter bounds aggregate handshakes. A shared source address from cross-zone Workers never
creates one installation-wide connection bucket. The current Dev starting limits are 6,000
handshakes/minute for each combined key and 12,000/minute per database. The binding counters
apply per Cloudflare location and are eventually consistent, as described in the
[Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
They are configuration,
not a measured service throughput. The gateway budgets 192 MiB aggregate and 96 MiB per database,
including fragmented and control traffic, with 16 MiB reserved for healthy traffic. The settings
are `PGCF_GATEWAY_MEMORY_BYTES` and `PGCF_GATEWAY_DATABASE_MEMORY_BYTES`.

Integrators use bounded reusable pools and waiting queues. PGCF currently provides session
forwarding; it has no transaction pooler. Measure backend reuse, connection creation and actual
application compatibility before changing an adapter. Adopter-specific inventory and pool
settings belong in the adopter repository, not the generic platform plan.

The initial density decision must follow measured active-memory and storage capacity. An adopter
goal of 1,000 customers is not an assertion that the three initial VPS can host 1,000 simultaneously
active databases. The current Dev node has 6,799 MiB allocatable memory, a measured 1,878 MiB
platform reservation and a 1,152 MiB reservation for each small database including its sidecar.
RAM alone admits four reservations, but the measured 1,260-millicore platform CPU reserve leaves
only two 600-millicore small reservations. The atomic placement path now checks CPU too. Full migration inventory, connection rates and downtime measurements remain pending.

## 4. Data model and API v1

D1 tables:

- `api_keys`: scope `admin` or `integrator`; SHA-256 hash with pepper.
- `projects`: integrator grouping with an optional `external_id`.
- `size_classes`:
  - Resources: memory MiB, CPU millicores, storage GiB, max connections.
  - Policies: `sleep_after_seconds` (null = never), `archive_timeout_seconds`,
    `backup_retention_days`, enabled.
- `regions`: provider, provider region, gateway URL and optional gateway binding, backup bucket and
  endpoint, agent key hash and last-seen time, autoscale policy JSON. A region has no database
  domain; the single endpoint hostname is installation configuration and the region is routing
  data behind it.
- `nodes`: provider instance and product, monthly price and currency, status, allocatable
  resources, Kubernetes node name.
- `databases`:
  - Ownership and placement: project, region, node, name, size class, PostgreSQL major version.
  - State: desired and observed state, configuration revision (`generation`) and observed
    configuration revision (`observed_generation`), status message, timestamps. Storage generation
    is separate and remains 1 until Phase 4 restores.
- `roles`: encrypted password with key version; unique on `(database_id, name)`, which is the
  edge's routing index.
- `operations`: kind, subject, configuration revision, status, error, timestamps.
- `idempotency_keys`: API-key-scoped request hash, state, resulting resource ID and response status;
  never credential-bearing response bodies.
- `lifecycle_events`: created, ready, hibernated, woke, resized, suspended, deleted; each with
  node, size class and generation.
- `usage_hourly`: one row per database and hour.

Endpoints:

- Projects: `POST/GET/DELETE /v1/projects[/{id}]`.
- Databases:
  - `POST /v1/databases` (asynchronous; returns an operation), `GET /v1/databases[/{id}]`,
    `PATCH /v1/databases/{id}` (size class), `DELETE /v1/databases/{id}`.
  - `GET /v1/databases/{id}/archive` lists base backups and WAL in R2 through the Worker's R2
    binding.
  - `POST /v1/databases/{id}/suspend|resume|restore`.
- Roles: `GET|POST /v1/databases/{id}/roles`, `POST .../roles/{name}/reset-password` and
  `GET /v1/databases/{id}/roles/{name}/connection-uri`. The connection URI includes the password
  only for the `integrator` scope.
- Operations: `GET /v1/operations/{id}`.
- Metrics: `GET /v1/usage` and `GET /v1/costs` (section 5).
- API keys: `POST|GET /v1/api-keys` and `DELETE /v1/api-keys/{id}`. The bootstrap token creates the
  first `admin` key and works only while no admin key exists. API and agent credentials are returned
  once; idempotency replays neither reissue nor replace them.
- Admin: `GET /v1/size-classes`, `PUT /v1/size-classes/{id}`, `GET /v1/regions`,
  `POST /v1/regions`, `GET /v1/nodes` and `POST /v1/regions/{id}/nodes`.
- Agent: `/agent/v1/link` (WebSocket), `/agent/v1/desired` and `/agent/v1/observations`.

The OpenAPI document and the TypeScript client are generated from code: Hono with
`@hono/zod-openapi`. Writes accept an `Idempotency-Key`.

## 5. Metrics and cost tracking

Usage is reported per database per UTC hour (`GET /v1/usage?project_id|database_id&from&to&granularity=hour|day`):

| Metric                                                               | Source                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `provisioned_seconds`, `awake_seconds`                               | lifecycle events                                                 |
| `memory_mib_seconds`, `cpu_millicore_seconds`                        | size class × awake time; a separate reserved figure covers sleep |
| `storage_used_bytes_max`, `storage_allocated_bytes`                  | agent samples (hourly)                                           |
| `backup_bytes_max`                                                   | R2 listing of the database prefix (hourly)                       |
| `ingress_bytes`, `egress_bytes`, `connections`, `connection_seconds` | gateway stream counters and connection events; Phase 2 rollups   |

Rows can change until `final: true`, which is set two hours after the hour ends. Missing samples
are reported as gaps, never as zero.

`GET /v1/costs` shows the operator's own cost:

- Node cost per hour (the Contabo price recorded at purchase) is attributed to databases by their
  share of reserved memory.
- R2 storage cost covers backup bytes. Prices are installation config.
- Unreserved capacity appears as `idle_capacity_cost`.

The cost view answers "what does each database cost us" and shows utilization. Integrators keep
their own price lists and billing logic.

## 6. Security and isolation

- The VPS firewall denies inbound traffic by default. Operator and bootstrap addresses may reach
  the Talos API (TCP 50000) and Kubernetes API (TCP 6443) only. From Phase 3, exact peer-node
  addresses may additionally reach the required Kubernetes API, Talos (TCP 50000/50001), kubelet
  (TCP 10250), control-plane etcd ports and CNI ports. No cluster port becomes world reachable.
  Apply the peer allowlist before joining a node. Cilium 1.20.2 uses WireGuard transparent
  encryption for inter-node Pod traffic (`encryption.enabled: true`, `encryption.type: wireguard`),
  with UDP 51871 reachable only between peers; the VXLAN overlay and health paths are peer-only
  too. Configure encryption before join, then verify it before placing databases on the new node.
  Host control-plane traffic still uses its native TLS; Pod encryption is not a claim that all
  host traffic uses WireGuard. These are Phase 3 requirements, not deployed evidence.
  See [Cilium WireGuard](https://docs.cilium.io/en/stable/security/network/encryption-wireguard/),
  [Cilium firewall requirements](https://docs.cilium.io/en/stable/operations/system_requirements/#firewall-rules)
  and the [pinned Talos port constants](https://github.com/siderolabs/talos/blob/v1.14.1/pkg/machinery/constants/constants.go).
  Moving operator access behind the Tunnel or Access is a Phase 4 item.
- Database IDs are random 20-character strings (`^[a-z][a-z0-9]{19}$`, a letter first) and are
  also the PostgreSQL database name. There is no per-database hostname. The edge refuses unknown,
  deleted, suspended and not-ready databases and rate-limits connections per database.
- The edge admits URL hints against D1 before any gateway upgrade or PostgreSQL dial. Admission
  failures use a small failure-only `101` WebSocket carrying a PostgreSQL SQLSTATE error. The
  gateway parses the actual
  StartupMessage and rejects a database or user mismatch before a PostgreSQL dial. Startup
  protocol majors other than 3 and replication requests receive SQLSTATE `0A000`; a missing
  startup user receives `28000`. The gateway declines client SSL/GSS requests and silently closes
  CancelRequest connections without dialing PostgreSQL. Phase 2 adds the decoy SCRAM exchange.
- **Edge to gateway:**
  - A v2 HMAC-SHA256 routing token with a per-region key: database ID, mandatory user, connection
    ID, region, key ID, issued-at and expiry, with expiry minus issued-at ≤ 30 s. It is single use
    per gateway replica: each gateway keeps a connection-ID replay cache and rejects a reused
    token.
  - The gateway derives the target only from the admitted database ID, after the actual startup
    database and user exactly match the token. The token admits a route; PostgreSQL still
    authenticates the user's password through SCRAM.
  - The transport is chosen by a Phase 1 spike behind one seam, preferring the existing path with
    the fewest parts that keeps TLS to PostgreSQL: Workers VPC TCP (`vpc_networks` binding), else
    a Workers VPC HTTP service to the gateway, else a Tunnel hostname with the routing token.
    The selected Dev path is a VPC HTTP service with unopened native forwarding, measured at
    235 ms in the capability check. VPC TCP was rejected because its raw streams did not expose
    the required native WebSocket. Tunnel with signed routing remains the fallback. An Access
    service token on a public Tunnel hostname needs the owner's consent to a Zero Trust
    organization first.
- PostgreSQL:
  - Customer roles are non-superusers; superuser access is disabled.
  - `scram-sha-256`; extensions limited to the image allowlist.
  - TLS only (`hostnossl` is rejected); the gateway negotiates it itself.
  - Gateway Pods carry customer connections. The agent verifies desired role credentials through
    authenticated TLS readiness probes before reporting ready.
- Kubernetes: one namespace per database, default-deny NetworkPolicy plus a
  `CiliumNetworkPolicy`, hard LVM volume limits, CPU and memory limits, PodSecurity `restricted`.
  The agent has no `pods/exec` permission.
- Secrets:
  - Worker Secrets hold the API key pepper, the credential encryption keys, the region route
    master keys and the bootstrap token. Contabo API credentials and the encrypted Talos secrets
    bundle follow in Phase 3.
  - Workers reach R2 through bindings, so no R2 S3 credentials are stored in Workers. The S3
    credentials Barman needs exist only as Kubernetes Secrets in the region.
  - Nothing secret is committed, printed or placed in Image Factory schematics.
- **Wake before authentication:** in Phase 1 databases always run, so no connection wakes
  anything. From Phase 2 an unauthenticated client that knows a database ID and a role name could
  wake a sleeping database. That is bounded by unguessable IDs, the D1 role lookup before any wake,
  and per-database rate limits. The integrated idle fix counts activity only after `AuthenticationOk`
  and drains pre-auth sessions at quiescence. Live unauthenticated pings did not prevent sleep.
  Known-hint wake abuse
  still requires explicit measured admission protection. Unknown databases and roles use decoy
  SCRAM and return the same 28P01 error form as a wrong password; their timing is not equal. Edge-side
  SCRAM verification before a wake is a Phase 4 decision.

## 7. Phases

### Current operator-ready scope (owner decision, 2026-10-05)

Finish PGCF for our own Cloudflare account and two EU/one US VPS first. Neon migration and public
release are separate later steps. Retain the accepted core, first node, custody and platform;
do not rebuild them or repeat their unchanged acceptance suites.

Three implementation tracks run in parallel, with one serial Git lane and one serial live lane:

- Installation: private relay/Tunnel/VPC, complete Workflow/Container wiring, actual bootstrap
  inputs and signed network-evidence production; EU2 adoption and first-region platform setup.
- Recovery: API full restore/PITR into a separate target database, distinct physical storage
  generation, actual SQL/role/config verification before route publication, deleted-source
  retention and validated regional R2 binding selection.
- Operations: observation freshness in placement and allocation guards, explicit lost-node and
  recovery authority, pre-D1/wake admission for registered hints, real backup/disk health and
  short control-state/credential recovery and rotation procedures.

Completion requires the real EU capacity/adoption path and US first installation, database
lifecycle per region, PITR and deleted-source restore, one existing-resource node-loss recovery,
and targeted health/overload checks. Record recovery time and last recoverable transaction.

- Owner authorization (2026-10-06, “korrekt go”): purchase exactly one EU and one US-central
  Cloud VPS 8 through the Contabo API, product V155, one-month term, no optional add-ons:
  8 vCPU, 24 GB RAM, 300 GB SSD, 600 Mbit/s and three included snapshots. The verified quotes
  are €16.94 gross/month EU and €20.87 gross/month US, €37.81 combined, with €0 setup.
  This selection supersedes the previous V159/€20.09 US quote and approval hold.
- Replacement authorization (2026-10-06): the owner cancelled the two 300 GB SSD orders and
  explicitly requested one new EU1 and one US1 with 150 GB NVMe, 8 vCPU and 24 GB RAM.
  Fresh official shop quotes show €14.00/€17.25 net monthly and €16.66/€20.53 with displayed
  19% VAT, €37.19 combined and no setup fee; actual account tax remains to be verified.
  The public API hardware table still defaults V155 to 300 GB SSD, and the included NVMe
  selector has no numeric add-on ID. Do not guess an expansion add-on or substitute the
  4-vCPU/8-GB V159 model. Retire only the vendor-cancelled empty additions through guarded
  API cancellation; preserve old EU2 until replacement and recovery acceptance.
- Capacity additions have standing owner authorization within the configured regional offer,
  exact cost profile and node/spend caps. No new per-server approval prompt is required.
  Uncertain responses must be reconciled using the original request UUID; never repeat an
  irreversible provider order to discover its outcome.
- Approved actual-RAM policy: sample each customer node's working-set bytes divided by its
  physical memory capacity each minute. Require ten consecutive fresh minute buckets and use
  their rolling average. The latest owner instruction sets **76%** as the proactive purchase
  trigger. This is the only utilization threshold. Continue placing databases on existing nodes while deployment runs,
  subject to the hard physical RAM/CPU/storage guards until replacement capacity is Ready. Missing samples, changed Node UID and MemoryPressure remain unknown/unsafe,
  never zero utilization. Fresh newly Ready capacity need not wait for ten minutes of average
  history before safe placement. Each triggering Node UID creates at most one regional addition.
- Admin RAM assignment uses 256 MiB increments. This installation permits PostgreSQL limits
  from 256 MiB through 4096 MiB; free/paid labels and customer entitlements belong to the adopter.
  D1 records the project external ID, database, size class, assigned RAM and placed node.
  Five 4 GiB database limits total 20 GiB, or 83.3% of 24 GiB; limits are not actual usage.
  PostgreSQL container limits prevent one database consuming the whole host. Barman and system
  consumption are separate. Safe concurrent-start admission and explicit smaller Kubernetes
  memory requests are required for intentional overbooking.
- Actual-RAM placement, standing approvals and the complete headless bootstrap producer are
  implemented and software/image checked. API/native delivery is complete; fresh-node live
  acceptance remains open. Live policies retain full reservations until explicit activation.
- The first EU order was dispatched once. Its exact CREATED audit matches the original request
  and selected region/product/image/hostname. Both initial instances first reported PENDING_PAYMENT
  with unallocated hardware. On the owner’s paid-continue instruction, actual reads confirmed both
  original instances Running with the exact purchased hardware; installation remains separate.
  Provider regression tests cover the complete pending-payment response: nullable audit trace
  ID, RAM/disk, network, MAC, location/name and host metadata, plus an empty product display name.
  The first delivered fix covered only trace/RAM/disk and did not resolve the receipt; one
  controlled restart reached provider readback without executing a purchase step. The complete
  correction retains unknown fields and requires allocated hardware before network/relay/install
  actions. The complete correction was delivered from `6912e835`, CI `37465032904`, and both
  original order receipts/audits are reconciled. The owner confirmed payment; provider allocation
  is verified. The exact invoice amount has not been read from the customer panel.
- Empty vendor-cancelled addition retirement is delivered from `9a1ae0c4`, CI `37497225836`.
  All 398 API tests passed; full CI and independent cancellation review passed. The current
  four firewall mappings, three rescue entries, US archive/transport bindings, ten required
  secrets and exact native `cf6d5d55` image/namespace are preserved. Fresh original provider
  receipts/audits/cancellation dates and zero target jobs/nodes were verified before one cancel
  call per region. All original ledger fields except status/slot/revision/update time remain
  byte-identical; both old EU Node UIDs, source readiness and encrypted regional custody remain
  unchanged. The EU original Workflow is errored; US is terminated. No provider infrastructure
  mutation, deletion or refund is claimed. Automatic expansion remains disabled in both live
  regional policies while the NVMe ordering path is unresolved.
- A fresh 74,178,541-byte Dev D1 export restored 31 tables and 98,738 rows. Migrations 0018–0021
  rehearsed locally with every pre-existing column/value fingerprint preserved, clean integrity
  and foreign keys, and compatibility-default reserved placement. A later fresh export preserved
  31 tables / 105,617 rows; all four migrations and the headless API/native runtime are now
  applied in Dev. Original identities, custody and reserved policies remain preserved.
- Latest rollout requirement (2026-10-06): use new 150 GB NVMe EU/US targets to accept the
  complete programmed Cloudflare purchase/install/join process with a qualified pinned image.
  Manual per-node bootstrap configuration and disk writes are on hold; no new installer job or
  target disk write has occurred. Hardware/host observations from the cancelled SSD pair must
  not be reused for the future NVMe replacements. Software release preparation, security-patch review, source/image
  qualification and the actual network/port/isolation checks are part of the programmed path.
  Installed Talos has no SSH daemon; rescue permits only the controlled registered-key path.
  The current host identities and uploaded user data are automatically imported into sealed
  bindings, rather than regenerated while the hosts are already in rescue.
- Current firewall pricing is free for every VPS/VDS, confirmed by the official
  [April 2026 launch](https://contabo.com/blog/contabo-firewall-is-here-free-with-every-vps-and-vds/),
  [current product documentation](https://docs.contabo.com/docs/products/cloud-vps/) and
  [firewall service page](https://contabo.com/en-us/firewall/). The older API introduction’s
  paid-add-on sentence is stale. Two owned empty, unattached definitions were created once each
  and read back; no optional add-on order was submitted. Automatic instance metadata later shows
  included firewall ID 1501 on EU and firewall/location IDs 1501/2247 on US. ID 2247 is
  United States (Central); neither ID selects SSD or NVMe. Those observations are retained unchanged.
- Isolated implementation now enforces fresh physical startup headroom with full transient
  PostgreSQL/sidecar peak holds for create, restore, wake, resume and running resize. An accepted
  ready/hibernated/deleted observation plus a later current-UID memory sample settles a hold;
  failed-operation metadata and timeouts do not. Below-76 RAM/start queues do not purchase nodes.
  The existing below-threshold CPU/storage purchase path is an audited implementation gap;
  it is superseded by the corrective plan, not an approved hidden purchase trigger.
  Switching placement mode or PostgreSQL request geometry requires an empty assigned live cohort
  and no unsettled starts; unplaced pending demand may remain. Configure actual mode after
  harness cleanup and before customer migration. Existing class assignments must fit the configured
  quantum/maximum. Cost/node-cap changes with unchanged request geometry remain available.
- Protected installation profiles, per-node host identities, dynamic free-firewall definition
  allocation, inspection authentication, input composition, native physical inspection, measured
  storage publication and complete proof orchestration are merged and software/image checked.
  API/native delivery is complete; the new NVMe targets still need complete Dev acceptance.
- Reset-readiness audit (2026-10-06): native `cf6d5d55` is present locally with its exact source
  label and qualified private-registry readback; regional `ab678993` manifest/configuration and
  pinned Cilium/Flux assets are available over HTTPS. Both EU servers/nodes are Running/Ready;
  all three databases and both recovery markers are readable, with R2 base backups/WAL present
  for all three and original regional custody unchanged. EU1 hosts the sole control plane and
  sole bootstrap relay. This confirms reusable software and readable backups, not an accepted
  full-region restore or permission to destroy that bootstrap dependency immediately. Preserve
  independently retained etcd/cluster and database custody and verify an alternate bootstrap
  route before the owner resets EU1. New model compatibility and rebuild time require actual
  hardware checks and a live run; the current RAM-staged installer cannot fit a nominal 4 GiB VPS.
- Latest confirmed topology (2026-10-06): the original EU control server remains the
  Kubernetes/platform and bootstrap-relay host, with no new customer databases. The existing
  admitted EU worker (formerly EU2) is now customer EU1; its exact provider V159 hardware is
  the template for the once-purchased US1. Both have 4 vCPU, 8 GiB RAM and 150 GiB NVMe. Retain
  the control server and customer EU1 without reset, re-adoption, deletion or physical wipe.
  The US order is audited and allocated; installation/admission and source-preserving recovery
  remain required. Preserve owned test archives/data until reviewed harness cleanup.

Use regression tests for changes, scoped package checks and one composed CI; repeat old live
checks only when their behavior changed. No additional cold-start optimization or twenty-start
series is required. Current approximately nine-second starts are accepted for v1.

Before customer data, document measured capacity and visible metric gaps; do not promise the
initial three VPS can host 1,000 simultaneously active databases. Cost attribution is deferred;
commercial RAM/storage prices, wallets and billing remain with the adopter.

There is no PGCF SaaS account. A self-hoster supplies Cloudflare/Contabo accounts, installs the
Cloudflare components and uses the images for the regional/native components. Public signing,
release/version polish, a convenient install CLI, detailed API publication and a blank foreign
Cloudflare-account installation proof belong to the later public-release gate.

The historical phases below preserve the implementation roadmap. Their migration, public-release,
density/performance and week-long adopter checks are not extra prerequisites for the initially
customer-free operator deployment. Phase results and measured numbers remain in section 11.

### Phase 0 — Reset

1. **Completed:** the old implementation was removed in commit `77ac865` and the new TypeScript
   workspace was scaffolded. Do not repeat the removal command: it would delete the new workspace.

2. Remove completed implementation worktrees and branches; only `main` remains after integration.
   Keep any local recovery bundle outside tracked files.
3. Decommission the old Dev deployment after a complete inventory and the required approval.
   Operate only on inventory-bound PGCF Dev resources; remove obsolete Workers, D1 databases,
   backup prefixes and Worker Secrets according to that reviewed inventory.
   Preserve the regional backup bucket selected for the new installation.
4. Rebuild the lab Talos node from the repository recipes: Talos, Cilium, then the Flux platform.
   This removes the old controller, collectors, telemetry and adoption overlays, and proves the
   recipe on fresh infrastructure. The second VPS stays untouched for Phase 3.

Acceptance:

- `git ls-files` shows only the target layout (section 10).
- `git worktree list` and `git branch` show only `main`.
- No stale `pgcf-*` Dev resources remain.
- The fresh lab node is Ready and all five Flux releases are Ready.

### Phase 1 — One database through the whole chain

Build:

- `apps/api`: keys, projects, size classes, regions, databases, roles, operations, the archive
  endpoint, agent routes; D1 migrations; `RegionLink`; a cron that sweeps stuck operations. No
  `DatabaseActor` and no Workflows: databases always run.
- `apps/regional`: agent create/delete reconcile with Barman to R2 from creation, plus the
  gateway. `ready` requires `ContinuousArchiving=True`; if archiving stays failed for more than
  10 minutes, the agent reports `health.archiving=failing`, which `GET /v1/databases/{id}` shows.
  The agent has no `pods/exec`.
- Backup objects survive ordinary API deletion within retention; the acceptance harness
  explicitly purges its own trial archives. Complete retention enforcement and restore after
  source deletion are Phase 4 work.
- Once a database has been ready, a measured archive alarm does not revoke connections when
  its physical identity, current configuration, certificates and role authentication still pass.
  Report `ready` with `health.archiving=failing`. Initial creation still requires verified
  archiving; unavailable or invalid measurements never establish healthy status.
- `cloudflared` and the regional image in the Flux platform; public GHCR images.
- `apps/edge` on the single endpoint: D1 admission of URL hints, signed v2 database/user route,
  and unopened-WebSocket native forwarding. The gateway owns startup validation, preludes and
  the startup deadline. `CancelRequest` is not routed in Phase 1; the gateway closes it silently
  without a PostgreSQL dial.
- `scripts/e2e` (TypeScript).

Live acceptance (`scripts/e2e` against Dev):

1. Create a project and a `small` database through the API with an `Idempotency-Key`. Measure
   ready time.
2. Fetch the connection URI (`postgres://<role>:<password>@db.<domain>/<id>`; the password only
   for the `integrator` scope).
3. From a deployed test Worker using `@neondatabase/serverless` (`Pool`, WebSocket mode,
   `pipelineConnect=false`), run DDL, a transaction, a rollback and reads through
   `wss://db.<domain>/v2?database=<id>&user=<role>`. A wrong password, database ID and user are
   each refused. A StartupMessage database or user that differs from the admitted hints is
   rejected before a PostgreSQL dial.
4. Find the base backup and WAL objects in R2.
5. Delete the database. D1 shows `deleted`; the namespace, PVC, PV and `LVMVolume` are gone, the
   volume group's free space is back to its baseline and the edge refuses the ID.
6. A TCP port scan of every node address from a source outside the firewall allowlist finds no
   reachable port; from the operator address only the Talos (50000) and Kubernetes (6443) APIs
   answer. The cluster has no PostgreSQL listener, NodePort, LoadBalancer, `hostPort` or
   `hostNetwork`.
7. The credential expiry inventory lists the expiry date of every credential the run depends on,
   by variable name and without values.
8. Create and delete five databases with the agent killed mid-run: no released PV or `LVMVolume`
   remains. An empty, stale or failed pull never deletes anything and no generation decreases.

### Phase 2 — Serverless behavior and metrics

For v1, integrators keep platform databases and latency-sensitive applications running with
`sleep_after_seconds: null`, and choose longer idle windows for frequently used databases.
Where the application provides enough lead time, authenticated early wake belongs in the
adopter's application flow. A first-user-action target below one second must be measured in that
flow; it is not a subsecond cold-start guarantee. CNPG hibernation removes Pods and retains
volumes. The required Rust workstream adds a shared pool of prestarted unassigned compute,
configuration-aware assignment and verified routing. Per-database warm idle/reclaim is additional
and cannot satisfy the pool gate; it remains awake for metering. Shared tenant PostgreSQL processes
and process/VM snapshots remain separate later research.

Build:

- `DatabaseActor`: idle timer, coalesced wake, traffic counters.
- Agent hibernate/wake with safety checks; suspend/resume.
- `pgcf connect` local TCP bridge.
- Lifecycle event log, agent samples, hourly rollups, `/v1/usage`, `/v1/costs`.
- Manual resize.
- Decoy SCRAM for unknown databases and roles.

Live acceptance:

- The database hibernates after its idle window.
- Record p50/p95/max for 20 cold connects. The owner accepted the measured current startup
  times for v1 on 2026-10-05: p95 9.160 s in the completed series, with subsequent diagnostics
  at 8.645–9.772 s. The historical cold timer ends at connection completion; the warm diagnostic
  includes the first read, so their percentiles are not interchangeable. The approved Rust runtime
  workstream measures both endpoints explicitly; ≤8 s remains a future cold-connect target.
  Integrators must choose connection timeouts covering cold starts or use early wake/warm classes.
- 10 parallel connects to a sleeping database cause exactly one wake.
- Usage `awake_seconds` matches the lifecycle within 60 s per hour.
- Resource/consumption metrics retain explicit gaps. Cost attribution is deferred by the owner;
  commercial resource prices and billing remain solely in the adopter.
- Resize applies with one reconnect.
- psql works through `pgcf connect`.

### Phase 3 — Horizontal scaling across VPS

Build:

- Node inventory and placement.
- The `AddNode` Workflow: adopt an existing instance or order a new one.
- The `node-bootstrap` Container. It runs the verified rescue path: per-node Image Factory
  schematic with static network arguments, checksum-verified NoCloud raw image, GPT relocation,
  `apply-config` worker for an existing region, or bootstrap a control-plane/worker for a new region.
  The retained EU control/relay node is excluded from new customer placement; the US regional
  control-plane/customer node retains measured system/platform reservations.
- Before join, apply the peer-address firewall allowlist for API, Talos, kubelet, control-plane
  etcd and CNI traffic, and configure Cilium WireGuard Pod encryption. Keep the new node out of
  database placement until the encrypted inter-node path and network isolation are verified.
- Capacity cron with an autoscale policy and hard caps. The initial installation retains two
  EU nodes (control and admitted customer EU1); US initially permits one. Configure additional
  headroom and the V159 standing cost profile before enabling customer expansion.
- Owner clarification (2026-10-06): capacity expansion must run headless through
  `https://api.contabo.com/` after one-time account, offer and cost/node-cap configuration.
  The Cloudflare workflow must compose provider-bound bootstrap inputs and produce the required
  real network evidence, then install, admit capacity and place pending databases without a
  per-server operator handoff. Current per-intent approval and externally supplied bootstrap/
  verification inputs are remaining orchestration gaps; scriptable APIs alone are not proof
  of the complete headless path. This does not authorize purchases beyond existing cost/node caps.
- The current trigger checks resource reservations each minute: after trying pending placements,
  add capacity if a running database remains unplaced or no healthy node can admit the smallest
  enabled size class. CPU/RAM include Barman requests and exclude system/platform reserves;
  storage uses measured LVM capacity minus existing allocations. This historical implementation
  retains sleeping reservations and is superseded by the actual-use corrective plan.
  Stale node observations stop purchasing; active additions and node caps prevent
  another reservation. There is no sampled CPU-utilization percentage threshold in v1.
- Reconcile uncertain provider responses before retrying; a replay must never buy another node.
- Node caps count live nodes. Marking a node lost frees its slot for a replacement. A matching
  unexpired standing regional cost profile can authorize the replacement automatically; otherwise
  an exact costed approval is required. Reinstalling the same VPS requires no new purchase.

Live acceptance:

- Real database reservations exhaust EU headroom and the second existing VPS joins through the
  capacity path and API, with no manual console step.
- New databases are placed on it.
- Databases on both nodes are reachable.
- Inter-node Pod traffic between the two EU nodes is proven encrypted on the public network;
  WireGuard peers and handshake health match the inventory. An outside-allowlist IPv4/IPv6 scan
  proves that joining added no world-reachable cluster port.
- An autoscale dry run logs the decision.
- A pending US database with no allocatable capacity triggers a real US VPS order and the full
  install/bootstrap path, after the owner's costed go. Interrupt and resume without a duplicate order.

### Phase 4 — Operator readiness and subsequent adopter migration

- PITR restore through the API, retention enforcement, backup freshness checks.
- Health reporting and alerting through Cloudflare: WAL archive age, disk usage, failed backups,
  node down.
- Production uses the initial two-EU/one-US topology. Keep etcd snapshots, regular D1 exports to
  R2 and documented recovery of Worker Secrets and regional infrastructure.
- Restore creates a separate target and storage generation; configuration revision and storage
  generation are distinct. Verify the target before the adopter changes its active connection.
- Isolation tests: cross-tenant network and SQL, disk-full containment, CPU noisy neighbor.
- Credential and API key rotation.
- Reserved placement remains the compatibility default. The owner-approved actual-RAM mode
  uses explicit startup memory requests, per-database limits and concurrent-start admission;
  CPU and storage guards remain enforced. Automatic relocation is later work.
- Bound registered-hint admission before D1/wake. Edge-side SCRAM before wake is later work.
- Qualify deployment images and the changed security boundaries; public signing is Phase 5.

Second step, after operator product acceptance:

- OMH Dev on PGCF (adapter in the OMH repository) for one week, then migrate customer and internal
  platform databases during a maintenance window: stop writes, dump/restore, compare data and roles,
  verify the target, switch connections, then reopen writes. Preserve US/EU and shared/isolated data
  scopes. Retire Neon only after successful verification; never switch back to an older source after
  the target has accepted writes.
- The provider adapter lives only in the adopter repository and replaces database and role
  provisioning, resize, suspend/resume, deletion, usage import and customer/platform connections
  with PGCF contracts. The MIT WebSocket driver may remain as a client library without a Neon
  service dependency.

Acceptance:

- PITR to a timestamp through the API, including after the source is deleted.
- Recover a database and its regional infrastructure from R2 after a node-loss exercise; record
  recovery time and the last recoverable transaction.
- OMH Dev stability belongs to the subsequent migration gate, not the customer-free product gate.

### Phase 5 — Open-source release

Build:

- An install path (`pgcf install` or a scripted guide): a Cloudflare account with a zone, plus
  Contabo API credentials, give a first region.
- Generated API reference and operator runbooks in `docs/operations/`.
- Versioned release metadata on main and signed public images pinned by digest; no extra Git refs.
- Reuse the new US VPS before production data for the fresh-account installation acceptance.
- Remove unused Neon code, credentials, connections and provider resources after verified cutover.

Acceptance: a fresh Cloudflare account and a fresh VPS reach Phase 1 acceptance by following only
the docs.

### Future node releases and patch management — owner requirement (2026-10-07)

Required for the overall goal under the current corrective plan: provisioning and ongoing upgrades must be
one deterministic, programmed lifecycle controlled by Cloudflare, with no AI agent required.
Bootstrap-image publication alone does not establish acceptance of VPS upgrades.

- Maintain one approved, immutable release manifest with pinned versions/digests for Talos,
  Kubernetes, platform services, PostgreSQL, backup components and configuration templates.
  Distinguish the Cloudflare bootstrap executable image from the Talos VPS operating-system image.
- Store desired release, observed versions/configuration hashes and rollout progress per node in
  Cloudflare. EU1 and US1 converge to the same approved customer-node release; the control/relay
  role follows the same release manifest with its role-specific components. Region, role, network
  and secrets remain explicit parameters, rather than undocumented server-specific changes.
- New VPS receive the current approved image and complete declarative desired state directly.
  Later configuration changes are incorporated into that desired state; do not replay an informal
  history of manual edits. Required schema/data migrations remain explicit, versioned steps.
- Upgrade existing nodes through supported Talos, Kubernetes and service upgrade mechanisms,
  preserving data volumes and database identities. Updating the bootstrap image does not reimage
  existing EU1/US1. Security patches require a qualified release and controlled rollout.
- Reconcile drift and apply updates through programmed controllers/workflows with persisted
  checkpoints, identity checks and safe interruption/resumption. Update nodes in a controlled
  order with capacity, backup and health checks; uncertain writes are resolved through readback.
  Temporary version skew is visible and bounded by the rollout, never an undocumented final state.

Acceptance: add a fresh node directly on the approved release, then upgrade existing EU1 and US1
to a subsequent release without data loss. Verify actual versions/configuration hashes, roles/TLS,
SQL, R2 backup/WAL and recovery; interrupt and resume an upgrade without unsafe replay. Record
convergence time, patch levels, any temporary skew and the verified recovery path in Status.
This lifecycle remains planned until these real Dev checks pass.

### Rust runtime and fast compute lifecycle — approved architecture (2026-10-05)

The owner selected Rust as the target for the regional server applications and the Edge data
path. Measurements validate the resulting implementation and latency; a CPU profile is not an
entry gate for this architecture choice. The detailed design is in
[docs/architecture/rust-runtime-and-cold-starts.md](docs/architecture/rust-runtime-and-cold-starts.md).

Implement in this order, with separate binaries/images in a shared Rust workspace.
The shared prestarted compute pool is a mandatory part of this workstream. First prove and
implement the actual runtime/storage late-binding boundary for CNPG and local volumes; do not
substitute image caching or per-database warm reclaim if that integration is difficult.
Cloudflare owns bounded regional ready-slot inventory, release compatibility, exclusive assignment,
refill/retirement and observations; pooled idle resources count as real platform use.

1. Replace the regional gateway while preserving routing, PostgreSQL/TLS, bounded streams,
   authenticated activity, quiescence and persistent fence contracts.
2. Replace the regional controller and bootstrap relay. Use targeted desired-state pulls,
   serialized per-database reconciliation, wake-priority queues, Kubernetes watches and immediate
   database observations; implement shared unassigned compute preparation, exclusive assignment
   and replenishment. Collect inventories, backup statistics and usage independently.
3. Publish verified versioned Pod-IP routes with separate TLS identities. Cache them in the
   gateway, bind admission to route revisions, and avoid configuration reapplication when its
   fingerprint and runtime identity are unchanged. A new Pod receives fresh runtime verification.
4. Move the full Edge Worker to Rust/Wasm while preserving Durable Object bindings, VPC HTTP and
   unopened native WebSocket forwarding. Versioned Actor snapshots and mutation barriers keep D1
   authority while shortening warm admission.
5. Prove shared-pool activation of at least two hibernated databases, with slots prepared before
   their requests, data/tenant isolation, fresh configuration, refill, interruption and pool misses.
6. Additionally add a scoped Rust node reclaimer and test `warm_reclaim` on an isolated accepted Dev worker
   using encrypted Talos swap/zswap. PostgreSQL, CNPG probes and Barman continue running. Explicit
   suspend still requires resume. Apply the newly approved actual-use model: cold-hibernated
   databases release compute accounting; warm-idle Pods retain honest live demand. Logical storage
   quotas must not become blanket physical allocations.
7. Separately develop proxy-side SCRAM, snapshot/freezing research and native CLI connection reuse.

Keep one controller during handoff, preserve persisted execution state and Secrets, and delete
replaced TypeScript code after successful Dev acceptance. Initial SCRAM remains end to end;
proxy authentication requires its own versioned credential contract. Partial database observations
must preserve complete node/orphan inventory; ready notifications follow guarded D1 acceptance.

Acceptance covers actual Dev SQL, transactions, COPY, role and Pod changes, watch loss, restarts,
fences and hibernation in the existing single CI/Dev workflow. Measure connection completion and
first successful read separately. Shared-pool acceptance uses twenty independent five-minute-idle
activations and separate thirty-/120-minute soaks, with actual unassigned runtime ready before
requests and no running per-DB compute. A pool-hit first successful read must be below one second.
Already-warm/reclaim and pool-miss/on-demand series are separate; they cannot substitute for the
pool gate. Historical v1 timings are not acceptance of this unimplemented target.

### Later

Density tuning/additional classes/sleeping factors,
maximum-throughput stress matrices, an additional pooler, cost attribution and scheduled rotation.
Public release polish and blank foreign-account installation acceptance follow operator readiness.

Later, extend backups and replication so that losing a server does not lose acknowledged transactions.
Relocation of sleeping databases, branching, other VPS providers, an HTTP SQL endpoint, PostgREST,
a Studio workbench.

## 8. Known facts from the lab (2026-09-27 to 2026-10-01)

**Hardware:**

- Two Contabo Cloud VPS Plus 4 (4 vCPU, 8 GiB RAM, ~150 GB disk, EU 2, €13.07/month each).
- No nested virtualization.
- No custom-image storage in the account. Talos was installed with Contabo rescue mode and `dd`
  of a checksum-verified Image Factory NoCloud raw image, followed by backup-GPT relocation. Static
  network kernel arguments are needed (`net.ifnames=0`, `eth0`).

**Versions that worked together:**

- Talos 1.14.1, Kubernetes 1.36.3, Cilium 1.20.2.
- OpenEBS 4.6.1 (LocalPV LVM 1.10.1 only), cert-manager 1.21.2.
- CNPG 1.30.1 (chart 0.29.1), Barman Cloud plugin v0.15.0 (chart 0.8.0).
- Flux 2.9.5, PostgreSQL 18.4.

**Storage:**

- A raw partition holds the LVM volume group `pgcf`. StorageClass `pgcf-lvm` is thick, uses
  `WaitForFirstConsumer` and has `Retain`. Volume limits are hard.
- Cap the Talos EPHEMERAL volume before first provisioning.
- A WAL-full PANIC was recovered by online volume expansion without losing committed transactions.
  Failed archiving fills the disk, so alert on archive age and disk use.

**Backups:**

- Base backup, WAL archiving, full restore and PITR passed: CNPG plus Barman plugin to R2 at the
  EU endpoint `https://<account>.eu.r2.cloudflarestorage.com`, region `auto`.
- Every restore target needs its own archive path and `serverName`; reused names break restore
  (plugin issue #411).
- The plugin's `enabled: true` default matters.
- The lab sidecar used 128 MiB request / 512 MiB limit. Size it for 512 MiB databases.

**Images:** private GHCR packages forced `imagePullPolicy: Never` with Talos image import.
Publish public images instead.

**Cloudflare:**

- Workers VPC HTTP through the regional Tunnel is the accepted Dev transport, with native
  WebSocket forwarding. VPC TCP was rejected for this path because the tested interface exposes
  raw streams rather than a native WebSocket handoff. The gateway independently verifies
  PostgreSQL TLS; the public PostgreSQL port remains closed. Tunnel routing tokens are the fallback.
- Hyperdrive allows 25 configurations per account, so there is no Hyperdrive per database.
- D1 strings and rows are limited to 2 MB.
- Some tokens failed Wrangler D1 queries with error 7403 while REST and the dashboard worked.

**Tooling:**

- `@cloudflare/vitest-pool-workers` was replaced by `@cloudflare/vitest-plugin`; the workspace uses
  vitest 4.1.x with the plugin.
- Node 24 enters maintenance on 2026-10-20 and stays supported; images pin a Node 24 release by
  digest.

**Upstreams:**

- The public Neon repository is effectively dormant (last code change May 2026). Neon storage,
  proxy and NeonVM are not used.
- The Neon serverless driver (MIT) speaks PostgreSQL over WebSocket. Use `Pool`/`Client` mode with
  `pipelineConnect = false` for SCRAM; its documented default (`"password"`) pipelines the startup
  and only works with cleartext password authentication. Its HTTP `neon()` query mode needs Neon's proxy and is not
  supported.
- Xata OSS (Apache-2.0, CNPG-based) is active. Its SNI gateway is not needed in this design.

## 9. Decisions (owner-approved changes or a measured reason)

The runtime target was explicitly approved by the owner on 2026-10-05. Current deployed behavior
is distinguished from that target below; selecting Rust is not conditional on a profiling result.

| Topic               | Decision                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language            | Approved target: native Rust regional gateway/controller/relay/reclaimer and Rust/Wasm Edge; TypeScript API, Durable Objects and Workflows; CLI/provisioning initially Node; shared zod contracts with Rust conformance. Runtime migration pending. |
| API                 | Hono + `@hono/zod-openapi`; OpenAPI and client generated from code                                                                                                                |
| Region link         | Agent opens an outbound WebSocket to `RegionLink`, plus a 60 s full-state pull; desired state in D1 is the truth                                                                  |
| Endpoint            | One hostname, `db.<domain>` (Worker custom domain). No per-database or per-region hostnames, no wildcard DNS; the region is routing data in D1                                    |
| Routing             | Edge admits untrusted `database`/`user` URL hints against D1 and signs a v2 token with mandatory user; gateway requires the actual StartupMessage to match before PostgreSQL dial |
| Client protocol     | PostgreSQL over WebSocket (`GET /v2?database=<id>&user=<role>`) via native Edge forwarding with `pipelineConnect=false`; native tools through `pgcf connect` (Phase 2)            |
| Archive alarm       | Separate archive health from established database availability after current physical/configuration/role checks; initial creation remains gated                                   |
| Edge to region      | VPC HTTP service with unopened native WebSocket forwarding selected in Dev (235 ms capability check); VPC TCP raw streams rejected; signed Tunnel route remains fallback          |
| Desired state       | Deletion is an explicit tombstone; absence from a pull never deletes; generations only increase and the agent ignores older ones                                                  |
| Database topology   | One CNPG Cluster with 1 instance per database, namespace per database, pinned to a node                                                                                           |
| Sleep | Current: CNPG declarative hibernation. Required fast activation: shared prestarted unassigned compute pool with safe data binding. Warm reclaim is additional; explicit suspend stays gated. |
| Backups             | Barman Cloud plugin to R2; daily base backup, continuous WAL, retention per size class                                                                                            |
| Metering            | Hourly; derived from lifecycle events, samples and gateway stream counters; no per-minute billing                                                                                 |
| Budgets             | None in PGCF; integrators suspend and resume                                                                                                                                      |
| Compute autoscaling | None; manual resize by size class                                                                                                                                                 |
| Cluster             | One Talos/Kubernetes cluster per region                                                                                                                                           |
| Initial topology    | Two EU VPS (control plane + worker, plus worker) and one US VPS (control plane + worker); recovery from R2                                                                        |
| Tests               | Current: Workers vitest and regional `node:test`; Rust unit/conformance checks join the existing single CI as services migrate; `scripts/e2e` provides live Dev acceptance.         |

Open questions with defaults:

- **Wake time:** current v1 cold-connect latency is accepted. The Rust workstream measures
  connect and first read separately, targeting subsecond shared-pool-hit first reads;
  per-database warm reclaim is additional and cannot replace the shared-pool requirement.
- **`archive_timeout`:** default 300 s for the smallest class and 60 s for larger ones. R2 Class A
  operations scale with WAL segments.
- **Sleeping reservation factor:** 1.0 until Phase 4 measurement.
- **Production control plane:** one per region in the initial two-EU/one-US topology.

## 10. Working rules and repository layout

- Work phase by phase. Make the smallest change that moves the current phase.
- Test the logic you write: state machines, placement, metering math, token signing and resource
  mapping. Write the test first when fixing a bug.
- Run `scripts/e2e` against Dev for anything that touches infrastructure.
- One CI workflow: lint, typecheck, unit tests, image build.
- No per-change evidence documents, contracts or "held" work. Record phase results in section 11.
- No mocks, stubs or hardcoded data in product code. Never claim a phase passed without its live
  run.
- The repository is public. Never print or commit secrets, `.env*`, kubeconfigs or Talos configs.
- New paid resources (VPS, plans) and production writes need the owner's explicit, costed go.
- Repository documentation is written in English; owner discussions may be in German.
- Documentation lives in PLAN.md, README.md, AGENTS.md, THIRD_PARTY.md, the infra READMEs,
  `docs/operations/` runbooks and `docs/architecture/` proposals. Architecture proposals describe
  approved targets; phase results and measured numbers remain in section 11.

Current implementation layout (the approved Rust workspace/binaries follow the architecture proposal):

```text
apps/api              Cloudflare Worker: /v1 API, Durable Objects, Workflows, cron
apps/edge             current TypeScript Worker; approved target is full Rust/Wasm Edge
apps/regional         current Node image; regional services migrate to separate Rust binaries/images
apps/node-bootstrap   Cloudflare Container image: Contabo → Talos node bootstrap (Phase 3)
packages/contracts    shared zod schemas
scripts/ci            image qualification, scanner and registry CI helpers
scripts/e2e           live end-to-end acceptance
infra/talos           Talos patches and Contabo rescue install recipe
infra/platform        Flux platform baseline (pinned)
infra/backups         CNPG/Barman/R2 backup and restore reference
docs/architecture     approved architecture proposals, including Rust runtime and cold starts
docs/operations       operator installation, recovery and credential runbooks
```

## 11. Status

Only completed real runs establish phase acceptance. Local checks are identified separately.
Earlier failed attempts and corrections remain in Git history.

The current corrective batch remains unpublished. The retained fleet passed six actual
server dry-runs for RuntimeClass and admission-policy object shapes, with no persisted objects
or changed cluster identities. Local rendering of all five immutable charts confirms fifteen
workload image references and the separately configured Barman sidecar; four Flux controllers
and cloudflared now select the same architecture digests as the version lock. Twenty-four
affected bootstrap/release tests pass. Fifty-two image-input/qualification tests pass, including
the new relay/reclaimer contracts; a further regression removes duplicated Talos/Kubernetes/Helm
version constants from the qualifier. These are source and shape checks, not fast-start, thin
storage, image or fleet acceptance. Before release, the batch also corrects the observed two-node
activation dependency: every regional host must be prepared before the shared compute runtime
is activated, and PostgreSQL convergence applies to the current node. The complete physical,
CI and live gates below remain open.

The same unpublished batch now wires bounded official update discovery and administrator policy/
candidate routes into the existing API and Cron; eighteen affected API/maintenance tests pass.
No policy is inserted or enabled automatically, and candidates remain explicitly awaiting an
actual qualification channel. The publication verifier now streams every compressed and expanded
registry layer before writing its receipt; seven focused corruption/identity/deadline cases pass.
A real stock Talos installer archive was inspected in5.087s:144,645,632 bytes,2 layers,1334 files
and1375 scan inputs, with the exact official base diffID. This establishes archive framing and
hash binding only. The composed PGCF installer/raw image still needs nested-payload scanning and
its own isolated boot proof. Production Node dependency audit reports0 advisories across89
dependencies; after removing the informational unmaintained PEM wrapper, OSV reports0 matches
across315 locked registry crates. The parser change passed22 actual TLS/CA/transport cases.
Neither dependency result establishes OS-image clearance, exposed-key rotation or full security
acceptance. No fleet mutation, order or customer migration was performed for this batch.

The final candidate targets Talos1.14.2 (kernel6.18.54, containerd2.3.6, runc1.5.2)
because the previously selected containerd2.3.5 is affected by CVE-2026-53493. Official
imager, installer-base and all three CLI downloads are digest-bound in the version lock.
The stock1.14.2 diagnostic scanned4888 inputs/10,373,878,998 payload bytes in320.085s;
104 detections were independently resolved to exact public upstream byte spans. The stock
maintenance boot passed in55.977s. Correcting the imager's double-counted boot geometry produced
a4,453,302,272-byte raw image/231,981,404-byte compressed image and a51.579s maintenance boot.
These stock measurements do not qualify the composed PGCF image. The final image must pass its
own complete-byte scan, extension/recipe identity and isolated boot before immutable publication.
The public-source scan's16 candidates are test fixtures/public checksums, not credentials.

Local common checks cover823 API,445 Regional,30 CLI,237 end-to-end utility and19 actual
Rust-Edge Workerd tests. The native Rust snapshot passed141 top-level tests plus its nested
Worker probe;2 physical-kernel tests remain separate. Stale orphan-inventory and Talos fixture
expectations were corrected in their affected suites rather than weakening runtime identity
checks. Final protected-volume drain and publication changes still require their affected checks
and the single final CI run. A fresh read-only fleet check on October9 confirms3 Ready nodes,
10 Ready Helm releases and all3 retained EU database identities, with0 provider calls/0 writes.
Migrations0031–0037 passed a2.322s local rehearsal on the real exported D1 baseline:
all269,730 existing rows across46 tables retain every old field and rowid; foreign-key and
integrity checks pass. Populated uncertain/acknowledged startup holds also pass the separate
D1 rebuild regression. The protected-volume drain now reserves physical writeback headroom
without inventing another tenant RAM allocation; it cannot authorize tenant Create/Start.
Its scoped30 D1,6 Native and17 Rust cases pass; actual US physical drain/delete remains open.
The retained official Talos1.14.2 and Kubernetes1.36.5 SBOMs pass full Sigstore verification
against their expected release signing identities in0.921s/1.036s, including default TUF trust
and transparency evidence. The verification binary was independently signature-verified before
execution. This closes those two SBOM provenance gaps, not platform-image or vulnerability review.
The prepared API bundle passes Wrangler4.145.0 dry-run without warnings (438.41KiB compressed);
all existing bindings are preserved and only the required PatchNode Workflow binding is added.
The publication transport passes19 interruption/identity/readback tests. Exact public receipts
are retained by the existing CI, and successful boot qualification/publication reports are
attested. The final source delta scanner examined28 changed/new files (822,555 bytes) with0
candidates. No installer/raw publication or fleet upgrade is inferred from these local checks.
Protected manual suspension also passes18 native Power cases and strict Clippy after reproducing
the absent-PostgreSQL failure. It requires current stop authority, positive hibernation, zero
Pods/sessions and exact retained volume/fence identity; local WAL and prior uncertain progress
remain, and archive completion is reported unknown. The normal Git secret guard identified the
same16 independently reviewed public/test values. Exact rule+file+value exceptions now clear only
those values; changed values, other paths and unrelated token rules still block. Image scanning
and the independent real-credential scan are unchanged.

The complete source review of386 changed paths identified conditional gateway lock-order and
retained thin-verifier findings, plus a reproduced wake-order defect with unresolved physical
security impact. Source corrections now preserve consistent routing lock order, validate protection
before wake, suppress stale protected startup grants and require verifier custody throughout
retained regional patch authority. Ordinary regression suites pass; the two refused dynamic
security validations were not retried or claimed successful. Independent correction review also
closed gateway-first/native command and Docker input omissions. All849 API cases now pass after
isolating historical migration fixtures;301 Native cases plus the final37-case deployment slice,
21 Power cases and31 ordinary Gateway cases pass. The pinned builder's four actual Rust notices
were read independently, and the qualifier's incorrect old paths were corrected with a red-to-green
regression. These remain local source checks pending the single final CI and live rollout.
CI37893083668 for sourceedf88d1 stopped before image jobs because its host Rust build lacked
`protoc`; lint, format and types had passed and no image was published. The correction pins the
matching official31.1 compiler/archive hashes and supplies its include path before compilation.
The actual Linux compiler parsed all14 vendored protocol inputs in an isolated, network-free
container. A fresh229,627,092-byte D1 export also passed the complete0031–0038 local rehearsal:
47 existing tables,298,794 rows and405 old columns/rowids unchanged, zero foreign-key violations,
integrityOK, approval/receipt bytes and original USReady job preserved. The failed CI is not
acceptance; the corrected source requires its own successful CI before delivery.
The runner review also reproduced one root-custody fixture mismatch: the unprivileged CI user
cannot replace root-owned host settings. The test now explicitly verifies that rejection while
retaining the full positive root refresh/Guard check. All17 sandbox library cases pass asUID1001,
the root positive case passes, and scoped Clippy/format pass; production custody checks are unchanged.

CI37904826489 for source1d8cc46 passed148 GNU Rust tests (the2 physical-kernel cases remain
in their separate lane), then stopped at strict Clippy because a procfs type cast was redundant
on GNU libc but required by the earlier musl expression. No image job ran or published artifacts.
The same batch corrects image selection after failed pushes: unpublished inputs must remain
selected until a successful full main-push CI covers them. A fresh read-only Cloudflare preflight
confirms all3 nodes,3 retained databases, roles, encrypted custody and the entire original admitted
US job are unchanged; D1 remains at30 migrations, autoscaleoff, with0 Contabo calls.
Private fingerprint comparison also distinguishes the October5 EU exposure from later US custody:
all9 US authority fingerprints differ. This is retained-custody evidence, not a fresh live trust
check or rotation acceptance. The shared EU control/customer cluster still requires the rehearsed
retirement of its disclosed authorities before customer migration.
The procfs comparison now widens both ABI types without narrowing; complete workspace/all-target
strict Clippy passes on GNU in2m24s and musl in1m28s, with no further ABI lint findings.
The failed-push selector regression reproduced8 incorrectly skipped artifacts. Its7 focused tests,
types, lint and format pass; an actual read-only GitHub lookup selects successfulCI37851000610
and all9 pending artifact profiles. An API-only change after a successful baseline still skips
unchanged images. Neither correction changes the live fleet.

| Date       | Phase                     | Result and measured limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-09 | Generic capacity correction — live removal and source | Removed the fixed cap through the existing API: EU/US max_nodes null in2.331s, every other policy field unchanged, autoscaleoff, provider0/purchases0. Revoked only the PGCF capacity sender token and the adopter's capacity receiver secret/recipient in7.968s; other settings/binding metadata and both shared Resend secret names remain. The inactive service binding is queued for removal with the next qualified API configuration. Configurable RAM threshold, optional warnings and generic purchase profiles are implemented but not deployed. Full shared Native suite301/301 passes; fullAPI run838/848 exposed two historical migration fixture conflicts and one postjoin fixture/authority mismatch, collected for one repair batch before CI. |
| 2026-10-09 | Live regional warning, delivery, dedupe and small ceiling | Both live regional max_nodes values are3. Exact OMH sourcef08b9cc0 passes all13 CI37860011792 jobs, applies only Dev schema179 and the existing Mail Gateway; ingress, minute schedule and previous secrets are preserved. PGCF697 activates one private Fetcher binding/secret in15.554s with all previous Native/bindings/3nodes/3retained databases/custody unchanged. Actual US1 RAM warning fired at77.2919%; later10 fresh consecutive samples,00:02:07–00:11:10Z, average80.0101% on the same physical NodeUID. Resend confirms delivered; actual identical service-binding replay200 retains one receipt/messageID and unchanged attempt/acceptance times. The3968MiB load had4096MiB limit/960s deadline; exact owned Namespace is absent, NodeReady unchanged, available RAM5,812,072,448B versus5,631,000,576B before. Subsequent00:35:41–00:37:42Z API tail197events/0Contabo attempts. First rejected tail collection is excluded. Purchases0, autoscaleoff until full release/templates pass, no customer migration. Cap-notice live mail awaits a genuine third allocation; no false threshold/recipient is synthesized. |
| 2026-10-09 | Uniform live RAM authority and preserved EU data | Both regional policies now use actual_ram,128MiB PostgreSQL request,4096MiB maximum and max_nodes3. Exact V159/one-month/no-add-on ram76 standing authority is recorded; monetary/order/expiry fields are null under the owner decision. Controlled EU suspend→policy→fresh-peak resume completed in135s; all3 retained databases are Ready, generation+2, same storage generations/roles/custody/application-table hashes, including2 original committed rows. Cloudflare SQL after transition894/899/820ms, TLS1.3, nonsuperuser, PostgreSQL18.6. Autoscaling stays off for the unaccepted template/full-release gate; Contabo0, purchases0, EU resets0. |
| 2026-10-09 | Actual256MiB entry-class SQL, R2 and physical deletion | One disposable US1 database used a CF-owned resource-profile revision with PostgreSQL256MiB/250m,1GiB logical disk and the unchanged Barman resource limits. Cloudflare first read10675ms after idle, TLS1.3/nonsuperuser/PostgreSQL18.6;2000 committed rows and50 queries over20000 generated rows each (p50123ms,p95203ms). R2 reports1 base backup/5 WAL objects/7,137,282bytes. Supported deletion succeeded and returned1,073,741,824 physical bytes; current VG free103,075,020,800bytes, thick allocation0. Automatic60s idle removed the Pod before cgroup peak measurement, so backup peak and lower scheduling requests are not qualified. This validates256MiB functionality on source697, not the unshipped Rust/thin fast-start release. Contabo0, purchases0. |
| 2026-10-09 | Corrective API/Regional delivery and live small ceiling | Source6978033 passes fullCI37851000610, including all3 image jobs. D1 migrations0024–0030 preserved all36 legacy table row hashes in the207,312,164-byte local export rehearsal; live migration/readback preserves3nodes,3EU databases, roles,6custody envelopes and originalUSReady/admitted authority. API publication/readback15.224s; Regional source-intent→Ready EU20.957s, US201.362s including one explicit server-rejected Flux CAS and operator resolution. Both run digest ee08af77e5d3adf875bc9bb4ef7fbc2d54fe0434d2af185cc6508c61d48571da; anonymous readback verified10layers/89,798,172 compressed bytes. Fresh SQL over Cloudflare passes all3 retained databases withTLS1.3/nonsuperuser/PostgreSQL18.6 in802/825/672ms. Both live caps are3; autoscale remainsoff, no new order, provider call, EU reset or customer migration. Notification source is deployed but recipient callback/mail acceptance remains pending. |
| 2026-10-09 | Thin-storage prerequisites, US-only module | Fresh US1 is empty of customer DB/PVC/PV/LV allocations. One signed Talos no-reboot apply adds only dm_thin_pool; config revision1→2,8.454s intent-to-readback, unchangedNode/Cluster/DMI/boot and all30 original config/key documents, module dynamic/live. No LV/SC/PVC write or provider call. The pinned OpenEBS image lacks thin_check/thin_repair; a checksum/signature-pinned tools derivative passes local metadata smoke/corruption rejection but awaits CI/publication and real scratch lifecycle. This explicitly leaves a temporary US module configuration difference; thin customer placement remains unqualified. |
| 2026-10-09 | Native shared runtime boundary — actual isolated Linux | Official containerd2.3.5/runc1.5.2 proof prestarts2 tenant-free holders and genuine version3 TaskServices, assigns each once, then creates ordinary daemon TasksService tasks with separate late-bound data mounts/markers, shared assigned net/IPC/UTS, private child PID/mount and actual32MiB cgroup limits. Stop/task/metadata cleanup passed; disposable container removed, no fleet/provider write. Create+Start+duplicate-refusal observations4.954/2.455ms are assignment measurements, not SQL latency. CRI/CNI/CNPG, leased pool lifecycle and Cloudflare first-read acceptance remain open. |
| 2026-10-08 | Latest small VPS ceiling and infrastructure notifications | Owner adds maximum3 managed VPS per EU/US region, existing control/allocated lost servers included;75% actual regional RAM warning and cap notice go to the owner through the configured integration mail service. Hard occupancy includes unpaid reservations, notice counts assigned provider allocations; same-provider recovery does not add a VPS. A real-D1 regression reproduced a fourth purchase after one paid node became lost; canonical counting now blocks reservation and first dispatch. Generic bearer-authenticated Fetcher/HTTPS callbacks use stable event IDs, durable episodes,60s retry pacing and5s deadline; unknown RAM does not rearm warning,2xx means callback accepted only.27 affected PGCF tests pass. OMH owns the recipient/Resend integration with durable receipts; no address/provider key is hardcoded into PGCF. Neither alert deployment, real mail acceptance nor live max_nodes3 policy activation is yet claimed. |
| 2026-10-08 | Consolidated owner-policy/native implementation — local, not deployed | Threshold-only V159 authority with null ceilings/unknown prices is implemented through existing policy/approval storage; legacy rows/hashes survive migration0029. Regional RAM uses10 aligned fresh minutes/each member's stableUID; an empty/new/unaligned spare suppresses repeat orders. Reservation/grant/renewal/first dispatch share the same fresh SQL; one active addition, manual costed bootstrap and uncertain-result reads remain. Autoscale revocation and policy execution settings update atomically. Local723API/166contracts/80Edge/254Bootstrap/442Regional/30CLI/237other tests passed. Initial CI37842734589 stopped at2 old Edge fixtures missing currentNodeUID/CPU/freshness; reproduced locally, fixtures corrected, all80Edge checks passed. No image was published by that failed CI. A real Regional Docker build reproduced missing versions.lock COPY; corrected build passes. Native Rust1.99/libc0.2.190 workspace has10 ordinary tests plus2 actual Linux kernel checks; currentAMD64 artifact under local emulation bound an authenticated namespaceFD to the same preparedPID in32.653041ms including independent readbacks, privateIPC/UTS, zero capabilities/NoNewPrivs, second-claim refusal and destruction. This is not database latency or full pool acceptance. Signed-hex slot-ID acceptance and zero-byteSCM_RIGHTS descriptor leaks were reproduced and fixed. Changed-image selection prevents unchanged artifact rebuilds after a coherent final stand. No live policy, node reinstall, extra provider order or customer migration occurred. |
| 2026-10-08 | Owner policy supersedes finite-cap request | Owner explicitly confirmed: no additional limits are required; buy a V159 in a zone when it reaches76% actual RAM. Implement one-month150GiB NVMe/no-add-on regional expansion with no monetary/node/order/standing-expiry ceiling, while preserving optional adopter caps, one addition in flight, uncertain-write reconciliation and all hard placement/startup limits. Regional pressure uses10 aligned fresh consecutive minutes of every eligible customer node, each retaining its own NodeUID; an old hot node plus a new empty spare cannot trigger an order loop. Prices remain unknown where the API supplies no quote; no fictitious zero or guaranteed invoice cap. Policy changes remain local pending final qualification and deployment. |
| 2026-10-08 | Contabo monetary-cap limitation — read-only provider research | Fresh official OpenAPI102paths and the downloaded schema agree: create-instance request has no maxPrice, expectedPrice, quoteId, offerId or currency; creation/readback do not supply actual invoice charges. The products/available endpoint quotes upgrades of an existing instance, not new purchases. Officialcntb sourcef45f76e574f3cfdae50d52a3e646f9563ec90030 directly submits the same model. V159 hardware is documented; current regional monthly price was not verified. Finite product/term/node/order limits remain enforceable locally, but configured prices are estimates rather than a provider-enforced invoice ceiling. No authenticated provider requests or orders occurred. Existing V159 permission remains. The subsequent threshold-only owner decision removes monetary limits from this installation; the API price-binding limitation remains documented rather than fabricated away. |
| 2026-10-08 | ULTRA implementation — local verification, not deployed | CPU requests/limits are separate; confirmed owned cold stops release CPU, while uncertain runtimes retain admission. Atomic create/resize/wake and NodeUID freshness regressions pass. API-only immutable resource profiles now support explicit fan-out through existing operations/cron, cold configuration without wake or CPU recharge, current-proof completion after role/wake changes, superseded outcomes and honest deferred status. Supported region URL/configuration CAS, encrypted target-scoped cross-region archive-read relationships and fleet release assignment/inventory are implemented. Full local API710, contracts164 and Regional442 tests pass, plus4 release-candidate tests; no live policy or purchase activation is inferred. Selected-release generation from versions.lock is candidate-only:10 pinned facts/47 unresolved fields, no fabricated approved release. One final CI/delivery batch remains pending. |
| 2026-10-08 | Fresh physical storage — retained fleet read only | New collector reached the existing OpenEBS1.10.1 driver through authenticated Kubernetes HTTPS on all3 retained servers; Node/Cluster/Pod/DaemonSet/volume-group identities remained stable. Each VG total103,075,020,800B. US1 free103,075,020,800B/thick0B; EU1 free97,706,311,680B/thick5,368,709,120B; control free92,337,602,560B/thick10,737,418,240B. All thin_pool:null and dm_thin_pool unloaded. Optional identity/freshness-bound observations and admin storage API are implemented with26 affected local tests. Zero provider calls, host writes or new workloads. Thick admission remains intact: the stock driver creates an initially quota-sized thin pool, has no automatic pool growth and may remove the final empty pool. Thin sizing/growth/exhaustion/reclaim and data-preserving conversion remain open. |
| 2026-10-08 | Shared compute boundary — isolated local proof only | Verified retainedV159 guests expose no /dev/kvm and no vmx/svm; Contabo excludes nested virtualization on VPS. An isolated ARM64 gVisor/PG17.10 experiment prestarted2 tenant-free Sentries, then late-bound2 independently stopped databases while preserving Sentry PIDs, distinct PostgreSQL system IDs and committed markers; other-tenant paths were absent. Slot creation166/168ms; request-to-first-read2790/2620ms, child start2091/2097ms. Exact disposable container removed; no host paths/devices/Docker socket, runtime network or fleet write. This misses the subsecond target and does not prove Cloudflare/CRI/CNPG integration. Stock gVisor network and per-container cgroup limitations remain; the native runc prepared-sandbox assignment direction is under implementation. Shared-pool acceptance and full Rust migration remain open. |
| 2026-10-08 | Overall completion withdrawn; corrective plan | Read-only audit confirms EU/US/Git Regional drift, different RAM policies, permanent sleeping CPU debit, thick5GiB allocations, inactive purchase policy despite owner permission, hidden below76% fallback orders, incomplete CF profile/region management, unresolved headless admission, absent patch lifecycle and unimplemented approved Rust/fast-start design. Existing SQL/TLS/R2/WAL/restore/physical-reclaim/RAM-trigger evidence remains valid but partial. Unified corrective plan defines all3-server convergence, CF-owned policy replication, measured resource allocation, purchase activation, patch/Rust/cold-start work and explicit live gates. No live change or purchase performed for this planning request. |
| 2026-10-08 | Partial operator/database acceptance | Original US1 Ready via authorized operator postjoin/admission198.356s; programmed1GiB write/read/physical reclaim753.081s. EU/US Cloudflare SQL, TLS1.3/nonsuperuser,4 R2 base/exact-WAL checks and4×5GiB physical deletion passed (20GiB). EU SQL2187ms; separate EU restore108618ms and healthy-source EU→US restore87988ms incl observation pacing. All3 existingEU DBs/source markers/custody preserved. Actual US RAM10 consecutive minutes18:43:01–18:52:04Z79.9062%, stored trigger and continued eligible placement/hard startup checks passed; dry expansion disabled/no purchase. Successful3968MiB load cleanup recovered4,177,731,584B; first missing-minute window correctly refused and cleaned. API/Native2bf CI37778960682 retained; US-onlyRegional115 CI37815727563/digest1886 accepted; EUKube/runtime/templates unchanged. Initialmapping1OAuth+1GET; nonempty30min routinewindow390frames0provider attempts, lifetime total unknown. Automatic postjoin HTTP409/session renewal remains open for next genuine authorized purchase. Rotation/adopter WSS/deadlines/new-ID rebinding/finite purchase caps and22-US capacity are separate migration gates. |
| 2026-10-03 | 0 accepted                | Fresh first EU Talos/Kubernetes node, five Ready Flux releases, 95 GiB storage. Formal foundation checks passed; second EU node unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-10-04 | 1 accepted                | E0–E6 passed. Latest E0–E5 run: Ready 27,644 ms, cold SQL connection 486 ms, commit/rollback 46/49 ms, one base backup and four WAL objects; delete 53,128 ms and zero trial volumes/archives after harness cleanup. Five distinct create/delete ledgers and ten agent restarts passed. Real fault responses preserved storage and generations; a missing ready namespace reported recovery required rather than creating empty storage. The complete 65,535-port scans exposed only operator Talos/Kubernetes APIs and no Cloudflare-accessible port. The observed Kubernetes node publishes one IPv4 and no IPv6; the all-port result covers that IPv4. The separate earlier provider IPv6 refusal check passed; no new all-port IPv6 claim is made. Credential names and independently known expiry dates are inventoried privately.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-10-04 | 1 backup and availability | A real R2-only outage reproduced a committed marker unarchived for 1,002 s. The corrected persistent timer survived an agent restart and alarmed after 619,301 ms. The subsequent availability proof obtained two distinct failing observations under the active policy and a fresh read connection in 437.681 ms; lifting the exact policy drained WAL, preserved the marker and cleared the timer. Separate restore drill: maximum measured WAL-object delay 52,427 ms after COMMIT, restore verification 304,128 ms including operator pacing, committed markers present, rollback absent, exact 5 GiB reclaimed. These are individual measurements, not a zero-loss or full Phase 4 guarantee.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-10-04 | 1 transport and scale     | VPC TCP returned raw streams and could not supply the native WebSocket; VPC HTTP native forwarding passed in 235 ms, with the signed Tunnel path retained as fallback. Across 1,000 paired SELECTs, verified-TLS Kubernetes port-forward p95 was 29.093 ms and WebSocket p95 35.541 ms. 100 MiB/1 GiB COPY and SELECT integrity, 103.804 s slow reception and 600,002 ms idle passed. Fifty warmed sessions returned 7,403 exact parameterized SELECTs in 10,063.836 ms: 735.604 SQL/s, p95 75.368 ms, zero errors, all clients closed. Sustained ramps, connection-rate limits, backend density and the bottleneck remain unmeasured. The corrected actual local Actor/Edge probe counted zero D1 prepares for 1,000 unregistered IDs; the deployed endpoint refused all 1,000 hints and closed every socket in 41.275 s at concurrency 20. This does not establish a sustained connection-rate ceiling.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-10-04 | 1 client and isolation    | Deployed Workers clients passed bounded pool/backend reuse, default-text byte fidelity, prepared statements, transactions, authentication, startup mismatch rejection and isolation across two real databases/users, with zero outstanding leases after cleanup. Decoded binary assertions remain failed on direct TCP and WebSocket due to upstream parsing; no assertion was removed. D1/Tail secret canaries were absent. Actual failed API requests emitted a generated diagnostic ID and a bounded route-template log without plaintext credentials. Intermittent Tail correlation remains unresolved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-10-04 | 2 in progress             | Installable CLI passed 28 local checks and real psql commit/rollback plus 105,216,021 raw binary COPY bytes in 2,614.726 ms with control checksum equality. CPU placement, bounded metering and local lifecycle logic are implemented; full hibernation/wake, collector and cost acceptance remains pending.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-10-04 | 2 admission / density     | Deployed Actor admission, external Edge binding and immutable usage snapshots passed a fresh E0–E5: Ready 23,989 ms, cold connect 645 ms, commit/rollback 41/46 ms, one base backup and nine WAL objects; delete 35,140 ms, agent restarts at create/delete and complete cleanup. Stable node: 3,000 CPU millicores, 1,260 platform reserve, 6,799 MiB RAM and 1,878 MiB platform reserve; small fits twice by CPU and four times by RAM. On one real small database, sampled PSS maxima for PostgreSQL/Barman were 116.442/49.832 MiB idle, 127.419/49.832 MiB under 20 s paced read load and 131.351/173.293 MiB during a completed base backup, with no Pod restart. RSS sums double-count shared pages; these sampled PSS maxima exclude the sampler, while cgroup values include it. No smaller class, exact backup-only peak or 1,000-customer density is accepted from this workload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-10-04 | 2 local safety / metering | Real local PostgreSQL 18 proved transaction/prepared-work guards, exact closed-WAL acknowledgement, and gateway pipeline/transaction quiescence. The actual gateway replacement drill preserved the fence UID, loaded the persisted quiesce intent on the replacement, acknowledged release on both replicas and rejected stale begin on both. Readiness remained stable through two relists after correcting actual Kubernetes list-item metadata handling. A bounded one-minute metering cron is implemented and locally checked. A 1,000-DB local D1 fixture bounded metering to 600 submitted statements and the whole cron to 850. Uncomputed hours remain pending; missing samples stay null with named gaps. API/Actor lifecycle tests cover ten-waiter wake coalescing, exact observations, role changes, cancellations and timeout compensation. Real resize to 512 MiB/250 millicores completed in 28,046 ms with unchanged storage and data, one Pod replacement and idempotent replay; held-client reconnects were not counted. A fresh Dev database verified internal maintenance-role TLS, authentication and minimal grants, then complete trial cleanup passed. The manual shutdown/WAL/resume drill passed with preserved data and storage, but its 19,830 ms resume connection exceeds the ≤8 s target. Automatic idle/coalesced cold-wake acceptance, real collectors and infrastructure costs remain incomplete. |
| 2026-10-05 | Operator recovery | CI `37360915487` and the fully qualified regional `e9569169` image are delivered; agent/two gateways and five platform releases stayed Ready for 62.768 s on the unchanged first EU node. API full restore / PITR / restore after source deletion passed in 82.531 / 65.562 / 75.328 s. Targets retained separate volumes, storage generation 2, configuration revision 1, SQL identity and nonsuperuser app access; temporary administration was removed. An isolated real DO admission probe refused registered excess with 53300 and unknown role with 28P01 before D1, with no writes/wake/state change; probe deleted. Fresh D1 export plus local migration rehearsal preserved 31 tables / 38,154 rows with clean integrity and foreign keys. EU2, US, lost-worker recovery and final operational protection acceptance remain pending. |
| 2026-10-05 | Operator protection / EU expansion | Natural 351.928 s stale heartbeat excluded a physically Ready node; fresh observations placed the same pending database and it became Ready. A genuine Barman option rejection reported failing backup health while retaining the last completed backup; configuration and agent/Flux state restored, fault object and all recovery/stale namespaces removed, disposable API key revoked. Fresh migration rehearsal preserved 38,547 rows and three custody records; migration 0017 and capacity-policy/rescue-identity API fixes delivered. Live signed IPv4/NAT and direct IPv6 controls passed. EU has two real small reservations on EU1 and one pending demand; existing EU2 adoption audited under cap 2 with purchases disabled. Duplicate provider display-name rejection reproduced; cosmetic wire-label/readback fixes pass 44 tests. EU2 installation, dual-stack network proof, node-loss recovery and US remain unaccepted. Hosted CI/native runner jobs fail assignment during the reported GitHub Actions incident; US purchase approval pending. |
| 2026-10-06 | EU2 rescue / installation preparation | Management API `00619393`, Edge `b196fbaa` and regional `e9569169` are deployed; CI `37378985882` is green and hosted runner assignment has recovered. Native bootstrap `sha256:a46d6824c342f9068af103558981ca1b0a033fedd2ccf0822f80a3f70df5d8d4` is qualified from `00619393`: 711,899,012 bytes, 18 layers, zero unresolved findings and complete registry readback. Cosmetic firewall labels were applied with exact assignment/rule readback. EU2 RAM rescue passed strict known-host/client-key verification and measured one unmounted 161,061,273,600-byte disk, 8,326,418,432 bytes RAM and no swap; the disk is untouched. EU1 peer /32 routing was applied without reboot, preserving node identity, custody and readiness; a corresponding early Talos image route is measured and pinned. The RAM-backed rescue overlay has only 832,643,072 bytes in `/run` for 4,685,444,428 installer bytes; portable-swap, overlay and operation-specific RAM scratch fixes passed actual strict-SSH inspection, fresh setup, matching resume and pre-write guards. The isolated tmpfs measured 5,222,318,080 total / 5,222,313,984 free bytes and was removed with source/identity guards; disk writes remained zero. Corrected runtime qualification/delivery, fresh full outside scans/signed preparation, EU2 join, US installation, lost-worker recovery and coordinated cluster credential rotation before Neon migration remain outstanding. US purchase requires the pending costed approval. |
| 2026-10-06 | Native rescue runtime / network proof | Bootstrap source `269ca6c6` passes all 59 native tests and actual strict-SSH RAM staging/guard preflight. Qualified image `sha256:c4a0fc39989dcdee33854ce1dbfc2d60ae4e92a7bc1334f558f64bd05b1ed1f7` covers 711,909,770 bytes / 18 layers with zero unresolved findings; private-registry readback verified 161,610,900 compressed bytes. API and exact Container image/namespace binding are deployed, original secret names retained, CI `37384157373` green. EU2 immutable input is configured at checkpoint zero with zero downloaded/written bytes. Full 65,535-port IPv6 scans passed for both members; actual relay access passed all three management ports per member using bounded RAM-only rescue listeners, which were removed. Hosted IPv4 run `37384991932` failed with a masked scanner reason; reproducing tests pass for bounded diagnostic propagation. Combined signed preparation and installation remain pending. |
| 2026-10-06 | EU expansion accepted | API/native `cf6d5d55` delivered; full CI `37415049259` green. Qualified native image `sha256:1b9a38a4e43ba87ef997eab71ed6799a3c4377cca00485f842e693ebac371923`: 711,913,354 bytes / 18 layers, zero unresolved findings and 161,611,765 compressed bytes verified from the private registry; completed rollout and exact running instance readback. Real 1 GiB allocation/reclamation published 95 GiB on EU2 in 124.433 s and removed all trial storage. Full signed dual-stack proof passed in hosted run `37415715455`; native admission reached released revision 506 and addition Ready revision 15 with unchanged EU2 Node UID. Two real 600-millicore capacity databases run on EU1 and a third on EU2; all passed normal Cloudflare SQL identity and nonsuperuser role checks. Real unfiltered capture confirmed encrypted peer traffic, zero plaintext Pod traffic and zero kernel drops; the final capture Pod is absent. EU1 identity, three custody records, agent, two gateways and five platform releases remain healthy. The disposable EU2 recovery source has two confirmed commits, a completed R2 base backup and the post-commit WAL segment; source physical volume identities are retained. US purchase at at most €20.09 gross/month and €0 setup is owner-approved, but US installation and EU2-to-US1 loss recovery remain pending. |
| 2026-10-06 | Cross-region delivery / US control plane | Cross-region target selection and distinct source archive credentials are delivered from `ab678993`; full CI `37419289338` is green. Regional image `sha256:53f9aaafdbda2f776a3ba20691f01a6ed6376638f02dcf436332b5056f54f735` qualified 658,584,124 bytes / ten layers with zero unresolved findings; anonymous registry readback verified all layer/configuration identities and 89,764,233 compressed bytes. One Recreate agent and two gateways plus five platform releases stayed Ready for 69.78 s. Both EU Node UIDs, three database namespace/Cluster/PVC/PV/Secret identities and three EU encrypted custody records remained exact. Normal Cloudflare SQL verified all three placements and both disposable EU2 source markers. API/Edge publish preserved every existing binding/secret and added only US archive/gateway bindings. US has a real default-jurisdiction R2 archive with North America hint, separate bucket-scoped non-expiring US write/EU read credentials, private Tunnel/VPC and once-issued region custody. The retained first-node relay restarted under UID/version guards; its actual new epoch confirms the same issuer/capabilities and EU/US scope. Native bootstrap remains qualified `cf6d5d55`, exact application/namespace and completed rollout; currently inactive with zero instances, with running-image proof retained from EU2 admission. No US order or EU2 failure action occurred. Public one-month quote is €19.76 gross with 19% VAT / €0 setup; owner account VAT/country verification is pending within the approved €20.09 cap. US installation and EU2-to-US1 recovery remain unaccepted. |
| 2026-10-06 | Unpaid US capacity reservation | One actual owned US database request is pending; the normal capacity cron reserved exactly one node-addition intent under cap 1 with purchases disabled. Approval, dispatch request and provider-instance fields remain null; actual before/after Contabo inventory is unchanged, with zero US VPS and zero paid orders. Original invalid-name request was definitively rejected before allocation; one corrected schema-valid request returned 202 and its initial pending state was resolved through reads without a second create. Independent US rescue host keys and retained client custody passed local checks; generic SSH configuration removes EU-specific network commands. Local map assembly requires an actual unique paid provider receipt; full bootstrap additionally requires fresh strict physical rescue observations. The reviewed loss procedure binds this first US demand, exact qualified runtime and manual backup identities, preserves the original EU source baseline, resolves uncertain mutations through reads, and requires fresh actual final node readiness and physical storage reclamation. Local interruption checks stopped helper descendants before unlocking. No US order, rescue upload or EU2 failure action occurred; billing country/VAT verification and actual US installation/recovery remain pending. |
