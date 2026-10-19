// SPDX-License-Identifier: Apache-2.0

/**
 * Runs `task` for each of `items` in order, `concurrency` at a time, none twice, and starts none
 * once `until` (epoch milliseconds) has passed: a deadline stops new starts only, not the ones in
 * flight. The first failure stops the starts too; the tasks in flight finish, and the failure is
 * thrown. Returns how many items were started, which are the first ones, and all of them ended.
 */
export async function eachBounded<T>(
  items: readonly T[],
  concurrency: number,
  until: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<number> {
  const state: { next: number; failure?: { cause: unknown } } = { next: 0 };
  const worker = async () => {
    while (
      state.failure === undefined &&
      state.next < items.length &&
      Date.now() < until
    ) {
      const index = state.next++;
      try {
        await task(items[index]!, index);
      } catch (cause) {
        state.failure ??= { cause };
        return;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  if (state.failure) throw state.failure.cause;
  return state.next;
}
