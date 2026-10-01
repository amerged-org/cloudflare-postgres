// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { ExecutionBrokerJournal } from "./execution-broker-journal.ts";
import {
  checkBrokerConfiguration,
  deriveBrokerInitialization,
} from "./execution-broker-target.ts";
import { canonicalCohort } from "./node-cohort.ts";
import {
  hash,
  challengeFor,
  encoded,
  permitDuration,
} from "./node-delivery-protocol.ts";
import type { Claim } from "./types.ts";
import type { CapacityJournal } from "./capacity-journal.ts";
import type { CapacityRuntime } from "./capacity-types.ts";
import type {
  ProvisioningFunding,
  ProvisioningFundingBarrier,
} from "./provisioning-funding.ts";
import type { ControlClient } from "./control-client.ts";
import type {
  NodeDelivery,
  NodeDeliveryConfiguration,
  NodeDeliveryReceipt,
} from "./node-delivery.ts";
import type { PostgresExecutionRecipe } from "./execution-manifest.ts";

export interface ExecutionBrokerConfiguration {
  version: 1;
  journalDirectory: string;
  delivery: NodeDeliveryConfiguration;
  recipe: PostgresExecutionRecipe;
  runtimeImageId: string;
  publicKeyPin: { version: 2; keyId: string; publicKey: string };
  publicKeyPinHash: string;
  guardUid: number;
  guardGid: number;
  inputs: { volumeName: string; mountPath: string; privateDirectory: string };
  ipc: { volumeName: string; mountPath: string; privateDirectory: string };
}
export interface ExecutionBrokerDependencies {
  configuration: ExecutionBrokerConfiguration;
  capacity: CapacityJournal;
  runtime: CapacityRuntime;
  funding: Pick<
    ProvisioningFundingBarrier,
    "assert" | "refresh" | "dispatchAuthority"
  >;
  fundingIdentity: ProvisioningFunding;
  control: Pick<ControlClient, "executionPermit">;
  delivery: NodeDelivery;
  authority: { check: () => void; expiresAt: () => number };
}
export interface ExecutionAttemptHint {
  nonce: string;
  containerId: string;
  attempt: number;
}
export interface ExecutionBrokerResult {
  outcome: "published" | "already_recorded";
  receipt: NodeDeliveryReceipt;
}
// Historical publication is not current execution or pre-birth admission proof.
export async function deliverInitialPostgres(
  supplied: { claim: Claim; podUid: string; attemptHint: ExecutionAttemptHint },
  suppliedDeps: ExecutionBrokerDependencies,
): Promise<ExecutionBrokerResult> {
  const input = structuredClone(supplied),
    deps = {
      ...suppliedDeps,
      configuration: structuredClone(suppliedDeps.configuration),
      fundingIdentity: structuredClone(suppliedDeps.fundingIdentity),
    };
  let journal: ExecutionBrokerJournal | undefined,
    key: string | undefined,
    ownedDispatch = false;
  try {
    checkBrokerConfiguration(deps);
    const check = () => {
      deps.authority.check();
      deps.funding.assert();
      const state = deps.capacity.snapshot();
      if (
        !["materializing", "active"].includes(state.phase) ||
        Date.now() >=
          Math.min(
            deps.authority.expiresAt(),
            deps.funding.dispatchAuthority().expiresAt(),
          )
      )
        throw new Error("execution_broker_not_authorized");
    };
    check();
    await deps.funding.refresh();
    check();
    const init = await deriveBrokerInitialization(input, deps, randomUUID());
    check();
    const snapshot = deps.capacity.snapshot();
    journal = new ExecutionBrokerJournal(
      deps.configuration.journalDirectory,
      input.claim.operationId,
      {
        version: 1,
        capacityPlanHash: hash(canonicalCohort(snapshot.plan)),
        organizationId: deps.fundingIdentity.organizationId,
        projectId: deps.fundingIdentity.projectId,
        configurationHash: hash(
          canonicalCohort({
            ...deps.configuration,
            journalDirectory: undefined,
          }),
        ),
        operationId: input.claim.operationId,
        environmentId: input.claim.environmentId,
        specHash: input.claim.specHash,
        regionId: input.claim.regionId,
      },
      input.claim.leaseEpoch,
      deps.configuration.delivery,
    );
    const row = journal.prepare(init);
    key = row.key;
    if (row.phase === "published") {
      check();
      return { outcome: "already_recorded", receipt: row.receipt! };
    }
    if (row.phase !== "prepared")
      throw new Error(
        row.phase === "uncertain"
          ? "execution_broker_publication_uncertain"
          : "execution_broker_in_progress_or_blocked",
      );
    journal.advance(key, "prepared", "dispatching");
    ownedDispatch = true;
    const currentInit = row.init,
      currentKey = key;
    const revalidate = async (signal: AbortSignal) => {
      signal.throwIfAborted();
      check();
      await deps.funding.refresh();
      check();
      const current = await deriveBrokerInitialization(
        input,
        deps,
        currentInit.requestId,
      );
      check();
      signal.throwIfAborted();
      if (canonicalCohort(current) !== canonicalCohort(currentInit))
        throw new Error("execution_broker_target_changed");
      const phase = journal!.read(currentKey)?.phase;
      if (
        !phase ||
        ["blocked", "uncertain", "published", "prepared"].includes(phase)
      )
        throw new Error("execution_broker_dispatch_blocked");
    };
    const result = await deps.delivery.deliver(currentInit, {
      check,
      expiresAt: () =>
        Math.min(
          deps.authority.expiresAt(),
          deps.funding.dispatchAuthority().expiresAt(),
        ),
      revalidate,
      issue: async (challenge, signal) => {
        await revalidate(signal);
        check();
        if (encoded(challenge) !== encoded(challengeFor(currentInit)))
          throw new Error("execution_broker_challenge_conflict");
        journal!.advance(currentKey, "dispatching", "issuing");
        const response = await deps.control.executionPermit(
          input.claim,
          deps.fundingIdentity.reservation.id,
          challenge,
          signal,
        );
        check();
        signal.throwIfAborted();
        if (
          response.runtimeEnforced !== false ||
          response.enforcementStatus !== "pending_runtime"
        )
          throw new Error("execution_broker_issuer_contract_changed");
        const permit = structuredClone(response.permit);
        permitDuration(permit, currentInit);
        journal!.advance(currentKey, "issuing", "issued", permit);
        // Durable intent before relinquishing exact bytes to a possibly uncertain send.
        journal!.advance(currentKey, "issued", "publishing");
        check();
        return permit;
      },
    });
    check();
    await revalidate(new AbortController().signal);
    check();
    const attempt = journal.read(currentKey);
    if (
      !attempt ||
      attempt.phase !== "publishing" ||
      result.receipt.challengeHash !==
        hash(JSON.stringify(challengeFor(currentInit))) ||
      result.receipt.permitHash !== attempt.permitHash ||
      result.receipt.self.installationId !== currentInit.scope.installationId ||
      result.receipt.self.regionId !== currentInit.scope.regionId ||
      result.receipt.self.nodeName !== currentInit.scope.nodeName
    )
      throw new Error("execution_broker_receipt_unproven");
    journal.advance(currentKey, "publishing", "published", result.receipt);
    check();
    return { outcome: "published", receipt: structuredClone(result.receipt) };
  } catch (error) {
    if (journal && key && ownedDispatch) {
      journal.hold(key);
      const current = journal.read(key);
      if (current?.phase === "uncertain")
        throw new Error("execution_broker_publication_uncertain");
    }
    if (error instanceof Error && /^execution_broker_/.test(error.message))
      throw error;
    throw new Error("execution_broker_unproven");
  } finally {
    journal?.close();
  }
}
