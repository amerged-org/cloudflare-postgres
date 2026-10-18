// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { INSTALLER_CHECKPOINTS, NodeEnrollmentResponse } from "@pgcf/contracts";
import {
  installSources,
  issueNodeInstall,
  sourceAllowed,
} from "../../src/domain/node-install.ts";
import { cleanupFixtures, nodeRequest, rawRequest } from "./fixtures.ts";
import {
  auditedAddition,
  enroll,
  forgetInstalls,
  installed,
  newKey,
  progress,
  sources,
  v4,
  v6,
} from "./node-fixtures.ts";

afterEach(async () => {
  await forgetInstalls();
  await cleanupFixtures();
});

describe("where an enrollment may come from", () => {
  it("accepts the instance's public IPv4 and nothing else", () => {
    expect(sourceAllowed(v4, sources)).toBe(true);
    for (const other of [
      undefined,
      "",
      "192.0.2.11",
      "192.0.2.010",
      "192.0.2",
      // An address of the instance's IPv6 prefix is not its IPv4.
      v6,
      "2001:db8:1234:5678:abcd::7",
      "::ffff:192.0.2.10",
      "::1",
      "not an address",
      "192.0.2.10 ",
    ])
      expect(sourceAllowed(other, sources), String(other)).toBe(false);
    expect(sourceAllowed(v4, [])).toBe(false);
  });

  it("takes only the IPv4 from the provider's network configuration", () => {
    const dual = { v4: { ip: v4 }, v6: { ip: v6, netmaskCidr: 64 } };
    expect(installSources(dual)).toEqual([v4]);
    expect(installSources({ v4: { ip: v4 } })).toEqual([v4]);
    expect(installSources({ v4: { ip: "" } })).toEqual([]);
  });
});

