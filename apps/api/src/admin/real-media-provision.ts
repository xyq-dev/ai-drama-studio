import type { RealMediaConfiguration } from "@ai-drama/contracts";
import type { DatabasePool } from "@ai-drama/database";
/** Explicit operator provisioning only. Runtime constructors/GET requests never invoke this function. */
export async function provisionRealMediaProviders(pool: DatabasePool,
  input: { workspaceId: string; configurations: RealMediaConfiguration[]; enableExisting?: boolean }): Promise<{ ids: string[]; created: number }> {
  if (!/^[a-f0-9-]{36}$/i.test(input.workspaceId) || input.configurations.length > 4) throw new Error("REAL_MEDIA_PROVISION_INVALID");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["real_media_provision:" + input.workspaceId]);
      const workspace = await client.query("SELECT id FROM workspace WHERE id=$1 AND status='ACTIVE' FOR SHARE", [input.workspaceId]);
      if (!workspace.rows[0]) throw new Error("REAL_MEDIA_WORKSPACE_NOT_ACTIVE");
      const ids: string[] = []; let created = 0;
      for (const c of input.configurations) {
        if (!["dashscope-media", "elevenlabs-media"].includes(c.providerKey) || c.credentialRef !== "env:" + c.providerKey) throw new Error("REAL_MEDIA_PROVISION_INVALID");
        const existing = await client.query(
          "SELECT id,enabled,encrypted_credential_ref FROM provider_configuration WHERE workspace_id=$1 AND provider_key=$2 AND capability=$3 FOR UPDATE",
          [input.workspaceId, c.providerKey, c.capability]);
        const row = existing.rows[0];
        if (row) {
          if (row.id !== c.id || row.encrypted_credential_ref !== c.credentialRef || (!row.enabled && !input.enableExisting)) throw new Error("REAL_MEDIA_EXISTING_CONFIGURATION_REQUIRES_REVIEW");
          if (!row.enabled) await client.query("UPDATE provider_configuration SET enabled=true WHERE id=$1 AND workspace_id=$2", [c.id, input.workspaceId]);
        } else {
          await client.query(
            "INSERT INTO provider_configuration(id,workspace_id,provider_key,capability,encrypted_credential_ref,default_timeout_ms,max_attempts) VALUES($1,$2,$3,$4,$5,180000,1)",
            [c.id, input.workspaceId, c.providerKey, c.capability, c.credentialRef]);
          created++;
        }
        ids.push(c.id);
      }
      await client.query("COMMIT");
      return { ids, created };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  } finally { client.release(); }
}
