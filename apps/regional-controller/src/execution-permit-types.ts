// SPDX-License-Identifier: Apache-2.0
// Current server contract: initial PostgreSQL execution only. Other container
// kinds require authoritative server-derived recipes before this can expand.
export interface ExecutionPermitChallenge {
  version: 2;
  nonce: string;
  binding: {
    installationId: string;
    namespaceUid: string;
    podUid: string;
    containerName: "postgres";
    nodeName: string;
    nodeUid: string;
    bootId: string;
    imageHash: string;
    commandHash: string;
  };
}
export interface SignedExecutionPermit {
  version: 2;
  keyId: string;
  payload: string;
  signature: string;
}
export interface ExecutionPermitResponse {
  permit: SignedExecutionPermit;
  runtimeEnforced: false;
  enforcementStatus: "pending_runtime";
}
