// SPDX-License-Identifier: Apache-2.0
import { createHash, X509Certificate } from "node:crypto";
import { record, uid, type Kubernetes, type Resource } from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CACHE_MS = 30_000,
  CACHE_MAX = 1000;
export interface KubeletTrust {
  certificatePem: string;
  leafSha256: string;
  serverName: string;
  validUntil: number;
}

export function validateKubeletTrust(
  resource: Resource,
  node: Resource,
  clusterUid: string,
  now: number,
): KubeletTrust {
  try {
    const data = record(resource.data),
      certificatePem = data.certificate_pem;
    if (
      !Number.isSafeInteger(now) ||
      !UUID.test(uid(node)) ||
      !UUID.test(clusterUid) ||
      node.kind !== "Node" ||
      node.metadata.deletionTimestamp ||
      resource.kind !== "ConfigMap" ||
      resource.apiVersion !== "v1" ||
      resource.metadata.namespace !== "pgcf-system" ||
      resource.metadata.name !== `kubelet-${uid(node)}` ||
      !resource.metadata.uid ||
      !resource.metadata.resourceVersion ||
      resource.metadata.deletionTimestamp ||
      resource.metadata.labels?.["pgcf.io/kubelet-node-uid"] !== uid(node) ||
      data.node_name !== node.metadata.name ||
      data.node_uid !== uid(node) ||
      data.cluster_uid !== clusterUid ||
      typeof certificatePem !== "string" ||
      Buffer.byteLength(certificatePem, "utf8") > 16 * 1024 ||
      /PRIVATE KEY/.test(certificatePem) ||
      typeof data.certificate_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(data.certificate_sha256) ||
      createHash("sha256").update(certificatePem, "utf8").digest("hex") !==
        data.certificate_sha256
    )
      throw new Error();
    const blocks = certificatePem.match(
      /-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/g,
    );
    if (
      !blocks?.length ||
      blocks.length > 8 ||
      certificatePem
        .replace(
          /-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/g,
          "",
        )
        .trim()
    )
      throw new Error();
    const certificates = blocks.map((block) => new X509Certificate(block));
    if (
      certificates[0]!.checkHost(node.metadata.name, {
        subject: "never",
        wildcards: false,
      }) !== node.metadata.name
    )
      throw new Error();
    let validUntil = Number.MAX_SAFE_INTEGER;
    for (const certificate of certificates) {
      const from = Date.parse(certificate.validFrom),
        to = Date.parse(certificate.validTo);
      if (
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(to) ||
        now < from ||
        now >= to
      )
        throw new Error();
      validUntil = Math.min(validUntil, to);
    }
    return {
      certificatePem,
      leafSha256: createHash("sha256")
        .update(certificates[0]!.raw)
        .digest("hex"),
      serverName: node.metadata.name,
      validUntil,
    };
  } catch {
    throw new Error("kubelet_trust_invalid");
  }
}

export class KubeletTrustReader {
  private readonly cache = new Map<
    string,
    {
      clusterUid: string;
      nodeName: string;
      observedAt: number;
      trust: KubeletTrust | null;
    }
  >();
  private readonly readResource: Kubernetes["read"];
  private readonly now: () => number;
  constructor(readResource: Kubernetes["read"], now: () => number = Date.now) {
    this.readResource = readResource;
    this.now = now;
  }
  async read(node: Resource): Promise<KubeletTrust | null> {
    const now = this.now();
    if (
      !Number.isSafeInteger(now) ||
      !UUID.test(uid(node)) ||
      node.kind !== "Node" ||
      node.metadata.deletionTimestamp
    )
      throw new Error("kubelet_trust_invalid");
    let namespace: Resource | null;
    try {
      namespace = await this.readResource(
        "Namespace",
        undefined,
        "kube-system",
      );
    } catch {
      throw new Error("kubelet_trust_unavailable");
    }
    if (
      !namespace ||
      namespace.kind !== "Namespace" ||
      namespace.metadata.name !== "kube-system" ||
      namespace.metadata.deletionTimestamp ||
      !UUID.test(uid(namespace))
    )
      throw new Error("kubelet_trust_invalid");
    const clusterUid = uid(namespace),
      key = uid(node),
      prior = this.cache.get(key);
    if (
      prior &&
      prior.clusterUid === clusterUid &&
      prior.nodeName === node.metadata.name &&
      now >= prior.observedAt &&
      now - prior.observedAt < CACHE_MS
    ) {
      if (prior.trust && now >= prior.trust.validUntil) {
        this.cache.delete(key);
        throw new Error("kubelet_trust_invalid");
      }
      return prior.trust ? { ...prior.trust } : null;
    }
    this.cache.delete(key);
    let resource: Resource | null;
    try {
      resource = await this.readResource(
        "ConfigMap",
        "pgcf-system",
        `kubelet-${key}`,
      );
    } catch {
      throw new Error("kubelet_trust_unavailable");
    }
    const trust = resource
      ? validateKubeletTrust(resource, node, clusterUid, now)
      : null;
    if (resource) {
      let currentNamespace: Resource | null;
      try {
        currentNamespace = await this.readResource(
          "Namespace",
          undefined,
          "kube-system",
        );
      } catch {
        throw new Error("kubelet_trust_unavailable");
      }
      if (
        !currentNamespace ||
        currentNamespace.metadata.uid !== clusterUid ||
        currentNamespace.metadata.deletionTimestamp
      )
        throw new Error("kubelet_trust_invalid");
    }
    if (this.cache.size >= CACHE_MAX)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, {
      clusterUid,
      nodeName: node.metadata.name,
      observedAt: now,
      trust,
    });
    return trust ? { ...trust } : null;
  }
}
