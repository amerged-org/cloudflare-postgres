// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  CANCEL_REQUEST_CODE,
  DEFAULT_MAX_BUFFERED,
  GSSENC_REQUEST_CODE,
  STARTUP_MAX_LENGTH,
  StartupReader,
  encodeEncryptionDeclined,
  encodeErrorResponse,
  encodeSslRequest,
  encodeStartup,
  type StartupEvent,
} from "../src/pg-wire.ts";

const user = "app";
const database = "a1b2c3d4e5f6g7h8i9j0";
const startup = encodeStartup(
  new Map([
    ["user", user],
    ["database", database],
    ["options", "-c search_path=public  -c statement_timeout=5s"],
    ["application_name", "pgcf-test"],
  ]),
);

function u32(value: number): number[] {
  return [
    value >>> 24,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const out = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function packet(code: number, body: number[] = []): Uint8Array {
  return Uint8Array.from([...u32(8 + body.length), ...u32(code), ...body]);
}

function ascii(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

/** Rawly built startup body: key\0value\0...\0 */
function rawStartup(fields: (number[] | string)[], minor = 0): Uint8Array {
  const body = fields.flatMap((f) => [
    ...(typeof f === "string" ? ascii(f) : f),
    0,
  ]);
  return packet((3 << 16) | minor, [...body, 0]);
}

/** Feeds chunks like the edge does: after ssl/gss, drain with an empty push. */
function drive(
  reader: StartupReader,
  chunks: Iterable<Uint8Array>,
): StartupEvent[] {
  const events: StartupEvent[] = [];
  for (const chunk of chunks) {
    let event = reader.push(chunk);
    for (;;) {
      if (event.kind === "need-more") break;
      events.push(event);
      if (event.kind !== "ssl" && event.kind !== "gss") return events;
      event = reader.push(new Uint8Array(0));
    }
  }
  return events;
}

function bytewise(input: Uint8Array): Uint8Array[] {
  return [...input].map((b) => Uint8Array.of(b));
}

function* chunkInput(
  input: Uint8Array,
  nextSize: () => number,
): Generator<Uint8Array> {
  for (const [start, end] of chunkRanges(input.length, nextSize))
    yield input.subarray(start, end);
}

function* chunkRanges(
  length: number,
  nextSize: () => number,
): Generator<readonly [number, number]> {
  let offset = 0;
  do {
    const end = Math.min(offset + nextSize(), length);
    yield [offset, end];
    offset = end;
  } while (offset < length);
}

function seededRandom(seed: number): (n: number) => number {
  let state = seed;
  return (n) => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state % n;
  };
}

function chunkSize(below: (n: number) => number): number {
  return below(4) === 0 ? 0 : 1 + below(below(2) === 0 ? 16 : 4096);
}

/** Generate only bytes the reader requests; a terminal event stops iteration. */
function* randomChunks(
  prefix: Uint8Array,
  bodyLength: number,
  below: (n: number) => number,
): Generator<Uint8Array> {
  const length = prefix.length + bodyLength;
  for (const [offset, end] of chunkRanges(length, () => chunkSize(below))) {
    const size = end - offset;
    const prefixEnd = Math.min(end, prefix.length);
    if (end <= prefix.length) {
      yield prefix.subarray(offset, end);
    } else {
      const chunk = new Uint8Array(size);
      const prefixLength = Math.max(prefixEnd - offset, 0);
      if (prefixLength > 0) chunk.set(prefix.subarray(offset, prefixEnd));
      for (let i = prefixLength; i < size; i++)
        chunk[i] = below(4) === 0 ? 0 : below(256);
      yield chunk;
    }
  }
}

/** Include later frames in rest, as the edge forwards them after routing. */
function driveComplete(
  input: Uint8Array,
  nextSize: () => number,
): StartupEvent[] {
  let received = 0;
  function* chunks() {
    for (const chunk of chunkInput(input, nextSize)) {
      received += chunk.length;
      yield chunk;
    }
  }
  const events = drive(new StartupReader(), chunks());
  const last = events.at(-1);
  if (last?.kind === "startup") {
    events[events.length - 1] = {
      ...last,
      rest: concat(last.rest, input.subarray(received)),
    };
  }
  return events;
}

function single(input: Uint8Array): StartupEvent {
  const events = drive(new StartupReader(), [input]);
  expect(events).toHaveLength(1);
  return events[0]!;
}

function expectError(event: StartupEvent, sqlstate: string): void {
  expect(event.kind).toBe("error");
  if (event.kind === "error") expect(event.sqlstate).toBe(sqlstate);
}

describe("encodings", () => {
  it("has the exact SSLRequest bytes and the decline byte", () => {
    expect([...encodeSslRequest()]).toEqual([
      0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f,
    ]);
    expect([...encodeEncryptionDeclined()]).toEqual([0x4e]);
  });

  it("encodes a FATAL ErrorResponse", () => {
    const bytes = encodeErrorResponse("3D000", 'database "x" does not exist');
    const body = [
      ...[0x53, ...ascii("FATAL"), 0],
      ...[0x56, ...ascii("FATAL"), 0],
      ...[0x43, ...ascii("3D000"), 0],
      ...[0x4d, ...ascii('database "x" does not exist'), 0],
      0,
    ];
    expect([...bytes]).toEqual([0x45, ...u32(4 + body.length), ...body]);
    expect(() => encodeErrorResponse("3d000", "x")).toThrow(RangeError);
  });

  it("encodes startup canonically and refuses fields that cannot be encoded", () => {
    expect([...encodeStartup({ user: "u" }, 2)]).toEqual([
      ...u32(16),
      ...u32((3 << 16) | 2),
      ...ascii("user"),
      0,
      0x75,
      0,
      0,
    ]);
    expect(() => encodeStartup({ "": "x" })).toThrow(RangeError);
    expect(() => encodeStartup({ user: "a\0b" })).toThrow(RangeError);
    expect(() => encodeStartup({ user: "x".repeat(10000) })).toThrow(
      RangeError,
    );
  });

  it("rejects oversized source parameters before allocating encoded bytes", () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      expect(() =>
        encodeStartup({ user: "x".repeat(STARTUP_MAX_LENGTH) }),
      ).toThrow("startup too large");
      expect(encode.mock.calls.length).toBe(0);
      expect(() =>
        encodeStartup({ ["x".repeat(STARTUP_MAX_LENGTH)]: "u" }),
      ).toThrow("startup too large");
      expect(encode.mock.calls.length).toBe(0);
      expect(() =>
        encodeStartup(
          new Map([
            ["user", "x".repeat(4990)],
            ["options", "y".repeat(4990)],
          ]),
        ),
      ).toThrow("startup too large");
      expect(encode.mock.calls.length).toBe(0);
    } finally {
      encode.mockRestore();
    }
  });

  it("enforces the exact UTF-8 byte limit for multibyte source parameters", () => {
    const value = "€".repeat(3328) + "x";
    const encoded = encodeStartup({ user: value });
    expect(encoded.length).toBe(STARTUP_MAX_LENGTH);
    const parsed = single(encoded);
    expect(parsed.kind === "startup" && parsed.user).toBe(value);
    expect(() => encodeStartup({ user: value + "x" })).toThrow(
      "startup too large",
    );
  });
});

