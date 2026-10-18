// SPDX-License-Identifier: Apache-2.0
// The bounds of the measurement bodies a node sends (`native/measurements.generated.json` holds
// them for the node agent): at most this many records and bytes in one body.
export const MEASUREMENT_COHORT = 25,
  MEASUREMENT_BODY_BYTES = 64 * 1024;
