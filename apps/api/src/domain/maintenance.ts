// SPDX-License-Identifier: Apache-2.0
import {
  DatabaseId,
  ProjectId,
  Timestamp,
  newRolePassword,
} from "@pgcf/contracts";
import { MAINTENANCE_ROLE } from "@pgcf/contracts/maintenance";
import { encryptPassword, type EncryptedPassword } from "../crypto/keyring.ts";

export function generateMaintenanceCredential(
  secret: string,
  databaseId: string,
): Promise<EncryptedPassword> {
  DatabaseId.parse(databaseId);
  return encryptPassword(
    secret,
    databaseId,
    MAINTENANCE_ROLE,
    newRolePassword(),
  );
}
export interface MaintenanceCreationSnapshot {
  databaseId: string;
  projectId: string;
  createdAt: string;
  creationGeneration: 1;
}
/** Place immediately after databaseInsertStatement in the same atomic D1 batch. */
export function maintenanceCreationStatement(
  db: D1Database,
  input: MaintenanceCreationSnapshot,
  encrypted: EncryptedPassword,
): D1PreparedStatement {
  DatabaseId.parse(input.databaseId);
  ProjectId.parse(input.projectId);
  Timestamp.parse(input.createdAt);
  if (input.creationGeneration !== 1)
    throw new TypeError("Maintenance creation requires the initial generation");
  return db
    .prepare(
      `INSERT INTO maintenance_credentials(database_id,password_ciphertext,password_iv,password_kid,password_revision,created_at)
    SELECT id,?,?,?,1,created_at FROM databases WHERE changes()=1 AND id=? AND project_id=? AND generation=? AND created_at=? AND desired_state='running'
    AND NOT EXISTS(SELECT 1 FROM roles WHERE database_id=? AND name=?)
    ON CONFLICT(database_id) DO NOTHING`,
    )
    .bind(
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.kid,
      input.databaseId,
      input.projectId,
      input.creationGeneration,
      input.createdAt,
      input.databaseId,
      MAINTENANCE_ROLE,
    );
}
