// SPDX-License-Identifier: Apache-2.0
import { Transform } from "node:stream";
import type { TransformCallback } from "node:stream";

export const AUTH_BYTES = 64 * 1024;
const SSL_REQUEST = 80877103;
const GSS_REQUEST = 80877104;

export class BackendAuthentication extends Transform {
  private frame = Buffer.alloc(AUTH_BYTES);
  private length = 0;
  private target = 5;
  private offered = false;
  private typed = false;
  private preludes = 0;
  authenticated = false;

  constructor() {
    super({ highWaterMark: AUTH_BYTES });
  }

  expectPrelude(): void {
    if (this.typed || this.authenticated || this.preludes >= 2)
      throw new Error("invalid_auth_prelude");
    this.preludes++;
  }

  private authentication(frame: Buffer): Buffer {
    if (frame.length < 9) throw new Error("invalid_auth_frame");
    const code = frame.readUInt32BE(5);
    if (code === 3) throw new Error("cleartext_auth_refused");
    if (code === 0) {
      if (frame.length !== 9) throw new Error("invalid_auth_frame");
      this.authenticated = true;
      return frame;
    }
    if (code !== 10) return frame;
    if (this.offered) throw new Error("duplicate_sasl_offer");
    this.offered = true;
    const bytes = frame.subarray(9);
    if (bytes.length < 2 || bytes.at(-1) !== 0 || bytes.at(-2) !== 0)
      throw new Error("invalid_sasl_offer");
    const names = bytes.subarray(0, -2).toString("ascii").split("\0");
    if (
      bytes.some((value) => value > 127) ||
      names.length > 16 ||
      names.some((name) => !/^[A-Z0-9_-]{1,128}$/.test(name)) ||
      new Set(names).size !== names.length ||
      !names.includes("SCRAM-SHA-256")
    )
      throw new Error("invalid_sasl_offer");
    const retained = names.filter((name) => name !== "SCRAM-SHA-256-PLUS");
    if (retained.length === names.length) return frame;
    const mechanisms = Buffer.from(retained.join("\0") + "\0\0");
    const rewritten = Buffer.alloc(9 + mechanisms.length);
    rewritten[0] = 0x52;
    rewritten.writeUInt32BE(8 + mechanisms.length, 1);
    rewritten.writeUInt32BE(10, 5);
    mechanisms.copy(rewritten, 9);
    return rewritten;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.authenticated) {
          this.push(chunk.subarray(offset));
          break;
        }
        if (this.preludes && this.length === 0) {
          if (chunk[offset] !== 0x4e) throw new Error("invalid_auth_prelude");
          this.preludes--;
          this.push(chunk.subarray(offset, ++offset));
          continue;
        }
        this.typed = true;
        const count = Math.min(
          this.target - this.length,
          chunk.length - offset,
        );
        chunk.copy(this.frame, this.length, offset, offset + count);
        this.length += count;
        offset += count;
        if (this.length !== this.target) continue;
        if (this.target === 5) {
          const length = this.frame.readUInt32BE(1);
          if (length < 4 || length + 1 > AUTH_BYTES)
            throw new Error("invalid_auth_frame");
          this.target = length + 1;
          if (this.length !== this.target) continue;
        }
        const frame = Buffer.from(this.frame.subarray(0, this.target));
        this.push(frame[0] === 0x52 ? this.authentication(frame) : frame);
        this.length = 0;
        this.target = 5;
      }
      callback();
    } catch (error) {
      callback(
        error instanceof Error ? error : new Error("invalid_auth_frame"),
      );
    }
  }

  override _flush(callback: TransformCallback): void {
    callback(
      this.length || this.preludes
        ? new Error("truncated_auth_frame")
        : undefined,
    );
  }
}

export class FrontendPrelude extends Transform {
  private header = Buffer.alloc(8);
  private length = 0;
  private startup = false;
  private count = 0;
  private backend: BackendAuthentication;

  constructor(backend: BackendAuthentication) {
    super({ highWaterMark: AUTH_BYTES });
    this.backend = backend;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.startup || this.backend.authenticated) {
          if (this.length) {
            this.push(Buffer.from(this.header.subarray(0, this.length)));
            this.length = 0;
          }
          this.push(chunk.subarray(offset));
          break;
        }
        const count = Math.min(8 - this.length, chunk.length - offset);
        chunk.copy(this.header, this.length, offset, offset + count);
        this.length += count;
        offset += count;
        if (this.length !== 8) continue;
        const code = this.header.readUInt32BE(4);
        if (code === SSL_REQUEST || code === GSS_REQUEST) {
          if (this.header.readUInt32BE(0) !== 8 || ++this.count > 2)
            throw new Error("invalid_frontend_prelude");
          this.backend.expectPrelude();
        } else this.startup = true;
        this.push(Buffer.from(this.header));
        this.length = 0;
      }
      callback();
    } catch (error) {
      callback(
        error instanceof Error ? error : new Error("invalid_frontend_prelude"),
      );
    }
  }

  override _flush(callback: TransformCallback): void {
    if (this.backend.authenticated && this.length) {
      this.push(Buffer.from(this.header.subarray(0, this.length)));
      this.length = 0;
    }
    callback(this.length ? new Error("truncated_frontend_prelude") : undefined);
  }
}
