// SPDX-License-Identifier: Apache-2.0
export { DatabaseActor } from "../../api/src/database-actor.ts";
export { default } from "../src/index.ts";
import { readDatabasePresence } from "../../api/src/domain/database-actor-sync.ts";

// Trusted fixture setup only; the Edge request entry never seeds actors.
export async function seedKnownDatabase(db, namespace, id) {
  const snapshot = await readDatabasePresence(db, id);
  if (!snapshot) throw new Error("database_fixture_missing");
  await namespace.get(namespace.idFromName(id)).seed(snapshot);
}
