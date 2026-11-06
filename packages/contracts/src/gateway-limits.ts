// SPDX-License-Identifier: Apache-2.0
// The gateway's accounted buffer memory in all. Databases that hold more than their guaranteed
// share compete for what is left after the reserve (192 MiB), so the reserve is the part of the
// total that databases under their guaranteed share can always draw on.
export const DEFAULT_MEMORY_LIMIT_BYTES = 384 * 1024 * 1024;
export const DEFAULT_DATABASE_MEMORY_LIMIT_BYTES = 96 * 1024 * 1024;
export const DEFAULT_MEMORY_RESERVE_BYTES = 192 * 1024 * 1024;
// Twenty sessions of the smallest size class at 144 KiB each, with room for their frames.
export const DEFAULT_DATABASE_GUARANTEED_MEMORY_BYTES = 3 * 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_STARTUP_BUFFER_BYTES = 64 * 1024;
export const DEFAULT_DATABASE_CONNECTION_LIMIT = 200;
export const DEFAULT_TOTAL_CONNECTION_LIMIT = 2_000;
export const MAX_ACTIVITY_RECORDS = 2000;
