// SPDX-License-Identifier: Apache-2.0
import type { UsageIdentity } from "./metering-types.ts";
export interface ArchiveFile {
  kind: "journal" | "manifest" | "accepted";
  id: string;
  bytes: number;
  sha256: string;
  chunks: Array<{ bytes: number; sha256: string }>;
}
export interface ArchiveDescriptor {
  version: 1;
  identity: UsageIdentity;
  sessionId: string;
  capturedAt: string;
  files: ArchiveFile[];
}
export interface ArchiveReceipt {
  version: 1;
  descriptorId: string;
  descriptorSha256: string;
  identity: UsageIdentity;
  sessionId: string;
  capturedAt: string;
  files: Array<Omit<ArchiveFile, "chunks">>;
  chunkCount: number;
  keyId: string;
  completedAt: string;
}
export interface ArchiveTransport {
  prepare(
    descriptor: ArchiveDescriptor,
    signal?: AbortSignal,
  ): Promise<{
    descriptorId: string;
    descriptorSha256: string;
    descriptor: ArchiveDescriptor;
  }>;
  putChunk(
    id: string,
    ordinal: number,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{
    descriptorId: string;
    ordinal: number;
    bytes: number;
    sha256: string;
  }>;
  finalize(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ receipt: ArchiveReceipt; receiptSha256: string }>;
}
export interface ArchiveRecoveryTransport {
  recovery(
    id: string,
    expected: string,
    signal?: AbortSignal,
  ): Promise<{
    descriptor: ArchiveDescriptor;
    receipt: ArchiveReceipt;
    receiptSha256: string;
  }>;
  chunk(
    id: string,
    ordinal: number,
    expected: string,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
}
