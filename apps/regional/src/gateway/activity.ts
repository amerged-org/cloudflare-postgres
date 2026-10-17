// SPDX-License-Identifier: Apache-2.0
/** Includes partial WebSocket envelopes that ws has not emitted as PG messages yet. */
export class WebSocketInputActivity {
  private readonly header = Buffer.alloc(14);
  private bytes = 0;
  private headerLength = 2;
  private remaining = 0;
  private fragmented = false;
  private dataFrame = false;
  private final = false;
  private messages = 0;
  private invalid = false;

  observe(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length && !this.invalid) {
      if (this.bytes < this.headerLength) {
        const take = Math.min(
          this.headerLength - this.bytes,
          chunk.length - offset,
        );
        chunk.copy(this.header, this.bytes, offset, offset + take);
        this.bytes += take;
        offset += take;
        if (this.bytes < this.headerLength) return;
        if (this.headerLength === 2) {
          if ((this.header[1]! & 128) === 0) {
            this.invalid = true;
            return;
          }
          const encoded = this.header[1]! & 127;
          this.headerLength =
            6 + (encoded === 126 ? 2 : encoded === 127 ? 8 : 0);
          continue;
        }
        const encoded = this.header[1]! & 127;
        const size =
          encoded === 126
            ? this.header.readUInt16BE(2)
            : encoded === 127
              ? this.header.readBigUInt64BE(2)
              : BigInt(encoded);
        if (BigInt(size) > BigInt(32 * 1024 * 1024)) {
          this.invalid = true;
          return;
        }
        this.remaining = Number(size);
        const opcode = this.header[0]! & 15;
        this.final = (this.header[0]! & 128) !== 0;
        this.dataFrame = opcode === 0 || opcode === 1 || opcode === 2;
        if (this.dataFrame && !this.final) this.fragmented = true;
      }
      const take = Math.min(this.remaining, chunk.length - offset);
      offset += take;
      this.remaining -= take;
      if (this.remaining === 0) {
        if (this.dataFrame && this.final) {
          this.fragmented = false;
          if (++this.messages > 65536) this.invalid = true;
        }
        this.bytes = 0;
        this.headerLength = 2;
      }
    }
  }
  consumeMessage(): void {
    if (this.messages === 0) this.invalid = true;
    else this.messages--;
  }
  get busy(): boolean {
    return (
      this.invalid ||
      this.bytes !== 0 ||
      this.remaining !== 0 ||
      this.fragmented ||
      this.messages !== 0
    );
  }
}
