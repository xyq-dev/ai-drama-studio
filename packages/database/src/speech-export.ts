import type { PoolClient,QueryResultRow } from "pg";
import { speechVoiceSchema,type SpeechVoiceRevision } from "@ai-drama/contracts";
import { speechExactHash } from "@ai-drama/domain";
import { PersistenceError } from "./job-service";
/** Portable, verified voice snapshots; credential references and current mutable character names are never projected. */
export async function speechExportVoices(client:PoolClient,workspaceId:string,projectId:string,voiceRevisionIds:readonly string[]):Promise<Array<{speakerId:string;voiceRevision:SpeechVoiceRevision}>>{
  const ids=[...new Set(voiceRevisionIds)].sort();if(!ids.length)return [];
  const result=await client.query<QueryResultRow>(`SELECT v.id,v.binding_id,v.content_hash,v.voice_json,v.provider_configuration_id,b.speaker_id,pc.provider_key
    FROM speech_voice_revision v JOIN speech_voice_binding b ON b.id=v.binding_id AND b.workspace_id=v.workspace_id AND b.project_id=v.project_id
    JOIN provider_configuration pc ON pc.id=v.provider_configuration_id AND pc.workspace_id=v.workspace_id
    WHERE v.workspace_id=$1 AND v.project_id=$2 AND v.id=ANY($3::uuid[]) ORDER BY v.id FOR SHARE OF v,b,pc`,[workspaceId,projectId,ids]);
  if(result.rows.length!==ids.length)throw new PersistenceError("COMPOSE_INPUT_INVALID","Frozen export voice revision is missing");
  return result.rows.map(row=>{
    const parsed=speechVoiceSchema.safeParse(row.voice_json);
    if(!parsed.success||speechExactHash(parsed.data)!==row.content_hash||parsed.data.providerConfigurationId!==row.provider_configuration_id||parsed.data.providerKey!==row.provider_key)throw new PersistenceError("COMPOSE_INPUT_INVALID","Frozen export voice snapshot is inconsistent");
    return {speakerId:String(row.speaker_id),voiceRevision:{...parsed.data,id:String(row.id),bindingId:String(row.binding_id),contentHash:String(row.content_hash)}};
  });
}
