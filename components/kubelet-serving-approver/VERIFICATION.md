# Bounded source qualification — 2026-09-28

Baseline: zero component tests. Exactly three top-level tests were added in `controller/certificatesigningrequest/enrollment_test.go`, with no subtests, parameter rows or copied upstream suites.

The first run retained upstream approval behavior, with only module/import naming and unused enrollment field wiring changed. All three failed for actual unauthorized approval:

- `TestEnrolledNodeRenewalRejectsForeignSAN`: initial issuance and renewal were approved, then a foreign IP SAN produced a third approval instead of retaining two.
- `TestRejectsUnenrolledRequester`: an unenrolled node received one approval instead of zero.
- `TestRejectsReplacedNodeEnrollment`: a recreated Node with a stale enrolled UID received one approval instead of zero.

RED elapsed 28.956 seconds. After the first implementation correction, the same three named cases passed; GREEN elapsed 5.736 seconds, with 0.072 seconds reported inside Go. The issuance/renewal workflow verifies both positive approvals through the same reconciler.

Independent review then identified an authority change during SubjectAccessReview and duplicate JSON-member acceptance. The existing `TestRejectsReplacedNodeEnrollment` workflow was expanded to reproduce one operator-authority transition during SAR: the Node is recreated and the enrollment document becomes ambiguous. The first two cases still passed, while that existing third case reported an unauthorized approval and duplicate-member acceptance. Review RED elapsed 5.316 seconds. The second combined correction added post-SAR uncached authorization fencing, context-aware conflict-safe approval and standard decoder-token duplicate detection. The same three cases then passed in 4.787 seconds, with 0.061 seconds inside Go. No third correction or additional independently reported test case was added.

Both runs used the official cached Go 1.26.0 Docker image pinned in `PROVENANCE.json`, with network disabled and checksum-verified local module dependencies. Dependency resolution completed separately under an absolute 180-second limit. Targeted tests used:

```sh
go test ./controller/certificatesigningrequest \
  -run '^Test(EnrolledNodeRenewalRejectsForeignSAN|RejectsUnenrolledRequester|RejectsReplacedNodeEnrollment)$' \
  -count=1 -v -timeout=9m30s
```

The runtime built successfully and `serve --help` confirmed the agreed enrollment flags in 22.307 seconds before the review correction. The final image build remains with the repository owner. This evidence covers the concrete enrollment failures, authority transition and issuance/renewal positive control. Other signature, subject, group, schema and fail-closed branches were implemented and inspected without expanding the test budget. No cluster calls, deployment, image publication or full repository gate were performed by this component task.
