// SPDX-License-Identifier: Apache-2.0

/**
 * A conjunction as a balanced tree. SQLite parses a plain AND chain left-deep, a tree as deep as the
 * chain is long, refuses one deeper than 100 (D1 too), and counts every nested subquery on top of
 * its own conditions. The thin authority predicates and the wake transition are embedded in
 * statements that nest already: they build their conditions with this.
 */
export function allOf(...terms: string[]): string {
  if (terms.length === 0) return "1";
  if (terms.length === 1) return terms[0]!;
  const half = Math.ceil(terms.length / 2);
  return `(${allOf(...terms.slice(0, half))} AND ${allOf(...terms.slice(half))})`;
}
