// SPDX-License-Identifier: Apache-2.0
export const EVENT_PATTERN_MAX_LENGTH = 64;

const SEGMENT = /^[a-z][a-z_]*$/;

export function isValidEventPattern(pattern: string): boolean {
  if (pattern.length > EVENT_PATTERN_MAX_LENGTH) return false;
  if (pattern === "*") return true;
  const parts = pattern.split(".");
  if (parts.length !== 2) return false;
  const [head, tail] = parts as [string, string];
  return SEGMENT.test(head) && (tail === "*" || SEGMENT.test(tail));
}

export function eventTypeMatches(pattern: string, type: string): boolean {
  if (!isValidEventPattern(pattern)) return false;
  if (pattern === "*") return true;
  const [head, tail] = pattern.split(".") as [string, string];
  if (tail === "*") {
    const parts = type.split(".");
    return parts.length === 2 && parts[0] === head && parts[1] !== "";
  }
  return pattern === type;
}

export function subscriptionWants(
  subscription: {
    event_types: readonly string[];
    database_ids: readonly string[] | null;
  },
  event: { type: string; database_id: string },
): boolean {
  const wantsType = subscription.event_types.some((pattern) =>
    eventTypeMatches(pattern, event.type),
  );
  if (!wantsType) return false;
  return (
    subscription.database_ids === null ||
    subscription.database_ids.includes(event.database_id)
  );
}
