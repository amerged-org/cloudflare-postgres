// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import {
  RELEASE_FILES,
  releaseFileUrl,
  type ReleaseFile,
} from "@pgcf/contracts/releases";
import { parseByteRange } from "../../src/domain/release-files.ts";
import { issueNodeInstall } from "../../src/domain/node-install.ts";
import {
  API_ORIGIN,
  cleanupFixtures,
  fixture,
  rawRequest,
  refusal,
  request,
  stageRelease,
} from "./fixtures.ts";
import {
  auditedAddition,
  forgetInstalls,
  progress,
  sources,
} from "./node-fixtures.ts";

afterEach(async () => {
  await forgetInstalls();
  await env.DB.prepare(
    "DELETE FROM fleet_releases WHERE id LIKE 'release-files-%'",
  ).run();
  await cleanupFixtures();
});

async function registered() {
  const f = await fixture(),
    version = `release-files-${crypto.randomUUID().slice(0, 8)}`,
    registration = await stageRelease(version);
  expect(
    (
      await request(
        `/v1/fleet/releases/${version}`,
        f.admin,
        "PUT",
        registration,
      )
    ).status,
  ).toBe(200);
  const path = (file: ReleaseFile, release = version) =>
    new URL(releaseFileUrl(API_ORIGIN, release, file)).pathname;
  const body = (file: ReleaseFile, release = version) =>
    new TextEncoder().encode(`${release}/${file}`);
  return { f, version, path, body };
}
const get = (path: string, headers: HeadersInit = {}, method = "GET") =>
  rawRequest(path, { method, headers });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("the files every node reads", () => {
  it("serves a release's binaries and package lock to anyone, as the agent reads them without a credential", async () => {
    const r = await registered();
    for (const file of RELEASE_FILES.filter(
      (name) => name !== "pgcf-node.raw.zst",
    )) {
      const response = await get(r.path(file));
      expect(response.status, file).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        r.body(file),
      );
    }
    const response = await get(r.path("pgcf-agent"));
    expect(response.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Length")).toBe(
      String(r.body("pgcf-agent").byteLength),
    );
    expect(response.headers.get("ETag")).toMatch(/^"[0-9a-f]+"$/);
  });

  it("knows only the files of a registered release", async () => {
    const r = await registered();
    for (const path of [
      r.path("pgcf-agent", "release-files-unknown"),
      `/node/v1/releases/${r.version}/pgcf-agent.sig`,
      `/node/v1/releases/${r.version}/..%2Fother`,
      `/node/v1/releases/${r.version}/`,
      `/node/v1/releases/${r.version}`,
      `/node/v1/releases/Not%20A%20Version/pgcf-agent`,
    ])
      expect((await get(path)).status, path).toBe(404);
    // An object in the bucket that no release registered is not served.
    await env.ARCHIVE.put("node-images/release-files-stray/pgcf-agent", "x");
    try {
      expect(
        (await get(r.path("pgcf-agent", "release-files-stray"))).status,
      ).toBe(404);
    } finally {
      await env.ARCHIVE.delete("node-images/release-files-stray/pgcf-agent");
    }
  });

  it("answers HEAD with the size and no body", async () => {
    const r = await registered();
    const response = await get(r.path("pgcf-wal-fetch"), {}, "HEAD");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(
      String(r.body("pgcf-wal-fetch").byteLength),
    );
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await response.text()).toBe("");
  });

  it("answers a range with 206 and the bytes asked for, and refuses one beyond the file with 416", async () => {
    const r = await registered();
    const whole = r.body("pgcf-archive"),
      size = whole.byteLength;
    const range = async (value: string) => {
      const response = await get(r.path("pgcf-archive"), { Range: value });
      return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
    };
    let answer = await range("bytes=2-5");
    expect(answer.response.status).toBe(206);
    expect(answer.response.headers.get("Content-Range")).toBe(
      `bytes 2-5/${size}`,
    );
    expect(answer.response.headers.get("Content-Length")).toBe("4");
    expect(answer.bytes).toEqual(whole.slice(2, 6));
    answer = await range("bytes=3-");
    expect(answer.response.headers.get("Content-Range")).toBe(
      `bytes 3-${size - 1}/${size}`,
    );
    expect(answer.bytes).toEqual(whole.slice(3));
    answer = await range("bytes=-4");
    expect(answer.response.headers.get("Content-Range")).toBe(
      `bytes ${size - 4}-${size - 1}/${size}`,
    );
    expect(answer.bytes).toEqual(whole.slice(-4));
    // The end is clamped to the file.
    answer = await range(`bytes=1-${size + 100}`);
    expect(answer.response.headers.get("Content-Range")).toBe(
      `bytes 1-${size - 1}/${size}`,
    );
    answer = await range(`bytes=${size}-`);
    expect(answer.response.status).toBe(416);
    expect(answer.response.headers.get("Content-Range")).toBe(
      `bytes */${size}`,
    );
    // A range HEAD asks for is described and not sent.
    const head = await get(
      r.path("pgcf-archive"),
      { Range: "bytes=2-5" },
      "HEAD",
    );
    expect(head.status).toBe(206);
    expect(head.headers.get("Content-Range")).toBe(`bytes 2-5/${size}`);
    expect(await head.text()).toBe("");
  });

  it("sends the whole file for a range it does not understand", async () => {
    const r = await registered();
    for (const value of [
      "bytes=0-1,4-5",
      "items=0-1",
      "bytes=a-b",
      "bytes=5-2",
      "bytes=",
      "0-1",
    ]) {
      const response = await get(r.path("pgcf-archive"), { Range: value });
      expect(response.status, value).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer()), value).toEqual(
        r.body("pgcf-archive"),
      );
    }
  });
});

