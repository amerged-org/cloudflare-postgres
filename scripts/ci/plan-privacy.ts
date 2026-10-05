// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface PlanPrivacyFinding {
  line: number;
  code: "adopter_numeric_inventory";
}

const adopter = /\badopter(?:['’]s)?\b|(?<![\w.])ohmyho\.st\b|\bohmyhost\b/i;
const quantity =
  "(?:[0-9][0-9,]*(?:\\.[0-9]+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|dozen|hundred|thousand)";
const resources =
  "(?:projects?|branch(?:es)?|databases?|dbs?|roles?|tables?|schemas?)";
const resourceCount = new RegExp(
  `\\b${quantity}\\s+(?:(?:active|live|existing|application|postgres(?:ql)?|current|total)\\s+){0,3}${resources}\\b|\\b${resources}(?:\\s+(?:count|total))?\\s*(?:[:=]\\s*)?${quantity}\\b`,
  "i",
);
const inventoryContext =
  /\b(?:inventor(?:y|ied)|catalog(?:ue)?|survey|dataset|footprint|snapshot|estate|existing|current|currently|sampled|inspection|inspected|read-only)\b/i;
const explicitInventory =
  /\b(?:inventor(?:y|ied)|catalog(?:ue)?|survey|dataset|footprint|snapshot|estate|sampled)\b/i;
const goals =
  /\b(?:goal|target|aim|future|can|could|may|should|will|planned|planning)\b/i;
const observed =
  /\b(?:has|have|had|contains|contained|current|currently|existing|sampled|recorded|found|totals?)\b/i;
const measurements =
  /\b(?:benchmark|synthetic|fixture|acceptance|latency|throughput|COPY|load test)\b|SQL\/s/i;
const price =
  /(?:EUR|USD|€|\$)\s*[0-9]|[0-9]\s*(?:EUR|USD)|\b(?:price|cost)\b.*\b(?:month|VPS|operator)\b/i;
const numbers = /\b[0-9][0-9,.]*\b/;
const size = /\b[0-9][0-9,]*(?:\.[0-9]+)?\s*(?:bytes?|[KMGT]i?B)\b/i;
const version =
  /\b(?:PostgreSQL|postgres|engine(?:\s+version)?|versions?)\s*(?:is|was|[:=])?\s*v?[0-9]+(?:\.[0-9]+)*\b/i;
const location = /\b(?:EU|US|Europe|America|EMEA|APAC|regions?|locations?)\b/i;
const pending = /\bpending\b|\bnot yet\b/i;

export function checkPlanPrivacy(text: string): PlanPrivacyFinding[] {
  const findings: PlanPrivacyFinding[] = [];
  let paragraph: string[] = [],
    start = 1;
  const inspect = () => {
    const content = paragraph.join(" ");
    if (!adopter.test(content)) return;
    let attributed = false,
      hasInventoryContext = false;
    const rejected = content.split(/(?<=[.!?])\s+/).some((sentence) => {
      const quantified = resourceCount.test(sentence);
      const direct = adopter.test(sentence);
      if (direct && pending.test(sentence) && !quantified) {
        attributed = false;
        hasInventoryContext = false;
        return false;
      }
      if (
        (measurements.test(sentence) ||
          (price.test(sentence) && !quantified)) &&
        !explicitInventory.test(sentence)
      )
        return false;
      if (
        goals.test(sentence) &&
        !explicitInventory.test(sentence) &&
        !observed.test(sentence)
      )
        return false;
      if (direct) {
        attributed =
          inventoryContext.test(sentence) ||
          observed.test(sentence) ||
          quantified;
        hasInventoryContext = inventoryContext.test(sentence);
      } else if (attributed && inventoryContext.test(sentence)) {
        hasInventoryContext = true;
      }
      if (!direct && !attributed) return false;
      if (quantified) return true;
      return (
        hasInventoryContext &&
        (size.test(sentence) ||
          version.test(sentence) ||
          (numbers.test(sentence) && location.test(sentence)))
      );
    });
    if (rejected)
      findings.push({ line: start, code: "adopter_numeric_inventory" });
  };
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) {
      inspect();
      paragraph = [];
      return;
    }
    // Independent Markdown items cannot inherit a previous item's adopter attribution.
    if (
      /^\s*(?:[-*+]\s|[0-9]+[.)]\s|#{1,6}\s)/.test(line) &&
      paragraph.length
    ) {
      inspect();
      paragraph = [];
    }
    if (!paragraph.length) start = index + 1;
    paragraph.push(line);
  });
  inspect();
  return findings;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1) throw new Error("invalid_arguments");
  const findings = checkPlanPrivacy(
    await readFile(args[0] ?? "PLAN.md", "utf8"),
  );
  console.log(
    JSON.stringify({ event: "plan_privacy", findings: findings.length }),
  );
  process.exitCode = findings.length ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void main().catch(() => {
    console.error(JSON.stringify({ event: "plan_privacy_failed" }));
    process.exitCode = 1;
  });
}
