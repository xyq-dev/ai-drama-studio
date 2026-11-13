import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { RealMediaConfiguration, RealMediaQuote, RealMediaSnapshot } from "@ai-drama/contracts";
import { assertRealMediaInput,estimateRealMedia, realMediaAmountUnits, realMediaInputHash } from "@ai-drama/domain";
import { PersistenceError, type DatabasePool, type CreatedWorkflowJob } from "./job-service";

export type FrozenRealMediaInput = Omit<RealMediaSnapshot, "budget">;
export type RealMediaReceiptState = "INTENT" | "ACKNOWLEDGED" | "UNKNOWN" | "SUCCEEDED" | "FAILED" | "REJECTED";
export interface RealMediaExecution {
  workspaceId: string; projectId: string; shotRevisionId: string; jobId: string; dispatchSeq: number;
  state: string; cancelRequested: boolean; inputHash: string; inputSnapshot: RealMediaSnapshot;
  attemptId: string | null; providerRequestId: string | null; receiptState: RealMediaReceiptState | null;
  outputs: unknown[] | null;
}
export interface RealMediaReceiptOutput {
  kind: string;
  retrieval: { kind: "URI"; uri: string; expiresAt?: string } | { kind: "HANDLE"; handle: string };
  mimeTypeHint?: string;
  metadata?: Record<string, unknown>;
}
/** Additional tables live only in prisma/drafts. No default migration or startup write is performed. */
export interface ReceiptCipher { seal(value: unknown): string; open(ciphertext: string): unknown }

/** Only existing objects served by the managed real-media storage route may leave the application as references. */
export const COMFYUI_REFERENCE_ASSET_FILTER = `asset.kind='IMAGE' AND asset.status='ACTIVE'
  AND asset.storage_provider='s3' AND asset.mime_type='image/png' AND asset.byte_size BETWEEN 1 AND 8388608
  AND cardinality(string_to_array(asset.object_key,'/'))=6
  AND split_part(asset.object_key,'/',1)='real-media'
  AND split_part(asset.object_key,'/',2)=asset.workspace_id::text
  AND split_part(asset.object_key,'/',3)=asset.project_id::text
  AND split_part(asset.object_key,'/',4) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  AND split_part(asset.object_key,'/',5) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  AND asset.checksum_sha256 ~ '^[a-f0-9]{64}$'
  AND split_part(asset.object_key,'/',6)=(asset.checksum_sha256||'.png')`;

export async function freezeComfyUiReference(
  client: PoolClient,
  scope: { workspaceId: string; projectId: string },
  assetId: string,
  expectedRowVersion?: number,
): Promise<{ assetId: string; checksumSha256: string; rowVersion: number }> {
  const result = await client.query<{ id: string; checksum_sha256: string; row_version: number }>(
    `SELECT asset.id, asset.checksum_sha256, asset.row_version
       FROM asset
      WHERE asset.id=$1 AND asset.workspace_id=$2 AND asset.project_id=$3
        AND ($4::integer IS NULL OR asset.row_version=$4) AND ${COMFYUI_REFERENCE_ASSET_FILTER}
      FOR SHARE OF asset`,
    [assetId, scope.workspaceId, scope.projectId, expectedRowVersion ?? null],
  );
  const asset = result.rows[0];
  if (!asset) throw new PersistenceError("REAL_MEDIA_SOURCE_INVALID", "Reference image is unavailable in this project");
  return { assetId: asset.id, checksumSha256: asset.checksum_sha256, rowVersion: asset.row_version };
}

export const COMFYUI_PENDING_JOB_MESSAGES = {
  COMFYUI_QUEUED: "The ComfyUI request is queued",
  COMFYUI_RUNNING: "ComfyUI is generating the image",
  COMFYUI_PROGRESS_UNAVAILABLE: "The original ComfyUI request is retained; progress is temporarily unavailable",
  COMFYUI_RESULT_DOWNLOAD_FAILED: "The generated image could not be retrieved; delivery will retry the original request",
  COMFYUI_RESULT_STORAGE_FAILED: "The generated image could not be stored; delivery will retry without regenerating",
  COMFYUI_CANCEL_UNSUPPORTED: "Safe targeted cancellation is unavailable for this ComfyUI request",
  COMFYUI_CANCEL_RUNNING_UNSUPPORTED: "Safe targeted cancellation is unavailable while this ComfyUI request is running",
  COMFYUI_CANCEL_NOT_CONFIRMED: "ComfyUI did not confirm cancellation; the original request remains open",
} as const;
export type ComfyUiPendingJobCode = keyof typeof COMFYUI_PENDING_JOB_MESSAGES;
export type ComfyUiCancelDenial = Extract<ComfyUiPendingJobCode, `COMFYUI_CANCEL_${string}`>;
const COMFYUI_CANCELLATION_PROOF_KEY = "comfyui:targeted-cancel-confirmed:v1";

export class RealMediaStore {
  constructor(private readonly pool: DatabasePool, private readonly options: { receiptCipher?: ReceiptCipher } = {}) {}
  receiptReady(): boolean { return Boolean(this.options.receiptCipher); }

