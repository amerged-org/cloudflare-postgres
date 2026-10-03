// SPDX-License-Identifier: Apache-2.0
import type { K8sObject } from "@pgcf/contracts";

export interface Resource extends K8sObject {
  metadata: K8sObject["metadata"] & {
    uid?: string;
    resourceVersion?: string;
    deletionTimestamp?: string | Date;
  };
}

export interface Kubernetes {
  read(
    kind: string,
    namespace: string | undefined,
    name: string,
  ): Promise<Resource | null>;
  list(
    kind: string,
    namespace?: string,
    labelSelector?: string,
  ): Promise<Resource[]>;
  create(resource: K8sObject): Promise<void>;
  apply(resource: K8sObject): Promise<void>;
  patch(
    kind: string,
    namespace: string | undefined,
    name: string,
    operations: unknown[],
  ): Promise<void>;
  delete(
    kind: string,
    namespace: string | undefined,
    name: string,
    uid: string,
  ): Promise<void>;
}

export type Log = (
  event: string,
  fields?: Record<string, string | number | boolean>,
) => void;

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function uid(resource: Resource): string {
  if (!resource.metadata.uid) throw new Error("resource_identity_missing");
  return resource.metadata.uid;
}
