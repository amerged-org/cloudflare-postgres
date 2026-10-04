// SPDX-License-Identifier: Apache-2.0
import { Duplex } from "node:stream";

export const DEFAULT_MEMORY_LIMIT_BYTES = 192 * 1024 * 1024;
export const DEFAULT_DATABASE_MEMORY_LIMIT_BYTES = 96 * 1024 * 1024;

const BUFFER_OVERHEAD_BYTES = 256;
const MODERATE_MESSAGE_BYTES = 1024 * 1024;
const SMALL_MESSAGE_BYTES = 128 * 1024;
const SMALL_TRAFFIC_RESERVE_BYTES = 16 * 1024 * 1024;

export class GatewayMemoryBudget {
  readonly limit: number;
  readonly databaseLimit: number;
  readonly smallTrafficReserve: number;
  readonly databaseSmallTrafficReserve: number;
  used = 0;
  peak = 0;
  private readonly databases = new Map<string, number>();

  constructor(limit: number, databaseLimit: number) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(databaseLimit) ||
      databaseLimit < 1 ||
      databaseLimit > limit
    )
      throw new RangeError("invalid gateway memory limits");
    this.limit = limit;
    this.databaseLimit = databaseLimit;
    this.smallTrafficReserve = Math.min(
      SMALL_TRAFFIC_RESERVE_BYTES,
      Math.floor(limit / 8),
    );
    // Small installation limits must not increase the per-database reserve fraction.
    this.databaseSmallTrafficReserve = Math.floor(
      Math.min(
        (this.smallTrafficReserve * databaseLimit) / limit,
        (SMALL_TRAFFIC_RESERVE_BYTES * databaseLimit) /
          DEFAULT_MEMORY_LIMIT_BYTES,
      ),
    );
  }

  owner(database: string): MemoryOwner {
    return new MemoryOwner(this, database);
  }

  databaseUsed(database: string): number {
    return this.databases.get(database) ?? 0;
  }

  claim(database: string, bytes: number, large: boolean): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new RangeError("invalid memory reservation");
    const databaseUsed = this.databaseUsed(database);
    if (
      bytes >
        this.databaseLimit -
          databaseUsed -
          (large ? this.databaseSmallTrafficReserve : 0) ||
      bytes > this.limit - this.used - (large ? this.smallTrafficReserve : 0)
    )
      return false;
    this.used += bytes;
    this.peak = Math.max(this.peak, this.used);
    this.databases.set(database, databaseUsed + bytes);
    return true;
  }

  release(database: string, bytes: number): void {
    this.used -= bytes;
    const remaining = this.databaseUsed(database) - bytes;
    if (remaining === 0) this.databases.delete(database);
    else this.databases.set(database, remaining);
  }
}

export class MemoryOwner {
  private readonly leases = new Set<MemoryLease>();
  private closed = false;

  private readonly budget: GatewayMemoryBudget;
  private readonly database: string;

  constructor(budget: GatewayMemoryBudget, database: string) {
    this.budget = budget;
    this.database = database;
  }

  lease(): MemoryLease {
    const lease = new MemoryLease(this);
    if (this.closed) lease.release();
    else this.leases.add(lease);
    return lease;
  }

  claim(bytes: number, large: boolean): boolean {
    return !this.closed && this.budget.claim(this.database, bytes, large);
  }

  release(lease: MemoryLease, bytes: number): void {
    this.leases.delete(lease);
    this.credit(bytes);
  }

  credit(bytes: number): void {
    this.budget.release(this.database, bytes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const lease of this.leases) lease.release();
  }
}

export class MemoryLease {
  bytes = 0;
  private released = false;
  private payloadBytes = 0;

  private readonly owner: MemoryOwner;

  constructor(owner: MemoryOwner) {
    this.owner = owner;
  }

  grow(bytes: number, receivedPayloadBytes = 0): boolean {
    if (
      !Number.isSafeInteger(receivedPayloadBytes) ||
      receivedPayloadBytes < 0 ||
      receivedPayloadBytes > bytes
    )
      throw new RangeError("invalid received payload reservation");
    const payload = this.payloadBytes + receivedPayloadBytes;
    if (
      this.released ||
      !this.owner.claim(
        bytes,
        payload > MODERATE_MESSAGE_BYTES * 2 ||
          this.bytes + bytes - payload > SMALL_MESSAGE_BYTES,
      )
    )
      return false;
    this.bytes += bytes;
    this.payloadBytes = payload;
    return true;
  }

  shrink(bytes: number): void {
    if (this.released) return;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.bytes)
      throw new RangeError("invalid memory credit");
    this.bytes -= bytes;
    this.payloadBytes = Math.max(0, this.payloadBytes - bytes);
    this.owner.credit(bytes);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.owner.release(this, this.bytes);
    this.bytes = 0;
    this.payloadBytes = 0;
  }
}