describe("issuing the tokens of an install", () => {
  it("stores only their hashes and refuses a node that is not being added", async () => {
    const a = await auditedAddition();
    const issued = await issueNodeInstall(env, {
      node_id: a.id,
      image_version: "1.2.0",
      sources,
    });
    expect(issued.enrollment_token).toMatch(/^pgcf_et_[A-Za-z0-9_-]{43}$/);
    expect(issued.progress_token).toMatch(/^pgcf_pt_[A-Za-z0-9_-]{43}$/);
    const row = await env.DB.prepare(
      "SELECT * FROM node_installs WHERE node_id=?",
    )
      .bind(a.id)
      .first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(issued.enrollment_token);
    expect(JSON.stringify(row)).not.toContain(issued.progress_token);
    expect(row).toMatchObject({
      image_version: "1.2.0",
      checkpoints_json: "[]",
      progress_closed_at: null,
      enrolled_at: null,
    });
    expect(Date.parse(issued.expires_at) - Date.now()).toBeLessThanOrEqual(
      1800_000,
    );
    await expect(
      issueNodeInstall(env, {
        node_id: `nod_${"q".repeat(20)}`,
        image_version: "1.2.0",
        sources,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      issueNodeInstall(env, {
        node_id: a.id,
        image_version: "1.2.0",
        sources: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      issueNodeInstall(env, {
        node_id: a.id,
        image_version: "no spaces",
        sources,
      }),
    ).rejects.toThrow();
  });

  it("replaces the tokens of a node that did not enroll, and never those of one that did", async () => {
    const i = await installed();
    const again = await issueNodeInstall(env, {
      node_id: i.id,
      image_version: "1.3.0",
      sources,
    });
    expect(again.enrollment_token).not.toBe(i.issued.enrollment_token);
    // The earlier tokens are void, and the checkpoints start again.
    expect((await progress(i.issued.progress_token, "started")).status).toBe(
      401,
    );
    expect((await enroll(i.request)).status).toBe(401);
    for (const checkpoint of INSTALLER_CHECKPOINTS.filter(
      (c) => c !== "failed",
    ))
      await progress(again.progress_token, checkpoint);
    const request = {
      ...i.request,
      enrollment_token: again.enrollment_token,
      image_version: "1.3.0",
    };
    expect((await enroll(request)).status).toBe(200);
    await expect(
      issueNodeInstall(env, { node_id: i.id, image_version: "1.3.0", sources }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("the installer's progress", () => {
  it("is recorded once per checkpoint and ends with the reboot", async () => {
    const a = await auditedAddition();
    const { progress_token } = await issueNodeInstall(env, {
      node_id: a.id,
      image_version: "1.2.0",
      sources,
    });
    expect((await progress(progress_token, "started")).status).toBe(200);
    // curl retries a report whose answer was lost.
    expect((await progress(progress_token, "started")).status).toBe(200);
    expect((await progress(progress_token, "hardware_ok")).status).toBe(200);
    const stored = JSON.parse(
      (await env.DB.prepare(
        "SELECT checkpoints_json FROM node_installs WHERE node_id=?",
      )
        .bind(a.id)
        .first<{ checkpoints_json: string }>())!.checkpoints_json,
    ) as { checkpoint: string }[];
    expect(stored.map((entry) => entry.checkpoint)).toEqual([
      "started",
      "hardware_ok",
    ]);
    expect((await progress(progress_token, "rebooting")).status).toBe(200);
    // A second run after the reboot is refused before it touches the disk.
    expect((await progress(progress_token, "started")).status).toBe(401);
  });

  it("refuses a body that is not a checkpoint and a token that is not a progress token", async () => {
    const i = await installed([]);
    expect((await progress(i.issued.progress_token, "teapot")).status).toBe(
      400,
    );
    expect((await progress(i.issued.enrollment_token, "started")).status).toBe(
      401,
    );
    expect(
      (await progress(`pgcf_pt_${"a".repeat(43)}`, "started")).status,
    ).toBe(401);
    expect(
      (
        await rawRequest("/node/v1/installer/progress", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ checkpoint: "started", detail: "" }),
        })
      ).status,
    ).toBe(401);
  });

  it("is refused after the install's lifetime and after the node enrolled", async () => {
    const i = await installed([]);
    await env.DB.prepare(
      "UPDATE node_installs SET expires_at=?,issued_at=? WHERE node_id=?",
    )
      .bind(
        new Date(Date.now() - 1000).toISOString(),
        new Date(Date.now() - 2000).toISOString(),
        i.id,
      )
      .run();
    expect((await progress(i.issued.progress_token, "started")).status).toBe(
      401,
    );
  });
});

describe("enrolling a node", () => {
  it("answers the node's identity, keeps its key and burns the token", async () => {
    const i = await installed();
    const response = await enroll(i.request);
    expect(response.status).toBe(200);
    const identity = NodeEnrollmentResponse.parse(await response.json());
    expect(identity).toEqual({
      id: i.id,
      uid: expect.stringMatching(/^[0-9a-f-]{36}$/),
      hostname: i.addition.intent.requested_hostname,
      region_id: i.f.region,
    });
    expect(
      await env.DB.prepare(
        "SELECT region_id,k8s_node_name,provider_instance_id,node_uid,public_key,ready,schedulable,lost_at FROM nodes WHERE id=?",
      )
        .bind(i.id)
        .first(),
    ).toEqual({
      region_id: i.f.region,
      k8s_node_name: i.addition.intent.requested_hostname,
      provider_instance_id: i.instance,
      node_uid: identity.uid,
      public_key: i.publicKey,
      ready: 0,
      schedulable: 0,
      lost_at: null,
    });
    expect(
      await env.DB.prepare(
        "SELECT enrolled_public_key,enrolled_node_uid FROM node_installs WHERE node_id=?",
      )
        .bind(i.id)
        .first(),
    ).toEqual({
      enrolled_public_key: i.publicKey,
      enrolled_node_uid: identity.uid,
    });
    // From now on the node signs its requests with the key it enrolled.
    const call = await nodeRequest(
      { node: i.id, nodeUid: identity.uid, nodeKey: i.key },
      "/node/v1/observations",
      {
        method: "POST",
        body: {
          observed_at: new Date().toISOString(),
          databases: [],
          orders: [],
        },
      },
    );
    expect(call.status).toBe(200);
  });

  it("answers the same identity to a repeat with the same key, and refuses another key", async () => {
    const i = await installed();
    const first = NodeEnrollmentResponse.parse(
      await (await enroll(i.request)).json(),
    );
    const repeat = await enroll(i.request);
    expect(repeat.status).toBe(200);
    expect(NodeEnrollmentResponse.parse(await repeat.json())).toEqual(first);
    const other = await newKey();
    expect(
      (await enroll({ ...i.request, public_key: other.publicKey })).status,
    ).toBe(409);
    expect(
      await env.DB.prepare("SELECT public_key FROM nodes WHERE id=?")
        .bind(i.id)
        .first("public_key"),
    ).toBe(i.publicKey);
  });

  it("is refused for a wrong token, an unknown node and a malformed request", async () => {
    const i = await installed();
    expect(
      (
        await enroll({
          ...i.request,
          enrollment_token: `pgcf_et_${"b".repeat(43)}`,
        })
      ).status,
    ).toBe(401);
    expect(
      (await enroll({ ...i.request, node_id: `nod_${"q".repeat(20)}` })).status,
    ).toBe(401);
    expect((await enroll({ ...i.request, extra: true })).status).toBe(400);
    expect((await enroll({ ...i.request, public_key: "short" })).status).toBe(
      400,
    );
    expect(
      await env.DB.prepare("SELECT 1 FROM nodes WHERE id=?").bind(i.id).first(),
    ).toBeNull();
  });

  it("is refused from another address, without one and for another image version", async () => {
    const i = await installed();
    for (const address of [
      null,
      "192.0.2.99",
      v6,
      "2001:db8:1234:5679::1",
      "::1",
    ])
      expect((await enroll(i.request, address)).status, String(address)).toBe(
        403,
      );
    expect(
      (await enroll({ ...i.request, image_version: "1.2.1" })).status,
    ).toBe(409);
    expect((await enroll(i.request, v4)).status).toBe(200);
  });

  it("waits for every checkpoint of the installer and refuses a failed install", async () => {
    const early = await installed(["started", "hardware_ok", "image_verified"]);
    expect((await enroll(early.request)).status).toBe(409);
    const failed = await installed(["started", "hardware_ok"]);
    await progress(failed.issued.progress_token, "failed", "download");
    expect((await enroll(failed.request)).status).toBe(409);
    expect(
      await env.DB.prepare("SELECT 1 FROM nodes WHERE id IN(?,?)")
        .bind(early.id, failed.id)
        .first(),
    ).toBeNull();
  });

  it("is refused after the token's lifetime, and a refusal does not burn the token", async () => {
    const i = await installed();
    expect((await enroll(i.request, "192.0.2.99")).status).toBe(403);
    expect((await enroll(i.request)).status).toBe(200);
    const late = await installed();
    await env.DB.prepare(
      "UPDATE node_installs SET expires_at=?,issued_at=? WHERE node_id=?",
    )
      .bind(
        new Date(Date.now() - 1000).toISOString(),
        new Date(Date.now() - 2000).toISOString(),
        late.id,
      )
      .run();
    expect((await enroll(late.request)).status).toBe(401);
  });

  it("is refused once the addition was cancelled", async () => {
    const i = await installed();
    await env.DB.prepare(
      "UPDATE node_additions SET status='cancelled',slot_held=0 WHERE node_id=?",
    )
      .bind(i.id)
      .run();
    expect((await enroll(i.request)).status).toBe(409);
  });
});