  async storageReady(inTransaction?:PoolClient): Promise<boolean> {
    const inspect=async (client:PoolClient) => {
      const result = await client.query(`SELECT obj_description(to_regclass('real_media_authorization'),'pg_class')='ads.real-media.authorization.v1'
        AND obj_description(to_regclass('real_media_submission'),'pg_class')='ads.real-media.submission.v1' AS ready`);
      return result.rows[0]?.ready === true;
    };
    return inTransaction?inspect(inTransaction):this.connection(inspect);
  }
  async requireReady(client?:PoolClient): Promise<void> {
    if (!await this.storageReady(client)) throw new PersistenceError("REAL_MEDIA_STORAGE_NOT_READY", "Real media storage is not provisioned");
  }
  async costExposure(workspaceId:string,projectId:string):Promise<{actualCost:"unknown";unknownSubmissionCount:number;currencies:Array<{currency:string;reservedEstimatedAmount:string;reservedMaximumAmount:string}>}>{
    await this.requireReady();
    return this.connection(async client=>{
      const found=await client.query("SELECT id FROM project WHERE id=$1 AND workspace_id=$2",[projectId,workspaceId]);
      if(!found.rows[0])throw new PersistenceError("NOT_FOUND","Project not found");
      const result=await client.query(`SELECT s.currency,SUM(s.estimated_amount)::text AS amount,SUM(a.maximum_amount)::text AS maximum
        FROM real_media_submission s JOIN real_media_authorization a ON a.job_id=s.generation_job_id
        WHERE s.workspace_id=$1 AND s.project_id=$2 AND s.provider_request_id IS NULL AND s.state<>'REJECTED' GROUP BY s.currency ORDER BY s.currency`,[workspaceId,projectId]);
      // Known request IDs have an estimated ledger entry; count their uncertain outcome without reserving that estimate twice.
      const uncertain=await client.query(`SELECT count(*)::int AS count FROM real_media_submission
        WHERE workspace_id=$1 AND project_id=$2 AND (state='UNKNOWN' OR (state='INTENT' AND provider_request_id IS NULL))`,[workspaceId,projectId]);
      return {actualCost:"unknown",unknownSubmissionCount:Number(uncertain.rows[0]?.count??0),
        currencies:result.rows.map(row=>({currency:String(row.currency),reservedEstimatedAmount:String(row.amount),reservedMaximumAmount:String(row.maximum)}))};
    });
  }
  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.connection(async (client) => {
      await client.query("BEGIN");
      try { const result = await work(client); await client.query("COMMIT"); return result; }
      catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    });
  }
  private async connection<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { return await work(client); } finally { client.release(); }
  }
  async createQuote(input: { workspaceId: string; projectId: string; actorId: string; frozen: FrozenRealMediaInput;
    lifetimeMs?: number }): Promise<RealMediaQuote> {
    await this.requireReady();
    assertRealMediaInput(input.frozen);
    const configuration = input.frozen.configuration;
    if (!configuration.enabled) throw new PersistenceError("REAL_MEDIA_PROVIDER_DISABLED", "Real media submission is disabled");
    const amount = estimateRealMedia(configuration, input.frozen.sourceText);
    const limit=configuration.maximumOperationAmount??amount;
    if(realMediaAmountUnits(limit)<realMediaAmountUnits(amount))throw new PersistenceError("REAL_MEDIA_BUDGET_MISMATCH","Estimate exceeds the operator's single-operation limit");
    const quoteId = randomUUID(); const inputHash = realMediaInputHash(input.frozen);
    const expiresAt = new Date(Date.now() + Math.min(input.lifetimeMs ?? 300_000, 900_000)).toISOString();
    const uncertainJobIds=await this.transaction(async (client) => {
      await lockProject(client,input.workspaceId,input.projectId);
      const uncertain=await uncertainJobs(client,input.workspaceId,input.projectId,input.frozen);
      await client.query(
      `INSERT INTO real_media_authorization
       (quote_id,workspace_id,project_id,shot_revision_id,actor_id,input_hash,input_snapshot,configuration_snapshot,
        currency,estimated_amount,maximum_amount,quote_limit_amount,expires_at,uncertain_job_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::numeric,$10::numeric,$12::numeric,$11::timestamptz,$13::uuid[])`,
      [quoteId,input.workspaceId,input.projectId,input.frozen.shotRevisionId,input.actorId,inputHash,
        JSON.stringify(input.frozen),JSON.stringify(configuration),configuration.currency,amount,expiresAt,limit,uncertain]); return uncertain; });
    return { quoteId,inputHash,capability:configuration.capability,currency:configuration.currency,estimatedAmount:amount,
      maximumAmount:limit,expiresAt,providerConfigurationId:configuration.id,providerConfigurationVersion:configuration.version,
      priceVersion:configuration.priceVersion,actualCost:"unknown",singleOperation:true,uncertainJobIds };
  }
  async authorize(input: { workspaceId: string; projectId: string; actorId: string; quoteId: string; maximumAmount: string;confirmedUncertainJobIds?:string[] }): Promise<{ budgetAuthorizationId: string; quoteId: string }> {
    await this.requireReady();
    return this.transaction(async (client) => {
      await lockProject(client,input.workspaceId,input.projectId);
      const confirmed=sortedIds(input.confirmedUncertainJobIds??[]);
      const result = await client.query("SELECT * FROM real_media_authorization WHERE quote_id=$1 AND workspace_id=$2 AND project_id=$3 AND actor_id=$4 FOR UPDATE", [input.quoteId,input.workspaceId,input.projectId,input.actorId]);
      const row = result.rows[0];
      if (!row) throw new PersistenceError("REAL_MEDIA_QUOTE_EXPIRED", "Quote expired or unavailable");
      const maximum=realMediaAmountUnits(input.maximumAmount);
      if(maximum<realMediaAmountUnits(String(row.estimated_amount))||maximum>realMediaAmountUnits(String(row.quote_limit_amount)))throw new PersistenceError("REAL_MEDIA_BUDGET_MISMATCH","Confirmed maximum is outside this quote's bounds");
      if (row.authorization_id) {
        if(maximum!==realMediaAmountUnits(String(row.maximum_amount))||!sameIds(confirmed,row.confirmed_uncertain_job_ids??[]))throw new PersistenceError("REAL_MEDIA_BUDGET_MISMATCH","This quote already has a different confirmed maximum");
        return { budgetAuthorizationId:String(row.authorization_id),quoteId:input.quoteId };
      }
      if(new Date(row.expires_at).getTime()<=Date.now())throw new PersistenceError("REAL_MEDIA_QUOTE_EXPIRED","Quote expired or unavailable");
      const current=await uncertainJobs(client,input.workspaceId,input.projectId,row.input_snapshot as FrozenRealMediaInput);
      if(!sameIds(confirmed,row.uncertain_job_ids??[])||!sameIds(current,row.uncertain_job_ids??[]))throw new PersistenceError("REAL_MEDIA_UNCERTAIN_CHANGED","Original unknown operations changed; review a new quote and possible duplicate fees");
      const id = randomUUID();
      await client.query("UPDATE real_media_authorization SET authorization_id=$2, authorized_at=now(),maximum_amount=$3::numeric,confirmed_uncertain_job_ids=$4::uuid[] WHERE quote_id=$1 AND authorization_id IS NULL", [input.quoteId,id,input.maximumAmount,confirmed]);
      return { budgetAuthorizationId:id,quoteId:input.quoteId };
    });
  }
  async consumeAuthorization(client: PoolClient, input: { workspaceId:string; projectId:string; actorId:string;
    quoteId:string; budgetAuthorizationId:string; expectedInputHash?:string }): Promise<RealMediaSnapshot> {
    await lockProject(client,input.workspaceId,input.projectId);
    const result = await client.query("SELECT * FROM real_media_authorization WHERE quote_id=$1 AND authorization_id=$2 AND workspace_id=$3 AND project_id=$4 AND actor_id=$5 FOR UPDATE", [input.quoteId,input.budgetAuthorizationId,input.workspaceId,input.projectId,input.actorId]);
    const row = result.rows[0];
    if (!row || !row.authorized_at || row.job_id || new Date(row.expires_at).getTime() <= Date.now()) throw new PersistenceError("REAL_MEDIA_AUTHORIZATION_INVALID", "Single-operation authorization expired or consumed");
    if (input.expectedInputHash && row.input_hash !== input.expectedInputHash) throw new PersistenceError("REAL_MEDIA_INPUT_CHANGED", "Input changed since quote");
    const frozen = row.input_snapshot as FrozenRealMediaInput;
    if (!frozen.configuration.enabled || realMediaInputHash(frozen) !== row.input_hash) throw new PersistenceError("REAL_MEDIA_INPUT_CHANGED", "Frozen quote is invalid");
    const current=await uncertainJobs(client,input.workspaceId,input.projectId,frozen);
    if(!sameIds(current,row.confirmed_uncertain_job_ids??[]))throw new PersistenceError("REAL_MEDIA_UNCERTAIN_CHANGED","Unknown operations changed after confirmation; obtain a new quote");
    return { ...frozen,budget:{authorizationId:input.budgetAuthorizationId,quoteId:input.quoteId,currency:row.currency,
      estimatedAmount:String(row.estimated_amount),maximumAmount:String(row.maximum_amount),priceVersion:frozen.configuration.priceVersion,
      authorizedBy:input.actorId,authorizedAt:new Date(row.authorized_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString(),confirmedUncertainJobIds:sortedIds(row.confirmed_uncertain_job_ids??[])} };
  }
  async bindAuthorization(client: PoolClient, quoteId:string, created:CreatedWorkflowJob): Promise<void> {
    const result = await client.query("UPDATE real_media_authorization SET job_id=$2 WHERE quote_id=$1 AND job_id IS NULL AND authorization_id IS NOT NULL", [quoteId,created.jobId]);
    if (result.rowCount !== 1) throw new PersistenceError("REAL_MEDIA_AUTHORIZATION_INVALID", "Authorization already consumed");
  }
  async beginSubmission(input: { execution:RealMediaExecution; attemptId:string;leaseOwner:string;characterReferenceGate?:"legacy"|"strict";
    validateInTransaction:(client:PoolClient)=>Promise<void> }): Promise<boolean> {
    return this.transaction(async (client) => {
      const e=input.execution;
      if(e.inputSnapshot.capability==="video.generate"&&(input.characterReferenceGate==="strict"||e.inputSnapshot.characterReferenceGate==="strict"))throw new PersistenceError("REAL_MEDIA_REFERENCE_PROFILE_UNSUPPORTED","Strict character reference production is unavailable for the fixed first-frame video profile");
      await lockProject(client,e.workspaceId,e.projectId);
      await input.validateInTransaction(client);
      const uncertain=await uncertainJobs(client,e.workspaceId,e.projectId,e.inputSnapshot,e.jobId);
      if(!sameIds(uncertain,e.inputSnapshot.budget.confirmedUncertainJobIds??[]))throw new PersistenceError("REAL_MEDIA_UNCERTAIN_CHANGED","A possible duplicate operation appeared before sending; obtain a new quote");
      const bound=await client.query(`SELECT j.id FROM generation_job j JOIN job_attempt a ON a.generation_job_id=j.id
        JOIN provider_configuration pc ON pc.id=a.provider_configuration_id AND pc.workspace_id=a.workspace_id
        JOIN real_media_authorization auth ON auth.job_id=j.id AND auth.authorization_id=$4
        WHERE j.id=$1 AND j.workspace_id=$2 AND a.id=$3 AND j.state='RUNNING' AND j.cancel_requested_at IS NULL
          AND a.provider_configuration_id=$5 AND pc.enabled AND pc.provider_key=$6 AND pc.capability=$7
          AND j.input_hash=$8 AND auth.expires_at>clock_timestamp() AND j.lease_owner=$9 AND j.lease_until>clock_timestamp()
          AND a.id=(SELECT id FROM job_attempt WHERE generation_job_id=j.id ORDER BY attempt_no DESC LIMIT 1)
          FOR UPDATE OF j,a,auth FOR SHARE OF pc`,
        [e.jobId,e.workspaceId,input.attemptId,e.inputSnapshot.budget.authorizationId,e.inputSnapshot.configuration.id,
          e.inputSnapshot.configuration.providerKey,e.inputSnapshot.capability,e.inputHash,input.leaseOwner]);
      if (!bound.rows[0]) throw new PersistenceError("REAL_MEDIA_SUBMIT_BLOCKED", "Submission source, authorization or provider changed");
      // WHERE predicates may run before a row-lock wait. Recheck only after all required locks are held.
      const live=await client.query(`SELECT 1 FROM generation_job j JOIN job_attempt a ON a.generation_job_id=j.id
        JOIN real_media_authorization auth ON auth.job_id=j.id JOIN provider_configuration pc ON pc.id=a.provider_configuration_id AND pc.workspace_id=a.workspace_id
        WHERE j.id=$1 AND j.workspace_id=$2 AND a.id=$3 AND j.state='RUNNING' AND j.cancel_requested_at IS NULL
          AND j.lease_owner=$4 AND j.lease_until>clock_timestamp() AND auth.expires_at>clock_timestamp()
          AND pc.enabled AND pc.id=$5 AND j.input_hash=$6 AND a.finished_at IS NULL
          AND a.attempt_no=(SELECT max(n.attempt_no) FROM job_attempt n WHERE n.generation_job_id=j.id)`,[e.jobId,e.workspaceId,input.attemptId,input.leaseOwner,e.inputSnapshot.configuration.id,e.inputHash]);
      if(!live.rows[0])throw new PersistenceError("REAL_MEDIA_SUBMIT_BLOCKED","Submission authorization or lease expired while waiting for locks");
      const result=await client.query(`INSERT INTO real_media_submission (workspace_id,project_id,generation_job_id,job_attempt_id,
        provider_configuration_id,input_hash,state,estimated_amount,currency) VALUES ($1,$2,$3,$4,$5,$6,'INTENT',$7::numeric,$8)
        ON CONFLICT (job_attempt_id) DO NOTHING RETURNING job_attempt_id`,
        [e.workspaceId,e.projectId,e.jobId,input.attemptId,e.inputSnapshot.configuration.id,e.inputHash,e.inputSnapshot.budget.estimatedAmount,e.inputSnapshot.budget.currency]);
      return result.rowCount===1;
    });
  }
  async acknowledge(input:{workspaceId:string;jobId:string;attemptId:string;providerRequestId:string;outputs?:RealMediaReceiptOutput[];usage?:Record<string,number>}):Promise<void>{
    if (!/^[A-Za-z0-9_.:|/-]{1,240}$/.test(input.providerRequestId)) throw new PersistenceError("REAL_MEDIA_RECEIPT_INVALID","Invalid provider receipt");
    await this.transaction(async client=>{
      await client.query("SELECT id FROM generation_job WHERE id=$1 AND workspace_id=$2 FOR UPDATE",[input.jobId,input.workspaceId]);
      const updated=await client.query(`UPDATE real_media_submission SET state='ACKNOWLEDGED',provider_request_id=$4,
        outputs_ciphertext=COALESCE($5,outputs_ciphertext),usage_json=COALESCE($6::jsonb,usage_json),acknowledged_at=COALESCE(acknowledged_at,now()),updated_at=now()
        WHERE job_attempt_id=$1 AND generation_job_id=$2 AND workspace_id=$3 AND state IN ('INTENT','ACKNOWLEDGED','UNKNOWN')
          AND (provider_request_id IS NULL OR provider_request_id=$4) RETURNING provider_configuration_id`,
        [input.attemptId,input.jobId,input.workspaceId,input.providerRequestId,input.outputs?this.sealOutputs(input.outputs):null,input.usage?JSON.stringify(input.usage):null]);
      const row=updated.rows[0];if(!row)throw new PersistenceError("REAL_MEDIA_RECEIPT_CONFLICT","Receipt identity changed");
      await client.query("UPDATE job_attempt SET provider_request_id=$3 WHERE id=$1 AND workspace_id=$2 AND (provider_request_id IS NULL OR provider_request_id=$3)",[input.attemptId,input.workspaceId,input.providerRequestId]);
      await client.query(`UPDATE generation_job SET state='WAITING_EXTERNAL',next_run_at=now()+interval '10 seconds',error_code=NULL,error_message=NULL,
        row_version=row_version+1,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND state IN ('RUNNING','WAITING_EXTERNAL')`,[input.jobId,input.workspaceId]);
      await recordEstimatedCost(client,input.attemptId);
    });
  }
  async markUnknown(workspaceId:string,jobId:string,attemptId:string,leaseOwner?:string):Promise<void>{
    await this.transaction(async client=>{
      await client.query("SELECT id FROM generation_job WHERE id=$1 AND workspace_id=$2 FOR UPDATE",[jobId,workspaceId]);
      await client.query("UPDATE real_media_submission SET state='UNKNOWN',updated_at=now() WHERE job_attempt_id=$1 AND workspace_id=$2 AND state IN ('INTENT','ACKNOWLEDGED','UNKNOWN')",[attemptId,workspaceId]);
      await client.query(`UPDATE generation_job SET state='WAITING_EXTERNAL',error_code='REAL_MEDIA_SUBMISSION_UNKNOWN',
        error_message='Provider delivery or result is unknown; automatic resubmission is blocked',lease_owner=NULL,lease_until=NULL,
        next_run_at=NULL,row_version=row_version+1,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND state IN ('RUNNING','WAITING_EXTERNAL')
          AND ($3::text IS NULL OR lease_owner=$3 OR lease_owner IS NULL)`,[jobId,workspaceId,leaseOwner??null]);
    });
  }
  async rejectSubmission(workspaceId:string,attemptId:string):Promise<void>{
    await this.connection(async client=>{await client.query(`UPDATE real_media_submission SET state='REJECTED',updated_at=now()
      WHERE job_attempt_id=$1 AND workspace_id=$2 AND state IN ('INTENT','UNKNOWN') AND provider_request_id IS NULL`,[attemptId,workspaceId]);});
  }
  async defer(workspaceId:string,jobId:string,seconds=15):Promise<void>{
    await this.connection(async client=>{await client.query("UPDATE generation_job SET next_run_at=now()+($3::int*interval '1 second') WHERE id=$1 AND workspace_id=$2 AND state='WAITING_EXTERNAL'",[jobId,workspaceId,Math.max(1,Math.min(seconds,3600))]);});
  }
  async recordComfyUiPhase(e: RealMediaExecution, owner: string, code: ComfyUiPendingJobCode, seconds: number): Promise<void> {
    await this.connection(async client => {
      await client.query(`UPDATE generation_job j
        SET next_run_at=now()+($4::integer*interval '1 second'), error_code=$5,error_message=$6
        WHERE j.id=$1 AND j.workspace_id=$2 AND j.lease_owner=$3 AND j.lease_until>clock_timestamp()
          AND j.state='WAITING_EXTERNAL' AND j.cancel_requested_at IS NULL
          AND j.input_snapshot#>>'{configuration,providerKey}'='comfyui'
          AND EXISTS(SELECT 1 FROM job_attempt a WHERE a.id=$7 AND a.generation_job_id=j.id AND a.finished_at IS NULL
            AND a.provider_request_id=$8 AND a.attempt_no=(SELECT max(n.attempt_no) FROM job_attempt n WHERE n.generation_job_id=j.id))`,
      [e.jobId, e.workspaceId, owner, Math.max(1, Math.min(seconds, 3600)), code, COMFYUI_PENDING_JOB_MESSAGES[code], e.attemptId, e.providerRequestId]);
    });
  }
  async declineComfyUiCancellation(e: RealMediaExecution, owner: string, code: ComfyUiCancelDenial): Promise<void> {
    await this.connection(async client => {
      await client.query(`UPDATE generation_job j SET cancel_requested_at=NULL,
          next_run_at=CASE WHEN $6::text IS NULL THEN NULL ELSE now()+interval '15 seconds' END,
          error_code=$4,error_message=$5,row_version=row_version+1,updated_at=now()
        WHERE j.id=$1 AND j.workspace_id=$2 AND j.lease_owner=$3 AND j.lease_until>clock_timestamp()
          AND j.state='WAITING_EXTERNAL' AND j.cancel_requested_at IS NOT NULL
          AND j.input_snapshot#>>'{configuration,providerKey}'='comfyui'
          AND EXISTS(SELECT 1 FROM job_attempt a WHERE a.id=$7 AND a.generation_job_id=j.id AND a.finished_at IS NULL
            AND a.provider_request_id IS NOT DISTINCT FROM $6::text
            AND a.attempt_no=(SELECT max(n.attempt_no) FROM job_attempt n WHERE n.generation_job_id=j.id))`,
      [e.jobId,e.workspaceId,owner,e.providerRequestId===null?"REAL_MEDIA_SUBMISSION_UNKNOWN":code,
        COMFYUI_PENDING_JOB_MESSAGES[code],e.providerRequestId,e.attemptId]);
    });
  }
  async recordComfyUiCancellationProof(e: RealMediaExecution): Promise<void> {
    await this.connection(async client => {
      await client.query(`INSERT INTO provider_event(workspace_id,provider_configuration_id,job_attempt_id,provider_request_id,
        source,normalized_event_key,external_status)
        SELECT j.workspace_id,a.provider_configuration_id,a.id,a.provider_request_id,'POLL',$5,'CANCELED'
        FROM generation_job j JOIN job_attempt a ON a.generation_job_id=j.id
        WHERE j.id=$1 AND j.workspace_id=$2 AND a.id=$3 AND a.provider_request_id=$4
          AND j.input_snapshot#>>'{configuration,providerKey}'='comfyui'
        ON CONFLICT (provider_configuration_id,provider_request_id,normalized_event_key) DO NOTHING`,
      [e.jobId,e.workspaceId,e.attemptId,e.providerRequestId,COMFYUI_CANCELLATION_PROOF_KEY]);
    });
  }
  async hasComfyUiCancellationProof(e: RealMediaExecution): Promise<boolean> {
    return this.connection(async client => {
      const result=await client.query(`SELECT 1 FROM provider_event
        WHERE workspace_id=$1 AND job_attempt_id=$2 AND provider_request_id=$3
          AND normalized_event_key=$4 AND external_status='CANCELED'`,
      [e.workspaceId,e.attemptId,e.providerRequestId,COMFYUI_CANCELLATION_PROOF_KEY]);
      return !!result.rows[0];
    });
  }
  async confirmComfyUiCancellationInTransaction(client: PoolClient, e: RealMediaExecution, owner: string, requiresIntent: boolean): Promise<void> {
    const result = await client.query(`SELECT j.id FROM generation_job j JOIN job_attempt a ON a.generation_job_id=j.id
      WHERE j.id=$1 AND j.workspace_id=$2 AND a.id=$3 AND j.lease_owner=$4 AND j.lease_until>clock_timestamp()
        AND j.state IN ('RUNNING','WAITING_EXTERNAL') AND (NOT $5::boolean OR j.cancel_requested_at IS NOT NULL)
        AND j.input_snapshot#>>'{configuration,providerKey}'='comfyui' AND a.finished_at IS NULL
        AND a.provider_request_id IS NOT DISTINCT FROM $6::text
        AND (a.provider_request_id IS NULL OR EXISTS(SELECT 1 FROM provider_event event
          WHERE event.job_attempt_id=a.id AND event.provider_configuration_id=a.provider_configuration_id
            AND event.workspace_id=j.workspace_id AND event.provider_request_id=a.provider_request_id
            AND event.normalized_event_key=$7 AND event.external_status='CANCELED'))
        AND a.attempt_no=(SELECT max(n.attempt_no) FROM job_attempt n WHERE n.generation_job_id=j.id)
        FOR UPDATE OF a`,[e.jobId,e.workspaceId,e.attemptId,owner,requiresIntent,e.providerRequestId,COMFYUI_CANCELLATION_PROOF_KEY]);
    if(!result.rows[0])throw new PersistenceError("REAL_MEDIA_LEASE_LOST","Cancellation proof is no longer bound to the active job attempt");
    if(e.providerRequestId) {
      // The existing receipt schema records an unsuccessful external delivery as FAILED. The job exposes CANCELED.
      await this.finishInTransaction(client,e.attemptId!,"FAILED");
    }
  }
  async claimRecovery(e:RealMediaExecution,leaseOwner:string,leaseMs=120_000):Promise<boolean>{
    return this.transaction(async client=>{
      await client.query("SELECT id FROM generation_job WHERE id=$1 AND workspace_id=$2 FOR UPDATE",[e.jobId,e.workspaceId]);
      const result=await client.query(`UPDATE generation_job j SET lease_owner=$4,lease_until=clock_timestamp()+($5::int*interval '1 millisecond'),
        row_version=row_version+1,updated_at=now() WHERE j.id=$1 AND j.workspace_id=$2 AND j.state IN ('RUNNING','WAITING_EXTERNAL')
        AND j.input_snapshot->>'schema'='real-media.v1' AND j.input_hash=$6
        AND (j.lease_until IS NULL OR j.lease_until<=clock_timestamp()) AND EXISTS(SELECT 1 FROM job_attempt a WHERE a.id=$3 AND a.generation_job_id=j.id
          AND a.attempt_no=(SELECT max(n.attempt_no) FROM job_attempt n WHERE n.generation_job_id=j.id)) RETURNING j.id`,
      [e.jobId,e.workspaceId,e.attemptId,leaseOwner,leaseMs,e.inputHash]);return result.rowCount===1;
    });
  }
  async renewDeliveryLease(e:RealMediaExecution,leaseOwner:string,leaseMs=120_000,allowCancelRequested=false):Promise<boolean>{
    return this.transaction(async client=>{
      await client.query("SELECT id FROM generation_job WHERE id=$1 AND workspace_id=$2 FOR UPDATE",[e.jobId,e.workspaceId]);
      const result=await client.query(`UPDATE generation_job j SET lease_until=clock_timestamp()+($5::int*interval '1 millisecond'),
      row_version=row_version+1,updated_at=now() WHERE j.id=$1 AND j.workspace_id=$2 AND j.state IN ('RUNNING','WAITING_EXTERNAL')
      AND j.input_snapshot->>'schema'='real-media.v1' AND j.input_hash=$6
      AND j.lease_owner=$4 AND j.lease_until>clock_timestamp() AND (j.cancel_requested_at IS NULL OR $7::boolean)
      AND EXISTS(SELECT 1 FROM job_attempt a WHERE a.id=$3 AND a.generation_job_id=j.id AND a.finished_at IS NULL
        AND a.attempt_no=(SELECT max(n.attempt_no) FROM job_attempt n WHERE n.generation_job_id=j.id))`,
      [e.jobId,e.workspaceId,e.attemptId,leaseOwner,leaseMs,e.inputHash,allowCancelRequested]);return result.rowCount===1;});
  }
  async releaseDeliveryLease(e:RealMediaExecution,leaseOwner:string):Promise<void>{
    await this.connection(async client=>{await client.query(`UPDATE generation_job SET lease_owner=NULL,lease_until=NULL
      WHERE id=$1 AND workspace_id=$2 AND lease_owner=$3 AND state IN ('RUNNING','WAITING_EXTERNAL')`,[e.jobId,e.workspaceId,leaseOwner]);});
  }
  async assertDeliveryLeaseInTransaction(client:PoolClient,e:RealMediaExecution,leaseOwner:string):Promise<void>{
    const result=await client.query(`SELECT j.id FROM generation_job j JOIN job_attempt a ON a.generation_job_id=j.id
      WHERE j.id=$1 AND j.workspace_id=$2 AND a.id=$3 AND j.state IN ('RUNNING','WAITING_EXTERNAL') AND j.cancel_requested_at IS NULL
        AND j.input_snapshot->>'schema'='real-media.v1' AND j.input_hash=$5
        AND j.lease_owner=$4 AND j.lease_until>clock_timestamp() AND a.finished_at IS NULL
        AND a.attempt_no=(SELECT max(n.attempt_no) FROM job_attempt n WHERE n.generation_job_id=j.id) FOR UPDATE OF j,a`,[e.jobId,e.workspaceId,e.attemptId,leaseOwner,e.inputHash]);
    if(!result.rows[0])throw new PersistenceError("REAL_MEDIA_LEASE_LOST","Media delivery executor lost its lease");
    const live=await client.query(`SELECT 1 FROM generation_job j JOIN job_attempt a ON a.generation_job_id=j.id
      WHERE j.id=$1 AND j.workspace_id=$2 AND a.id=$3 AND j.lease_owner=$4 AND j.input_hash=$5
        AND j.state IN ('RUNNING','WAITING_EXTERNAL') AND j.cancel_requested_at IS NULL AND j.lease_until>clock_timestamp()
        AND a.finished_at IS NULL AND a.attempt_no=(SELECT max(n.attempt_no) FROM job_attempt n WHERE n.generation_job_id=j.id)`,[e.jobId,e.workspaceId,e.attemptId,leaseOwner,e.inputHash]);
    if(!live.rows[0])throw new PersistenceError("REAL_MEDIA_LEASE_LOST","Media delivery lease expired while waiting for locks");
  }
  async finishInTransaction(client:PoolClient,attemptId:string,state:"SUCCEEDED"|"FAILED"):Promise<void>{
    const result=await client.query("UPDATE real_media_submission SET state=$2,updated_at=now() WHERE job_attempt_id=$1 AND state IN ('ACKNOWLEDGED','UNKNOWN') AND provider_request_id IS NOT NULL",[attemptId,state]);
    if(result.rowCount!==1)throw new PersistenceError("REAL_MEDIA_RECEIPT_CONFLICT","Receipt cannot complete");
    if(state==="SUCCEEDED")await client.query(`UPDATE generation_job SET error_code=NULL,error_message=NULL
      WHERE id=(SELECT generation_job_id FROM real_media_submission WHERE job_attempt_id=$1) AND state IN ('RUNNING','WAITING_EXTERNAL')`,[attemptId]);
  }
  async loadExecution(workspaceId:string,jobId:string):Promise<RealMediaExecution|null>{
    return this.connection(async client=>{const result=await client.query(EXECUTION_SQL+" AND j.workspace_id=$1 AND j.id=$2",[workspaceId,jobId]);return result.rows[0]?this.execution(result.rows[0]):null;});
  }
  async listRecoverable(limit=25):Promise<RealMediaExecution[]>{
    return this.connection(async client=>{const result=await client.query(EXECUTION_SQL.replace("s.outputs_ciphertext","NULL::text AS outputs_ciphertext")+` AND ((j.state='RUNNING' AND (j.lease_until IS NULL OR j.lease_until<=clock_timestamp())) OR
      (j.state='WAITING_EXTERNAL' AND (j.next_run_at IS NULL OR j.next_run_at<=now()) AND (j.lease_until IS NULL OR j.lease_until<=clock_timestamp())
        AND (s.provider_request_id IS NOT NULL OR s.state='REJECTED' OR j.cancel_requested_at IS NOT NULL)))
      ORDER BY j.updated_at LIMIT $1`,[Math.max(1,Math.min(limit,100))]);return result.rows.map(execution);});
  }
  private sealOutputs(outputs: RealMediaReceiptOutput[]): string {
    if (!this.options.receiptCipher) throw new PersistenceError("REAL_MEDIA_RECEIPT_KEY_MISSING", "Private receipt storage is not configured");
    return this.options.receiptCipher.seal(outputs);
  }
  private execution(row: QueryResultRow): RealMediaExecution {
    const result = execution(row);
    if (row.outputs_ciphertext) {
      if (!this.options.receiptCipher) throw new PersistenceError("REAL_MEDIA_RECEIPT_KEY_MISSING", "Private receipt storage is not configured");
      const outputs = this.options.receiptCipher.open(String(row.outputs_ciphertext));
      if (!Array.isArray(outputs)) throw new PersistenceError("REAL_MEDIA_RECEIPT_INVALID", "Private receipt is invalid");
      result.outputs = outputs;
    }
    return result;
  }
  async configurationStillEnabled(configuration:RealMediaConfiguration,inTransaction?:PoolClient):Promise<boolean>{
    const inspect=async(client:PoolClient)=>{const r=await client.query("SELECT 1 FROM provider_configuration WHERE id=$1 AND provider_key=$2 AND capability=$3 AND enabled",[configuration.id,configuration.providerKey,configuration.capability]);return !!r.rows[0];};
    return inTransaction?inspect(inTransaction):this.connection(inspect);
  }
}
const EXECUTION_SQL=`SELECT j.*,a.id AS attempt_id,a.provider_request_id,s.state AS receipt_state,s.outputs_ciphertext
 FROM generation_job j LEFT JOIN LATERAL (SELECT id,provider_request_id FROM job_attempt WHERE generation_job_id=j.id ORDER BY attempt_no DESC LIMIT 1) a ON true
 LEFT JOIN real_media_submission s ON s.job_attempt_id=a.id WHERE j.input_snapshot->>'schema'='real-media.v1'`;