/** Checks lengths before ws can retain or assemble a payload; ws still validates RFC 6455. */
export class BudgetedWebSocketSocket extends Duplex {
  private readonly header = Buffer.allocUnsafeSlow(14);
  private headerBytes = 0;
  private headerLength = 2;
  private payloadRemaining = 0;
  private messageBytes = 0;
  private finalDataFrame = false;
  private deferredPayload = false;
  private messageLease: MemoryLease | undefined;
  private controlLease: MemoryLease | undefined;
  private readonly messages: MemoryLease[] = [];
  private pending:
    { chunk: Buffer; offset: number; lease: MemoryLease } | undefined;
  private rejected = false;

  private readonly socket: Duplex;
  readonly memory: MemoryOwner;
  private maxPayload: number;
  private readonly outgoing: MemoryLease;

  constructor(
    socket: Duplex,
    memory: MemoryOwner,
    maxPayload: number,
    head: Buffer,
  ) {
    super({
      readableHighWaterMark: 64 * 1024,
      writableHighWaterMark: 64 * 1024,
    });
    this.socket = socket;
    this.memory = memory;
    this.maxPayload = maxPayload;
    this.outgoing = memory.lease();
    socket.pause();
    socket.on("data", (chunk: Buffer) => this.accept(chunk));
    socket.once("end", () => this.push(null));
    socket.once("close", () => this.destroy());
    socket.on("error", (error) => this.destroy(error));
    this.on("error", () => {});
    if (head.length !== 0) this.pending = this.hold(head);
  }

  closeAfterFlush(): void {
    if (this.destroyed) return;
    this.rejected = true;
    this.socket.resume();
    this.end(() => this.destroy());
  }

  rejectMemory(): void {
    this.reject(1013);
  }

  takeMessage(): MemoryLease | undefined {
    return this.messages.shift();
  }

  setMaxPayload(maxPayload: number): void {
    if (!Number.isSafeInteger(maxPayload) || maxPayload < this.maxPayload)
      throw new RangeError("invalid payload limit");
    this.maxPayload = maxPayload;
  }

  private hold(chunk: Buffer) {
    const lease = this.memory.lease();
    if (!lease.grow(chunk.length + BUFFER_OVERHEAD_BYTES)) {
      lease.release();
      this.reject(1013);
      return;
    }
    return { chunk, offset: 0, lease };
  }

  private accept(chunk: Buffer): void {
    if (this.rejected || this.destroyed) return;
    this.pending = this.hold(chunk);
    this.consume();
  }

  private reject(code: number): void {
    if (this.rejected || this.destroyed) return;
    this.rejected = true;
    this.emit("rejected", code);
    this.socket.resume();
    // Flush the close frame, then destroy only this offender and its receiver buffers.
    setImmediate(() => this.end());
    const deadline = setTimeout(() => this.destroy(), 500);
    deadline.unref();
    this.once("close", () => clearTimeout(deadline));
  }

  private beginFrame(): boolean {
    const encodedLength = (this.header[1] ?? 0) & 0x7f;
    const length =
      encodedLength === 126
        ? this.header.readUInt16BE(2)
        : encodedLength === 127
          ? Number(this.header.readBigUInt64BE(2))
          : encodedLength;
    if (!Number.isSafeInteger(length) || length > this.maxPayload) {
      this.reject(1009);
      return false;
    }
    const opcode = (this.header[0] ?? 0) & 0x0f;
    this.finalDataFrame = opcode < 8 && ((this.header[0] ?? 0) & 0x80) !== 0;
    if (opcode < 8) {
      this.messageBytes += length;
      if (this.messageBytes > this.maxPayload) {
        this.reject(1009);
        return false;
      }
      this.messageLease ??= this.memory.lease();
      this.deferredPayload = this.messageBytes <= MODERATE_MESSAGE_BYTES;
      // A receiver may transiently hold TCP pieces and the contiguous frame copy.
      // Moderate messages spend protected credit only as their payload actually arrives.
      if (
        !this.messageLease.grow(
          (this.deferredPayload ? 0 : length * 2) + BUFFER_OVERHEAD_BYTES,
        )
      ) {
        this.reject(1013);
        return false;
      }
    } else {
      this.controlLease = this.memory.lease();
      if (!this.controlLease.grow(length * 2 + BUFFER_OVERHEAD_BYTES)) {
        this.reject(1013);
        return false;
      }
    }
    this.payloadRemaining = length;
    return true;
  }

