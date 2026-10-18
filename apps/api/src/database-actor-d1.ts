// SPDX-License-Identifier: Apache-2.0
// What the DatabaseActor needs to write D1 and tell the region. The statements and the mutation
// pull in the API's domain graph (the router, the OpenAPI documents), which a cold actor must not
// evaluate before it answers an admission: the actor loads this module on first use
// (`d1` in database-actor.ts), after the answer.
export { powerTransitionStatements } from "./domain/lifecycle.ts";
export { hintDatabases } from "./domain/node-hints.ts";
export { readDatabasePresence } from "./domain/database-actor-sync.ts";
export { withAdmissionMutation } from "./domain/admission-mutations.ts";
export { readDatabaseAdmissionSnapshot } from "./domain/database-admission-snapshot.ts";
