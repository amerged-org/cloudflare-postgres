// SPDX-License-Identifier: Apache-2.0
const LEGACY_MARKER = /^[a-f0-9]{48}$/;
const SEGMENTED_MARKER = /^[a-f0-9]{16}\.[a-f0-9]{16}\.[a-f0-9]{16}$/;

export function isTraceMarker(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ((value.length === 48 && LEGACY_MARKER.test(value)) ||
      (value.length === 50 && SEGMENTED_MARKER.test(value)))
  );
}

export function formatTraceMarker(entropy: string): string {
  if (
    typeof entropy !== "string" ||
    entropy.length !== 48 ||
    !LEGACY_MARKER.test(entropy)
  )
    throw new TypeError("invalid_trace_marker");
  // Dot separators preserve every random byte without a contiguous hex-token match.
  return `${entropy.slice(0, 16)}.${entropy.slice(16, 32)}.${entropy.slice(32)}`;
}