  private completeFrame(): MemoryLease | undefined {
    let control: MemoryLease | undefined;
    if (this.controlLease) {
      control = this.controlLease;
      this.controlLease = undefined;
    } else if (this.finalDataFrame && this.messageLease) {
      this.messages.push(this.messageLease);
      this.messageLease = undefined;
      this.messageBytes = 0;
    }
    this.headerBytes = 0;
    this.headerLength = 2;
    return control;
  }

  private consume(): void {
    const pending = this.pending;
    if (!pending || this.rejected || this.destroyed) return;
    while (
      pending.offset < pending.chunk.length &&
      !this.rejected &&
      !this.destroyed
    ) {
      let output: Buffer;
      let completedControl: MemoryLease | undefined;
      if (this.headerBytes < this.headerLength) {
        const length = Math.min(
          this.headerLength - this.headerBytes,
          pending.chunk.length - pending.offset,
        );
        pending.chunk.copy(
          this.header,
          this.headerBytes,
          pending.offset,
          pending.offset + length,
        );
        pending.offset += length;
        this.headerBytes += length;
        if (this.headerBytes === 2) {
          const encodedLength = (this.header[1] ?? 0) & 0x7f;
          this.headerLength =
            2 +
            (encodedLength === 126 ? 2 : encodedLength === 127 ? 8 : 0) +
            (((this.header[1] ?? 0) & 0x80) !== 0 ? 4 : 0);
        }
        if (this.headerBytes !== this.headerLength) continue;
        if (!this.beginFrame()) break;
        output = Buffer.allocUnsafeSlow(this.headerLength);
        this.header.copy(output, 0, 0, this.headerLength);
        if (this.payloadRemaining === 0)
          completedControl = this.completeFrame();
      } else {
        const length = Math.min(
          this.payloadRemaining,
          pending.chunk.length - pending.offset,
        );
        const lease = this.controlLease ?? this.messageLease;
        const receivedPayloadBytes =
          !this.controlLease && this.deferredPayload ? length * 2 : 0;
        if (
          !lease?.grow(
            receivedPayloadBytes + BUFFER_OVERHEAD_BYTES,
            receivedPayloadBytes,
          )
        ) {
          this.reject(1013);
          break;
        }
        // Exact allocations prevent a one-byte fragment from retaining a whole TCP read.
        output = Buffer.allocUnsafeSlow(length);
        pending.chunk.copy(output, 0, pending.offset, pending.offset + length);
        pending.offset += length;
        this.payloadRemaining -= length;
        if (this.payloadRemaining === 0)
          completedControl = this.completeFrame();
      }
      const more = this.push(output);
      completedControl?.release();
      if (!more) {
        this.socket.pause();
        break;
      }
    }
    if (
      pending.offset === pending.chunk.length ||
      this.rejected ||
      this.destroyed
    ) {
      pending.lease.release();
      this.pending = undefined;
    }
  }

  override _read(): void {
    this.consume();
    if (!this.pending && !this.rejected && !this.destroyed)
      this.socket.resume();
  }

  override write(
    chunk: string | Uint8Array,
    callback?: (error?: Error | null) => void,
  ): boolean;
  override write(
    chunk: string | Uint8Array,
    encoding: BufferEncoding,
    callback?: (error?: Error | null) => void,
  ): boolean;
  override write(
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const encoding =
      typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const done =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    const length =
      typeof chunk === "string"
        ? Buffer.byteLength(chunk, encoding)
        : chunk.byteLength;
    const charge = length + BUFFER_OVERHEAD_BYTES;
    // Tiny control replies form one queue and must not spend the small-stream reserve.
    if (!this.outgoing.grow(charge)) {
      const error = new Error("gateway memory limit");
      queueMicrotask(() => done?.(error));
      this.destroy(error);
      return false;
    }
    const complete = (error?: Error | null) => {
      this.outgoing.shrink(charge);
      done?.(error);
    };
    return encoding
      ? super.write(chunk, encoding, complete)
      : super.write(chunk, complete);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.socket.write(chunk, callback);
  }

  override _writev(
    chunks: { chunk: Buffer; encoding: BufferEncoding }[],
    callback: (error?: Error | null) => void,
  ): void {
    let remaining = chunks.length;
    let failure: Error | null | undefined;
    this.socket.cork();
    for (const { chunk } of chunks)
      this.socket.write(chunk, (error) => {
        failure ??= error;
        if (--remaining === 0) callback(failure);
      });
    this.socket.uncork();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.socket.end(callback);
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.socket.destroy();
    this.pending = undefined;
    this.messages.length = 0;
    this.messageLease = undefined;
    this.controlLease = undefined;
    this.memory.close();
    callback(error);
  }
}
