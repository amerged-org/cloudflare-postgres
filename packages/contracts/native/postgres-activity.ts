// SPDX-License-Identifier: Apache-2.0
/** Observes protocol boundaries only; bodies stream unchanged without being retained. */
class MessageReader {
  private readonly header = Buffer.alloc(5);
  private readonly prefix = Buffer.alloc(4);
  private headerBytes = 0;
  private remaining = 0;
  private prefixBytes = 0;
  private length = 0;
  private type = 0;
  invalid = false;

  private readonly start: (type: number, length: number) => void;
  private readonly complete: (
    type: number,
    length: number,
    prefix: Buffer,
  ) => void;
  constructor(
    start: (type: number, length: number) => void,
    complete: (type: number, length: number, prefix: Buffer) => void,
  ) {
    this.start = start;
    this.complete = complete;
  }

  get partial(): boolean {
    return this.headerBytes !== 0 || this.remaining !== 0;
  }

  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length && !this.invalid) {
      if (this.headerBytes < 5) {
        const take = Math.min(5 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + take);
        this.headerBytes += take;
        offset += take;
        if (this.headerBytes < 5) return;
        this.type = this.header[0]!;
        this.length = this.header.readUInt32BE(1);
        if (this.length < 4 || this.length > 0x7fffffff) {
          this.invalid = true;
          return;
        }
        this.remaining = this.length - 4;
        this.prefixBytes = 0;
        this.start(this.type, this.length);
      }
      const take = Math.min(this.remaining, chunk.length - offset);
      const keep = Math.min(take, 4 - this.prefixBytes);
      if (keep > 0) {
        chunk.copy(this.prefix, this.prefixBytes, offset, offset + keep);
        this.prefixBytes += keep;
      }
      offset += take;
      this.remaining -= take;
      if (this.remaining === 0) {
        this.complete(
          this.type,
          this.length,
          this.prefix.subarray(0, this.prefixBytes),
        );
        this.headerBytes = 0;
      }
    }
  }
}

export class PostgresActivity {
  private authenticationComplete = false;
  private readyCycles = 1;
  private completeReadyCycles = 1;
  private extended = false;
  private copy = false;
  private transaction = true;
  private uncertain = false;
  private readonly frontend = new MessageReader(
    (type, length) => {
      const tag = String.fromCharCode(type);
      if (tag === "Q" || tag === "S") {
        if (++this.readyCycles > 65536) this.uncertain = true;
        if (tag === "S" && length !== 4) this.uncertain = true;
      } else if ("PBEDCH".includes(tag)) this.extended = true;
      else if ("dcf".includes(tag)) this.copy = true;
      else if (tag !== "p") this.uncertain = true;
      if (tag === "p" && this.authenticationComplete) this.uncertain = true;
    },
    (type) => {
      if (type === 81 || type === 83) this.completeReadyCycles++;
      if (type === 83) this.extended = false;
    },
  );
  private readonly backend = new MessageReader(
    (type) => {
      if (type === 71 || type === 72 || type === 87) this.copy = true;
    },
    (type, length, prefix) => {
      if (type === 82) {
        if (length < 8) this.uncertain = true;
        else if (prefix.readUInt32BE(0) === 0) {
          if (length !== 8 || this.authenticationComplete)
            this.uncertain = true;
          this.authenticationComplete = true;
        }
      } else if (type === 90) {
        const state = prefix[0];
        if (
          length !== 5 ||
          !this.authenticationComplete ||
          this.completeReadyCycles === 0 ||
          (state !== 73 && state !== 84 && state !== 69)
        ) {
          this.uncertain = true;
          return;
        }
        this.readyCycles--;
        this.completeReadyCycles--;
        this.transaction = state !== 73;
        this.copy = false;
      }
    },
  );

  observeFrontend(chunk: Buffer): void {
    this.frontend.push(chunk);
  }
  get authenticated(): boolean {
    return this.authenticationComplete;
  }
  observeBackend(chunk: Buffer): void {
    this.backend.push(chunk);
  }
  get busy(): boolean {
    return (
      this.uncertain ||
      !this.authenticationComplete ||
      this.transaction ||
      this.readyCycles !== 0 ||
      this.extended ||
      this.copy ||
      this.frontend.invalid ||
      this.backend.invalid ||
      this.frontend.partial ||
      this.backend.partial
    );
  }
}
