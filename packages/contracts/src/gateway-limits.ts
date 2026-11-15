// SPDX-License-Identifier: Apache-2.0
// The gateway's accounted buffer memory in all. A database within its guaranteed share may draw on
// all of it; beyond the share a database competes only for what is left after the reserve (96
// MiB), which one database can occupy alone. The reserve covers the guaranteed share of reserve /
// share = 32 databases at or below their share; beyond 32 the gateway logs it and a database at
// its share may be refused when the shared part is full.
export const DEFAULT_MEMORY_LIMIT_BYTES = 192 * 1024 * 1024;
export const DEFAULT_DATABASE_MEMORY_LIMIT_BYTES = 96 * 1024 * 1024;
export const DEFAULT_MEMORY_RESERVE_BYTES = 96 * 1024 * 1024;
// Twenty sessions of the smallest size class at 144 KiB each, with room for their frames.
export const DEFAULT_DATABASE_GUARANTEED_MEMORY_BYTES = 3 * 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_STARTUP_BUFFER_BYTES = 64 * 1024;
export const DEFAULT_DATABASE_CONNECTION_LIMIT = 200;
export const DEFAULT_TOTAL_CONNECTION_LIMIT = 2_000;
export const MAX_ACTIVITY_RECORDS = 2000;