function execution(row:QueryResultRow):RealMediaExecution{return {workspaceId:row.workspace_id,projectId:row.project_id,shotRevisionId:row.source_shot_revision_id,
  jobId:row.id,dispatchSeq:Number(row.dispatch_seq),state:row.state,cancelRequested:row.cancel_requested_at!==null,inputHash:row.input_hash,
  inputSnapshot:row.input_snapshot,attemptId:row.attempt_id??null,providerRequestId:row.provider_request_id??null,receiptState:row.receipt_state??null,outputs:null};}
/** An API usage value never becomes a settled amount. Actual remains unknown until a separate billing reconciliation. */
async function recordEstimatedCost(client:PoolClient,attemptId:string):Promise<void>{
  await client.query(`INSERT INTO cost_ledger (workspace_id,project_id,generation_job_id,job_attempt_id,provider_configuration_id,
    provider_request_id,idempotency_key,currency,amount_decimal,kind,basis,provider,model)
    SELECT s.workspace_id,s.project_id,s.generation_job_id,s.job_attempt_id,s.provider_configuration_id,s.provider_request_id,
      'real-media:'||s.job_attempt_id||':estimated',s.currency,s.estimated_amount,'ESTIMATED','LOCALLY_CALCULATED',
      j.input_snapshot#>>'{configuration,providerKey}',j.input_snapshot#>>'{configuration,model}'
    FROM real_media_submission s JOIN generation_job j ON j.id=s.generation_job_id
    WHERE s.job_attempt_id=$1 AND s.provider_request_id IS NOT NULL
    ON CONFLICT (workspace_id,provider_configuration_id,idempotency_key) WHERE provider_configuration_id IS NOT NULL AND idempotency_key IS NOT NULL DO NOTHING`,[attemptId]);
}

