// SPDX-License-Identifier: Apache-2.0
/**
 * The success lines written for every host lease (`storage_guard_served`) and every accepted
 * sample (`thin_storage_sample_accepted`) are one request a second per node each, and with them
 * the Worker's largest log volume. Per node and event, one occurrence in `HOT_LOG_EVERY` is
 * written, counted in this isolate, so the count is deterministic for a given request sequence;
 * and so is the first one after a silence of more than `HOT_LOG_GAP_MS`, which makes every
 * recovery and every cold isolate visible. A caller writes a line that shows trouble whatever this
 * says, and still asks it, so that the count and the gap see every occurrence.
 */
const HOT_LOG_EVERY = 30;
const HOT_LOG_GAP_MS = 10_000;
const HOT_LOG_STREAMS = 256;
const streams = new Map<string, { last: number; count: number }>();

/** Whether this occurrence of `event` on `nodeId` is the one in thirty, or the first after a gap. */
export function hotLogDue(
  event: string,
  nodeId: string,
  now = Date.now(),
): boolean {
  const key = `${event}:${nodeId}`;
  let stream = streams.get(key);
  if (!stream || now - stream.last > HOT_LOG_GAP_MS)
    stream = { last: now, count: 0 };
  const due = stream.count === 0;
  stream.count = (stream.count + 1) % HOT_LOG_EVERY;
  stream.last = now;
  // Re-inserting moves the key to the back; a full table drops the stream silent for longest.
  streams.delete(key);
  if (streams.size >= HOT_LOG_STREAMS)
    streams.delete(streams.keys().next().value!);
  streams.set(key, stream);
  return due;
}
