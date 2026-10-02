// SPDX-License-Identifier: Apache-2.0
export function faultCycleReady(
  counts: Record<string, unknown>,
  responses: number,
): boolean {
  return (
    Number(counts.completed_responses) >= responses &&
    Number(counts.observations_after_response) >= responses
  );
}
export interface DatabaseProof {
  uid: string;
  accepted: number;
  completed: number;
  roles: string[];
}
export function preservedDatabase(
  before: DatabaseProof,
  after: DatabaseProof,
): boolean {
  return (
    before.uid === after.uid &&
    after.accepted >= before.accepted &&
    after.completed >= before.completed &&
    JSON.stringify([...before.roles].sort()) ===
      JSON.stringify([...after.roles].sort())
  );
}