function sortedIds(ids:readonly string[]):string[]{
  if(ids.length>20||new Set(ids).size!==ids.length)throw new PersistenceError("REAL_MEDIA_UNCERTAIN_CHANGED","Unknown operation confirmation is invalid");
  return [...ids].sort();
}
function sameIds(left:readonly string[],right:readonly string[]):boolean{return JSON.stringify(sortedIds(left))===JSON.stringify(sortedIds(right));}
async function lockProject(client:PoolClient,workspaceId:string,projectId:string):Promise<void>{
  const result=await client.query("SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE",[projectId,workspaceId]);
  if(!result.rows[0])throw new PersistenceError("NOT_FOUND","Project not found");
}
async function uncertainJobs(client:PoolClient,workspaceId:string,projectId:string,frozen:FrozenRealMediaInput,excludeJobId?:string):Promise<string[]>{
  const result=await client.query(`SELECT j.id FROM generation_job j JOIN real_media_submission s ON s.generation_job_id=j.id
    WHERE j.workspace_id=$1 AND j.project_id=$2 AND j.source_shot_revision_id=$3 AND j.input_snapshot->>'schema'='real-media.v1'
      AND j.input_snapshot->>'capability'=$4 AND (s.state='UNKNOWN' OR (s.state='INTENT' AND s.provider_request_id IS NULL))
      AND (($5::text IS NULL AND j.input_snapshot->'speech' IS NULL
          AND (j.input_snapshot->>'sourceHash'=$6 OR ($8::text='comfyui' AND j.input_snapshot#>>'{configuration,providerKey}'='comfyui')))
        OR ($5::text IS NOT NULL AND j.input_snapshot#>>'{speech,lineId}'=$5))
      AND ($7::uuid IS NULL OR j.id<>$7) ORDER BY j.id LIMIT 21`,[workspaceId,projectId,frozen.shotRevisionId,frozen.capability,
      frozen.speech?.lineId??null,frozen.sourceHash,excludeJobId??null,frozen.configuration?.providerKey??null]);
  if(result.rows.length>20)throw new PersistenceError("REAL_MEDIA_UNCERTAIN_CHANGED","Too many unresolved operations; reconcile original jobs before another paid operation");
  return sortedIds(result.rows.map(row=>String(row.id)));
}