describe("StartupReader", () => {
  it("keeps every input byte when chunking includes empty pushes", () => {
    const sizes = [0, 3, 0, 5, 0, startup.length];
    let next = 0;
    const chunks = [...chunkInput(startup, () => sizes[next++]!)];
    expect(concat(...chunks)).toEqual(startup);
    expect(drive(new StartupReader(), chunks)).toEqual(
      drive(new StartupReader(), [startup]),
    );
  });

  it("parses a startup message whole and byte by byte identically", () => {
    const whole = drive(new StartupReader(), [startup]);
    const split = drive(new StartupReader(), bytewise(startup));
    expect(split).toEqual(whole);
    const event = whole[0]!;
    expect(event.kind).toBe("startup");
    if (event.kind !== "startup") return;
    expect(event.user).toBe(user);
    expect(event.database).toBe(database);
    expect(event.protocol).toEqual({ major: 3, minor: 0 });
    expect(event.params.get("options")).toBe(
      "-c search_path=public  -c statement_timeout=5s",
    );
    expect([...event.params.keys()]).toEqual([
      "user",
      "database",
      "options",
      "application_name",
    ]);
    expect(event.raw).toEqual(startup);
    expect(encodeStartup(event.params)).toEqual(event.raw);
    expect(event.rest).toEqual(new Uint8Array(0));
  });

  it("answers SSL then startup, including both in one chunk", () => {
    const input = concat(encodeSslRequest(), startup);
    const whole = drive(new StartupReader(), [input]);
    expect(whole.map((e) => e.kind)).toEqual(["ssl", "startup"]);
    expect(drive(new StartupReader(), bytewise(input))).toEqual(whole);
  });

  it("answers GSS then SSL then startup and rejects a third prelude", () => {
    const gss = packet(GSSENC_REQUEST_CODE);
    const input = concat(gss, encodeSslRequest(), startup);
    expect(drive(new StartupReader(), [input]).map((e) => e.kind)).toEqual([
      "gss",
      "ssl",
      "startup",
    ]);
    const third = drive(new StartupReader(), [
      concat(gss, encodeSslRequest(), gss),
    ]);
    expect(third.map((e) => e.kind)).toEqual(["gss", "ssl", "error"]);
    expectError(third[2]!, "08P01");
    const repeated = drive(new StartupReader(), [
      concat(encodeSslRequest(), encodeSslRequest()),
    ]);
    expect(repeated.map((e) => e.kind)).toEqual(["ssl", "error"]);
  });

  it("recognises a CancelRequest for protocol 3.0 and 3.2 key lengths", () => {
    const cancel30 = packet(CANCEL_REQUEST_CODE, [...u32(1234), ...u32(5678)]);
    expect(single(cancel30)).toEqual({ kind: "cancel" });
    const cancel32 = packet(CANCEL_REQUEST_CODE, [
      ...u32(1),
      ...new Array(32).fill(7),
    ]);
    expect(single(cancel32)).toEqual({ kind: "cancel" });
    expectError(single(packet(CANCEL_REQUEST_CODE, u32(1))), "08P01");
    const max = packet(CANCEL_REQUEST_CODE, [
      ...u32(1),
      ...new Array(256).fill(7),
    ]);
    expect(max.length).toBe(268);
    expect(single(max)).toEqual({ kind: "cancel" });
    expect(drive(new StartupReader(), bytewise(max))).toEqual([
      { kind: "cancel" },
    ]);
    const oversize = packet(CANCEL_REQUEST_CODE, [
      ...u32(1),
      ...new Array(257).fill(7),
    ]);
    expect(oversize.length).toBe(269);
    expectError(single(oversize), "08P01");
  });

  it("rejects undersize and oversize lengths as soon as the length is known", () => {
    expectError(new StartupReader().push(Uint8Array.from(u32(7))), "08P01");
    expectError(new StartupReader().push(Uint8Array.from(u32(10001))), "08P01");
    expectError(
      new StartupReader().push(Uint8Array.from(u32(0xffffffff))),
      "08P01",
    );
    expectError(
      single(Uint8Array.from([...u32(9), ...u32(80877103), 0])),
      "08P01",
    );
    const max = rawStartup(["user", "u", "x", "y".repeat(10000 - 19)]);
    expect(max.length).toBe(10000);
    expect(single(max).kind).toBe("startup");
  });

  it("rejects an unsupported protocol version", () => {
    expectError(single(packet((2 << 16) | 0, [0])), "0A000");
    expectError(single(packet((1234 << 16) | 5681)), "0A000");
  });

  it("rejects duplicate keys, replication and invalid UTF-8", () => {
    expectError(single(rawStartup(["user", "a", "user", "b"])), "08P01");
    expectError(
      single(rawStartup(["user", "a", "replication", "database"])),
      "0A000",
    );
    expectError(single(rawStartup(["user", [0x61, 0xc3, 0x28]])), "08P01");
    expectError(single(rawStartup([[0xff], "x", "user", "a"])), "08P01");
  });

  it("rejects broken layouts and a missing user", () => {
    expectError(
      single(packet(3 << 16, [...ascii("user"), 0, ...ascii("a"), 0])),
      "08P01",
    );
    expectError(
      single(packet(3 << 16, [...ascii("user"), 0, ...ascii("a")])),
      "08P01",
    );
    expectError(
      single(packet(3 << 16, [...ascii("user"), 0, ...ascii("a"), 0, 0, 0])),
      "08P01",
    );
    expectError(single(rawStartup(["database", "d"])), "28000");
    expectError(single(rawStartup(["user", ""])), "28000");
  });

  it("falls back to the user when the database is missing or empty", () => {
    for (const fields of [
      ["user", "u"],
      ["user", "u", "database", ""],
    ]) {
      const event = single(rawStartup(fields));
      expect(event.kind === "startup" && event.database).toBe("u");
      expect(event.kind === "startup" && event.params.get("database")).toBe(
        fields[3],
      );
    }
  });

  it("keeps the protocol minor and preserves trailing bytes exactly", () => {
    const trailing = Uint8Array.of(0x70, 0, 0, 0, 5, 0x41, 0xff, 0);
    const input = concat(rawStartup(["user", "u"], 2), trailing);
    const event = single(input);
    expect(event.kind).toBe("startup");
    if (event.kind !== "startup") return;
    expect(event.protocol.minor).toBe(2);
    expect(event.raw).toEqual(rawStartup(["user", "u"], 2));
    expect(event.rest).toEqual(trailing);
    const afterSsl = drive(new StartupReader(), [
      concat(encodeSslRequest(), startup.subarray(0, 5)),
      concat(startup.subarray(5), trailing),
    ]);
    const last = afterSsl[1]!;
    expect(last.kind === "startup" && last.rest).toEqual(trailing);
  });

  it("is final after startup, cancel or error", () => {
    const reader = new StartupReader();
    expect(reader.push(startup).kind).toBe("startup");
    expectError(reader.push(startup), "08P01");
    expect(reader.bufferedBytes).toBe(0);
  });

  it("refuses to buffer more than its limit", () => {
    const reader = new StartupReader();
    const big = new Uint8Array(DEFAULT_MAX_BUFFERED + 1);
    big.set(startup);
    expectError(reader.push(big), "08P01");
    expect(reader.bufferedBytes).toBe(0);
    const atLimit = big.subarray(0, DEFAULT_MAX_BUFFERED);
    const accepted = single(atLimit);
    expect(accepted.kind).toBe("startup");
    if (accepted.kind !== "startup") return;
    expect(accepted.raw).toEqual(startup);
    expect(accepted.rest.length).toBe(DEFAULT_MAX_BUFFERED - startup.length);
    expect(accepted.rest.every((byte) => byte === 0)).toBe(true);
  });

  it("parses representative seeded streams identically whole and in random chunks", () => {
    const below = seededRandom(0x6a09e667);
    const gss = packet(GSSENC_REQUEST_CODE);
    const samples = [
      startup,
      concat(encodeSslRequest(), startup),
      concat(gss, encodeSslRequest(), startup),
      concat(gss, encodeSslRequest(), gss),
      concat(startup, Uint8Array.of(0x70, 0, 0, 0, 5, 0x41)),
      packet(CANCEL_REQUEST_CODE, [...u32(1), ...new Array(256).fill(7)]),
      rawStartup(["user", "u", "user", "v"]),
      rawStartup(["user", "u", "replication", "database"]),
      rawStartup(["user", [0xc3, 0x28]]),
      Uint8Array.from(u32(10001)),
      startup.subarray(0, 7),
    ];
    for (const input of samples) {
      expect(driveComplete(input, () => chunkSize(below))).toEqual(
        drive(new StartupReader(), [input]),
      );
    }
    for (let round = 0; round < 500; round++) {
      const input = Uint8Array.from(startup);
      for (let i = below(3); i >= 0; i--)
        input[below(input.length)] = below(256);
      expect(driveComplete(input, () => chunkSize(below))).toEqual(
        drive(new StartupReader(), [input]),
      );
    }
  });

  it("never throws and never buffers beyond its limit on seeded random input", () => {
    const below = seededRandom(0x9e3779b9);
    const prefixes = [
      encodeSslRequest(),
      packet(GSSENC_REQUEST_CODE),
      startup.subarray(0, 8),
      Uint8Array.from(u32(below(10_200))),
      new Uint8Array(0),
    ];
    const mutated = () => {
      const copy = Uint8Array.from(startup);
      for (let i = below(3); i >= 0; i--) copy[below(copy.length)] = below(256);
      return copy;
    };
    const kinds = new Set<string>();
    for (let round = 0; round < 3000; round++) {
      const maxBuffered = below(2) === 0 ? DEFAULT_MAX_BUFFERED : 10_000;
      const reader = new StartupReader(maxBuffered);
      const prefix =
        below(4) === 0 ? mutated() : prefixes[below(prefixes.length)]!;
      const bodyLength = below(below(4) === 0 ? 70_000 : 300);
      let maxObserved = 0;
      for (const chunk of randomChunks(prefix, bodyLength, below)) {
        let event = reader.push(chunk);
        for (;;) {
          maxObserved = Math.max(maxObserved, reader.bufferedBytes);
          kinds.add(event.kind);
          if (event.kind === "startup")
            maxObserved = Math.max(
              maxObserved,
              event.raw.length + event.rest.length,
            );
          if (event.kind !== "ssl" && event.kind !== "gss") break;
          event = reader.push(new Uint8Array(0));
        }
        if (event.kind !== "need-more") break;
      }
      expect(maxObserved).toBeLessThanOrEqual(maxBuffered);
    }
    expect(kinds).toContain("error");
    expect(kinds).toContain("ssl");
    expect(kinds).toContain("need-more");
    expect(kinds).toContain("startup");
    expect(kinds).toContain("gss");
  });
});
