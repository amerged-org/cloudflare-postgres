// SPDX-License-Identifier: Apache-2.0
// Only the relay benchmark's Worker (`bench/rig.ts`): the production Edge entry with the real
// Actor, and the route that seeds a database.
import edge from "../src/index.ts";
import { withSeed } from "./bench-seed.js";
export { RegionLink } from "../../api/src/region-link.ts";
export { DatabaseActor } from "../../api/src/database-actor.ts";

export default withSeed(edge);