describe("parsing a byte range", () => {
  it("resolves the first range of a single-range header against the size", () => {
    expect(parseByteRange("bytes=0-0", 10)).toEqual({ offset: 0, length: 1 });
    expect(parseByteRange("bytes=2-", 10)).toEqual({ offset: 2, length: 8 });
    expect(parseByteRange("bytes=-3", 10)).toEqual({ offset: 7, length: 3 });
    expect(parseByteRange("bytes=-30", 10)).toEqual({ offset: 0, length: 10 });
    expect(parseByteRange("bytes=8-100", 10)).toEqual({ offset: 8, length: 2 });
    expect(parseByteRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=-0", 10)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=0-0", 0)).toBe("unsatisfiable");
    expect(parseByteRange(null, 10)).toBeNull();
    for (const value of [
      "bytes=1-2,4-5",
      "bytes=2-1",
      "bytes=x",
      "bytes=1-2-3",
      "bytes=01a-2",
      "bytes=-",
      "bytes=9007199254740993-",
    ])
      expect(parseByteRange(value, 10), value).toBeNull();
  });
});

describe("the image", () => {
  const image = "pgcf-node.raw.zst";
  /** An install of this release: the tokens the installer carries in its userData. */
  async function installing(version: string) {
    const a = await auditedAddition();
    const issued = await issueNodeInstall(env, {
      node_id: a.id,
      image_version: version,
      sources,
    });
    return { ...a, issued };
  }

  it("is read with the install's progress token and with no other credential", async () => {
    const r = await registered();
    const i = await installing(r.version);
    const path = r.path(image);
    expect((await get(path)).status).toBe(401);
    for (const token of [
      "",
      "pgcf_pt_" + "x".repeat(43),
      // The enrollment token is the node's, not the installer's.
      i.issued.enrollment_token,
      // A management key is not an install token.
      r.f.admin,
    ])
      expect((await get(path, bearer(token))).status, token).toBe(401);
    expect(
      (await get(path, { Authorization: i.issued.progress_token })).status,
    ).toBe(401);
    const response = await get(path, bearer(i.issued.progress_token));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(r.body(image));
    expect(await refusal(await get(path))).toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });

  it("answers HEAD and ranges to the installer as it does to anyone", async () => {
    const r = await registered();
    const i = await installing(r.version);
    const headers = bearer(i.issued.progress_token);
    const head = await get(r.path(image), headers, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(
      String(r.body(image).byteLength),
    );
    expect((await get(r.path(image), {}, "HEAD")).status).toBe(401);
    const part = await get(r.path(image), { ...headers, Range: "bytes=1-3" });
    expect(part.status).toBe(206);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(
      r.body(image).slice(1, 4),
    );
    expect((await get(r.path(image), { Range: "bytes=1-3" })).status).toBe(401);
  });

  it("belongs to the release the install was issued for", async () => {
    const r = await registered();
    const other = await registered();
    const i = await installing(r.version);
    expect(
      (await get(other.path(image), bearer(i.issued.progress_token))).status,
    ).toBe(401);
    expect(
      (await get(r.path(image), bearer(i.issued.progress_token))).status,
    ).toBe(200);
  });

  it("is closed to the token once the installer rebooted or failed, once the node enrolled, and once the token expired", async () => {
    const r = await registered();
    const read = async (token: string) =>
      (await get(r.path(image), bearer(token))).status;
    for (const closing of ["rebooting", "failed"]) {
      const i = await installing(r.version);
      expect(await read(i.issued.progress_token)).toBe(200);
      expect((await progress(i.issued.progress_token, "started")).status).toBe(
        200,
      );
      expect(await read(i.issued.progress_token)).toBe(200);
      expect((await progress(i.issued.progress_token, closing)).status).toBe(
        200,
      );
      expect(await read(i.issued.progress_token), closing).toBe(401);
    }
    const enrolled = await installing(r.version);
    await env.DB.prepare(
      "UPDATE node_installs SET enrolled_at=?,enrolled_public_key=?,enrolled_node_uid=? WHERE node_id=?",
    )
      .bind(
        new Date().toISOString(),
        "k".repeat(43),
        crypto.randomUUID(),
        enrolled.id,
      )
      .run();
    expect(await read(enrolled.issued.progress_token)).toBe(401);
    const expired = await installing(r.version);
    await env.DB.prepare(
      "UPDATE node_installs SET issued_at=?,expires_at=? WHERE node_id=?",
    )
      .bind(
        new Date(Date.now() - 3_600_000).toISOString(),
        new Date(Date.now() - 1000).toISOString(),
        expired.id,
      )
      .run();
    expect(await read(expired.issued.progress_token)).toBe(401);
  });

  it("is closed to a token that a new issue replaced", async () => {
    const r = await registered();
    const first = await installing(r.version);
    const again = await issueNodeInstall(env, {
      node_id: first.id,
      image_version: r.version,
      sources,
    });
    expect(
      (await get(r.path(image), bearer(first.issued.progress_token))).status,
    ).toBe(401);
    expect(
      (await get(r.path(image), bearer(again.progress_token))).status,
    ).toBe(200);
  });
});
