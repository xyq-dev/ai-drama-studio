/**
 * Opt-in disposable-database acceptance. No DATABASE_URL fallback, DROP, TRUNCATE, provider or object-store call.
 * This source has not been authorized for execution in the development session. CI must set both explicit flags.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool,type QueryResultRow } from "pg";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import type { RealMediaConfiguration } from "@ai-drama/contracts";
import { realMediaInputHash } from "@ai-drama/domain";
import { JobPersistenceService } from "./job-service";
import { MediaAssetStore } from "./media-assets";
import { RealMediaStore,type RealMediaExecution } from "./real-media-store";
import { RuntimeStore } from "./runtime-store";
import { runMigrations } from "./migrations";
import { checkRealMediaAcceptanceEnv, verifyRealMediaAcceptanceDatabase } from "./real-media-acceptance-guard";
const decision=checkRealMediaAcceptanceEnv(process.env);
if(!decision.ok)throw new Error(`Real-media acceptance refused: ${decision.reason}`);
const pool=new Pool({connectionString:decision.url,max:8,connectionTimeoutMillis:5000,statement_timeout:15000,query_timeout:20000});
// Deliberately synthetic cipher for disposable fixtures only. Production injects authenticated encryption.
const store=new RealMediaStore(pool,{receiptCipher:{seal:value=>`test:${Buffer.from(JSON.stringify(value)).toString("base64")}`,open:value=>JSON.parse(Buffer.from(value.slice(5),"base64").toString())}});
const jobs=new JobPersistenceService(pool);const assets=new MediaAssetStore(pool);const hash="ab".repeat(32);
beforeAll(async()=>{
  const safe=await verifyRealMediaAcceptanceDatabase(pool,decision.databaseName);
  if(!safe.ok)throw new Error(`Real-media acceptance refused before writes: ${safe.reason}`);
  await runMigrations(pool);expect(await store.storageReady()).toBe(false);
  const client=await pool.connect();try{await client.query("BEGIN");
    for(const name of ["20261101000100_character_voice.sql","20261101000200_real_media.sql"]){await client.query(await readFile(resolve(__dirname,"../prisma/drafts",name),"utf8"));}
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  expect(await store.storageReady()).toBe(true);expect((await runMigrations(pool)).applied).toEqual([]);
});
afterAll(async()=>{await pool.end();});
async function bound(quoteLifetimeMs?:number){
  const fixture=await world();
  const provider=await pool.query<{id:string}>("INSERT INTO provider_configuration(workspace_id,provider_key,capability,default_timeout_ms,max_attempts) VALUES($1,'dashscope-media','image.generate',30000,1) RETURNING id",[fixture.workspaceId]);
  const configuration:RealMediaConfiguration={id:provider.rows[0]!.id,version:"fixture-v1",providerKey:"dashscope-media",capability:"image.generate",model:"qwen-image-3.0",region:"beijing",credentialRef:"test-only:never-resolved",credentialVersion:"v1",enabled:true,queryAllowed:true,priceVersion:"fixture-price-v1",currency:"CNY",unitPrice:"0.18",unitType:"image",parameters:{},maximumOperationAmount:"0.50"};
  const quote=await store.createQuote({lifetimeMs:quoteLifetimeMs,workspaceId:fixture.workspaceId,projectId:fixture.projectId,actorId:"test",frozen:{schema:"real-media.v1",shotRevisionId:fixture.shotRevisionId,capability:"image.generate",sourceText:"prompt",sourceHash:hash,configuration}});
  await expect(store.authorize({...fixture,actorId:"test",quoteId:quote.quoteId,maximumAmount:"0.51"})).rejects.toMatchObject({code:"REAL_MEDIA_BUDGET_MISMATCH"});
  const auth=await store.authorize({...fixture,actorId:"test",quoteId:quote.quoteId,maximumAmount:quote.maximumAmount});
  const key=randomUUID();
  const create=()=>jobs.createAndQueueWorkflowJob({workspaceId:fixture.workspaceId,actorId:"test",httpMethod:"POST",routeKey:"/real-media/acceptance",key,requestHash:realMediaInputHash(auth),expiresAt:new Date("9999-12-31T00:00:00Z")},async client=>{
    const snapshot=await store.consumeAuthorization(client,{...fixture,actorId:"test",...auth});
    await assets.prepareRealShotGenerationInTransaction(client,fixture.workspaceId,fixture.projectId,fixture.shotRevisionId,"image.generate");
    return {workspaceId:fixture.workspaceId,projectId:fixture.projectId,sourceShotRevisionId:fixture.shotRevisionId,type:"MEDIA_IMAGE",kind:"MEDIA_IMAGE",requestedBy:"test",inputHash:realMediaInputHash(snapshot),inputSnapshot:snapshot,traceId:"acceptance"};
  },(client,created)=>store.bindAuthorization(client,quote.quoteId,created));
  const [one,two]=await Promise.all([create(),create()]);expect(one.body.jobId).toBe(two.body.jobId);expect([one.replayed,two.replayed].sort()).toEqual([false,true]);
  const acquired=await jobs.acquireQueuedJob({workspaceId:fixture.workspaceId,jobId:one.body.jobId,dispatchSeq:one.body.dispatchSeq,providerConfigurationId:configuration.id,leaseOwner:"acceptance-owner",leaseMs:60000,traceId:"acceptance"});
  expect(acquired).not.toBeNull();const execution=(await store.loadExecution(fixture.workspaceId,one.body.jobId))!;
  return {...fixture,quote,auth,execution,attemptId:acquired!.attemptId,configuration,create};
}
async function intent(value:Awaited<ReturnType<typeof bound>>,owner="acceptance-owner"){
  return store.beginSubmission({execution:value.execution,attemptId:value.attemptId,leaseOwner:owner,validateInTransaction:client=>assets.prepareRealShotGenerationInTransaction(client,value.workspaceId,value.projectId,value.shotRevisionId,"image.generate").then(()=>undefined)});
}
async function acknowledge(value:Awaited<ReturnType<typeof bound>>){
  await store.acknowledge({workspaceId:value.workspaceId,jobId:value.execution.jobId,attemptId:value.attemptId,providerRequestId:`task-${randomUUID()}`,
    outputs:[{kind:"IMAGE",retrieval:{kind:"URI",uri:"https://private.invalid/fixture?signature=never-fetched"}}],usage:{image_count:1}});
  return (await store.loadExecution(value.workspaceId,value.execution.jobId))!;
}
async function complete(value:Awaited<ReturnType<typeof bound>>,execution:RealMediaExecution,rollback=false){
  return assets.completeAttemptWithAsset(jobs,{workspaceId:value.workspaceId,projectId:value.projectId,generationJobId:execution.jobId,sourceJobAttemptId:value.attemptId,
    sourceShotRevisionId:value.shotRevisionId,providerConfigurationId:value.configuration.id,providerRequestId:execution.providerRequestId!,kind:"IMAGE",storageProvider:"s3",
    objectKey:`real-media/${value.workspaceId}/${value.projectId}/${execution.jobId}/${value.attemptId}/${hash}.png`,mimeType:"image/png",byteSize:1,checksumSha256:hash,width:1,height:1,traceId:"acceptance",
    metadata:{schema:"real-media.asset.v1",actualCost:"unknown"},afterPersist:async(client)=>{await store.finishInTransaction(client,value.attemptId,"SUCCEEDED");if(rollback)throw new Error("simulated post-upload metadata failure");}});
}
describe("real media draft acceptance against an explicitly named empty PostgreSQL database",()=>{
  it("consumes a quote once and permanently replays the same job under concurrent request keys",async()=>{
    const value=await bound();expect((await value.create()).replayed).toBe(true);
    await expect(store.transaction(client=>store.consumeAuthorization(client,{...value,actorId:"test",...value.auth}))).rejects.toMatchObject({code:"REAL_MEDIA_AUTHORIZATION_INVALID"});
    expect((await pool.query("SELECT count(*)::int AS n FROM generation_job WHERE workspace_id=$1",[value.workspaceId])).rows[0]!.n).toBe(1);
  });
  it("fences stale owners and changed sources before intent and never auto-requeues an unknown submission",async()=>{
    const value=await bound();await expect(intent(value,"old-owner")).rejects.toMatchObject({code:"REAL_MEDIA_SUBMIT_BLOCKED"});
    expect(await intent(value)).toBe(true);expect(await intent(value)).toBe(false);
    await store.markUnknown(value.workspaceId,value.execution.jobId,value.attemptId);
    await expect(jobs.manualRetry({workspaceId:value.workspaceId,jobId:value.execution.jobId,requestedBy:"test",traceId:"acceptance",retryable:true})).rejects.toMatchObject({code:"JOB_NOT_RETRYABLE"});
    expect((await store.loadExecution(value.workspaceId,value.execution.jobId))?.providerRequestId).toBeNull();
    const {budget:oldBudget,...frozen}=value.execution.inputSnapshot;void oldBudget;
    const duplicateQuote=await store.createQuote({workspaceId:value.workspaceId,projectId:value.projectId,actorId:"test",frozen});
    expect(duplicateQuote.uncertainJobIds).toEqual([value.execution.jobId]);
    await expect(store.authorize({workspaceId:value.workspaceId,projectId:value.projectId,actorId:"test",quoteId:duplicateQuote.quoteId,maximumAmount:duplicateQuote.estimatedAmount})).rejects.toMatchObject({code:"REAL_MEDIA_UNCERTAIN_CHANGED"});
    await store.authorize({workspaceId:value.workspaceId,projectId:value.projectId,actorId:"test",quoteId:duplicateQuote.quoteId,maximumAmount:duplicateQuote.estimatedAmount,confirmedUncertainJobIds:[value.execution.jobId]});
    expect((await store.loadExecution(value.workspaceId,value.execution.jobId))?.receiptState).toBe("UNKNOWN");
    const exposure=await store.costExposure(value.workspaceId,value.projectId);expect(exposure.unknownSubmissionCount).toBe(1);
    expect(exposure.currencies[0]?.reservedMaximumAmount).toBe("0.50000000");
    const expired=await bound();await pool.query("UPDATE generation_job SET lease_until=now()-interval '1 second' WHERE id=$1",[expired.execution.jobId]);
    expect(await jobs.recoverExpiredLease({workspaceId:expired.workspaceId,jobId:expired.execution.jobId,traceId:"acceptance"})).toBe("deferred");
    const changed=await bound();await pool.query("UPDATE shot_revision SET freshness_status='STALE',stale_reason='fixture',stale_from_ref='fixture' WHERE id=$1",[changed.shotRevisionId]);
    await expect(intent(changed)).rejects.toMatchObject({code:"REVIEW_REQUIRED"});
    expect((await pool.query("SELECT count(*)::int AS n FROM real_media_submission WHERE generation_job_id=$1",[changed.execution.jobId])).rows[0]!.n).toBe(0);
  });
  it("renews live submissions, fences competing recovery owners and isolates Mock discovery",async()=>{
    const value=await bound();await intent(value);
    expect(await jobs.renewRunningLease({workspaceId:value.workspaceId,jobId:value.execution.jobId,attemptId:value.attemptId,leaseOwner:"acceptance-owner",leaseMs:60000})).toBe(true);
    const runtime=new RuntimeStore(pool);expect(await runtime.loadMockMediaExecution(value.workspaceId,value.execution.jobId)).toBeNull();
    expect((await runtime.listExpiredMockMedia(100)).some(row=>row.jobId===value.execution.jobId)).toBe(false);
    const execution=await acknowledge(value);expect(await store.claimRecovery(execution,"competitor")).toBe(false);
    await store.releaseDeliveryLease(execution,"acceptance-owner");
    const claimed=await Promise.all([store.claimRecovery(execution,"recovery-a"),store.claimRecovery(execution,"recovery-b")]);expect(claimed.filter(Boolean)).toHaveLength(1);
    const owner=claimed[0]?"recovery-a":"recovery-b";
    expect(await store.renewDeliveryLease(execution,owner)).toBe(true);
    await expect(store.transaction(client=>store.assertDeliveryLeaseInTransaction(client,execution,"old-owner"))).rejects.toMatchObject({code:"REAL_MEDIA_LEASE_LOST"});
    await store.releaseDeliveryLease(execution,owner);
    await pool.query("UPDATE generation_job SET next_run_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[execution.jobId]);
    const recovered=await store.listRecoverable(100);expect(recovered.some(row=>row.jobId===execution.jobId)).toBe(false); // next_poll still bounded in the future
  });
  it("requires duplicate-fee confirmation for a known-ID UNKNOWN while preserving its task and recorded estimate",async()=>{
    const value=await bound();await intent(value);const acknowledged=await acknowledge(value);
    await store.markUnknown(value.workspaceId,value.execution.jobId,value.attemptId);
    const {budget:oldBudget,...frozen}=value.execution.inputSnapshot;void oldBudget;
    const quote=await store.createQuote({workspaceId:value.workspaceId,projectId:value.projectId,actorId:"test",frozen});
    expect(quote.uncertainJobIds).toEqual([value.execution.jobId]);
    const authorize={workspaceId:value.workspaceId,projectId:value.projectId,actorId:"test",quoteId:quote.quoteId,maximumAmount:quote.estimatedAmount};
    await expect(store.authorize(authorize)).rejects.toMatchObject({code:"REAL_MEDIA_UNCERTAIN_CHANGED"});
    await store.authorize({...authorize,confirmedUncertainJobIds:[value.execution.jobId]});
    await expect(jobs.manualRetry({workspaceId:value.workspaceId,jobId:value.execution.jobId,requestedBy:"test",traceId:"acceptance",retryable:true})).rejects.toMatchObject({code:"JOB_NOT_RETRYABLE"});
    expect(await store.loadExecution(value.workspaceId,value.execution.jobId)).toMatchObject({receiptState:"UNKNOWN",providerRequestId:acknowledged.providerRequestId});
    expect(await store.costExposure(value.workspaceId,value.projectId)).toEqual({actualCost:"unknown",unknownSubmissionCount:1,currencies:[]});
    expect((await pool.query("SELECT maximum_amount::text AS maximum FROM real_media_authorization WHERE quote_id=$1",[value.quote.quoteId])).rows).toEqual([{maximum:"0.50000000"}]);
    expect((await pool.query("SELECT kind,amount_decimal::text AS amount FROM cost_ledger WHERE generation_job_id=$1",[value.execution.jobId])).rows).toEqual([{kind:"ESTIMATED",amount:"0.18000000"}]);
    expect((await pool.query("SELECT count(*)::int AS count FROM generation_job WHERE workspace_id=$1",[value.workspaceId])).rows[0]!.count).toBe(1);
  });
  it("checks the actual send time after waiting for the project lock",async()=>{
    const value=await bound();const holder=await pool.connect();
    await pool.query("UPDATE generation_job SET lease_until=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",[value.execution.jobId]);
    try{
      await holder.query("BEGIN");await holder.query("SELECT id FROM project WHERE id=$1 FOR UPDATE",[value.projectId]);
      const pending=intent(value);const refusal=expect(pending).rejects.toMatchObject({code:"REAL_MEDIA_SUBMIT_BLOCKED"});
      await new Promise(done=>setTimeout(done,300));await holder.query("COMMIT");await refusal;
      expect((await pool.query("SELECT count(*)::int AS n FROM real_media_submission WHERE generation_job_id=$1",[value.execution.jobId])).rows[0]!.n).toBe(0);
    }finally{await holder.query("ROLLBACK");holder.release();}
  });
  it("rechecks time after waiting for unchanged job or authorization rows, and fences late delivery",async()=>{
    for(const table of ["generation_job","real_media_authorization"] as const){
      const value=await bound(table==="real_media_authorization"?5000:undefined);const holder=await pool.connect();
      try{
        if(table==="generation_job")await pool.query("UPDATE generation_job SET lease_until=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",[value.execution.jobId]);
        await holder.query("BEGIN");
        if(table==="generation_job")await holder.query("SELECT id FROM generation_job WHERE id=$1 FOR UPDATE",[value.execution.jobId]);
        else await holder.query("SELECT quote_id FROM real_media_authorization WHERE quote_id=$1 FOR UPDATE",[value.quote.quoteId]);
        const pending=intent(value);const refusal=expect(pending).rejects.toMatchObject({code:"REAL_MEDIA_SUBMIT_BLOCKED"});
        await new Promise(done=>setTimeout(done,table==="generation_job"?300:5200));await holder.query("COMMIT");await refusal;
        expect((await pool.query("SELECT count(*)::int AS n FROM real_media_submission WHERE generation_job_id=$1",[value.execution.jobId])).rows[0]!.n).toBe(0);
      }finally{await holder.query("ROLLBACK");holder.release();}
    }
    const value=await bound();await intent(value);const execution=await acknowledge(value);const holder=await pool.connect();
    try{
      await pool.query("UPDATE generation_job SET lease_until=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",[execution.jobId]);
      await holder.query("BEGIN");await holder.query("SELECT id FROM generation_job WHERE id=$1 FOR UPDATE",[execution.jobId]);
      const pending=store.transaction(client=>store.assertDeliveryLeaseInTransaction(client,execution,"acceptance-owner"));
      const refusal=expect(pending).rejects.toMatchObject({code:"REAL_MEDIA_LEASE_LOST"});
      await new Promise(done=>setTimeout(done,300));await holder.query("COMMIT");await refusal;
    }finally{await holder.query("ROLLBACK");holder.release();}
  });
  it("rejects receipt-state rollback, rewritten acknowledgement times and untyped usage directly in PostgreSQL",async()=>{
    const value=await bound();await intent(value);await acknowledge(value);
    for(const state of ["INTENT","REJECTED"]){await expect(pool.query("UPDATE real_media_submission SET state=$2 WHERE job_attempt_id=$1",[value.attemptId,state])).rejects.toThrow();}
    for(const sql of ["acknowledged_at=NULL","acknowledged_at=acknowledged_at+interval '1 second'"]){await expect(pool.query(`UPDATE real_media_submission SET ${sql} WHERE job_attempt_id=$1`,[value.attemptId])).rejects.toThrow(/immutable|acknowledg/i);}
    for(const usage of ["[]",'{"characters":-1}','{"characters":"1"}','{"private_error":"rejected"}']){
      await expect(pool.query("UPDATE real_media_submission SET usage_json=$2::jsonb WHERE job_attempt_id=$1",[value.attemptId,usage])).rejects.toThrow(/usage/);
    }
    await store.markUnknown(value.workspaceId,value.execution.jobId,value.attemptId);
    await expect(pool.query("UPDATE real_media_submission SET state='INTENT' WHERE job_attempt_id=$1",[value.attemptId])).rejects.toThrow(/transition/);
  });
  it("atomically rolls back uploaded-object registration, receipt and job metadata, then commits one exact asset",async()=>{
    const value=await bound();await intent(value);const execution=await acknowledge(value);
    await expect(complete(value,execution,true)).rejects.toThrow(/metadata failure/);
    expect((await pool.query("SELECT count(*)::int AS n FROM asset WHERE source_generation_job_id=$1",[execution.jobId])).rows[0]!.n).toBe(0);
    expect((await store.loadExecution(value.workspaceId,execution.jobId))?.receiptState).toBe("ACKNOWLEDGED");
    const result=await complete(value,execution);expect(result?.reviewStatus).toBe("DRAFT");
    expect((await store.loadExecution(value.workspaceId,execution.jobId))?.receiptState).toBe("SUCCEEDED");
    expect((await pool.query("SELECT kind,amount_decimal::text AS amount FROM cost_ledger WHERE generation_job_id=$1",[execution.jobId])).rows).toEqual([{kind:"ESTIMATED",amount:"0.18000000"}]);
    await expect(pool.query("DELETE FROM real_media_submission WHERE job_attempt_id=$1",[value.attemptId])).rejects.toThrow(/permanent/);
  });
  it("keeps a late provider receipt and estimated usage after local cancellation, without attaching an asset",async()=>{
    const value=await bound();await intent(value);await jobs.cancelJob({workspaceId:value.workspaceId,jobId:value.execution.jobId,traceId:"cancel"});
    const execution=await acknowledge(value);expect(await complete(value,execution)).toBeNull();
    expect((await store.loadExecution(value.workspaceId,execution.jobId))?.state).toBe("CANCELED");
    expect((await pool.query("SELECT usage_json FROM real_media_submission WHERE job_attempt_id=$1",[value.attemptId])).rows[0]!.usage_json).toEqual({image_count:1});
    expect((await pool.query("SELECT count(*)::int AS n FROM cost_ledger WHERE generation_job_id=$1 AND kind='ACTUAL'",[execution.jobId])).rows[0]!.n).toBe(0);
  });
});

async function world() {
  const workspace = await pool.query<{ id: string } & QueryResultRow>(
    "INSERT INTO workspace (name) VALUES ('real-media-acceptance') RETURNING id",
  );
  const workspaceId = workspace.rows[0]?.id;
  if (!workspaceId) throw new Error("workspace missing");

  const project = await pool.query<{ id: string } & QueryResultRow>(
    "INSERT INTO project (workspace_id, title) VALUES ($1, 'real-media-acceptance') RETURNING id",
    [workspaceId],
  );
  const projectId = project.rows[0]?.id;
  if (!projectId) throw new Error("project missing");

  const story = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO story_revision
      (workspace_id, project_id, revision_no, content_json, content_hash, created_by)
     VALUES ($1,$2,1,'{}'::jsonb,$3,'test')
     RETURNING id`,
    [workspaceId, projectId, hash],
  );
  const storyRevisionId = story.rows[0]?.id;
  if (!storyRevisionId) throw new Error("story missing");

  await pool.query(
    `UPDATE story_revision
        SET review_status = 'APPROVED',
            reviewed_by = 'editor',
            reviewed_at = now(),
            reviewed_content_hash = content_hash
      WHERE id = $1`,
    [storyRevisionId],
  );
  await pool.query(
    `UPDATE project
        SET current_story_revision_id = $1,
            approved_story_revision_id = $1
      WHERE id = $2`,
    [storyRevisionId, projectId],
  );

  const episode = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO episode (workspace_id, project_id, episode_no, title)
     VALUES ($1,$2,1,'Episode 1') RETURNING id`,
    [workspaceId, projectId],
  );
  const episodeId = episode.rows[0]?.id;
  if (!episodeId) throw new Error("episode missing");

  const script = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO script_revision
      (workspace_id, project_id, episode_id, revision_no, source_story_revision_id,
       content_json, content_hash, created_by)
     VALUES ($1,$2,$3,1,$4,'{}'::jsonb,$5,'test')
     RETURNING id`,
    [workspaceId, projectId, episodeId, storyRevisionId, hash],
  );
  const scriptRevisionId = script.rows[0]?.id;
  if (!scriptRevisionId) throw new Error("script missing");

  await pool.query(
    `UPDATE script_revision
        SET review_status = 'APPROVED',
            reviewed_by = 'editor',
            reviewed_at = now(),
            reviewed_content_hash = content_hash
      WHERE id = $1`,
    [scriptRevisionId],
  );
  await pool.query(
    `UPDATE episode
        SET current_script_revision_id = $1,
            approved_script_revision_id = $1
      WHERE id = $2`,
    [scriptRevisionId, episodeId],
  );

  const scene = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO scene (workspace_id, project_id, episode_id)
     VALUES ($1,$2,$3) RETURNING id`,
    [workspaceId, projectId, episodeId],
  );
  const sceneId = scene.rows[0]?.id;
  if (!sceneId) throw new Error("scene missing");

  const sceneRevision = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO scene_revision
      (workspace_id, project_id, episode_id, scene_id, revision_no,
       source_script_revision_id, ordinal, heading, summary, content_hash,
       review_status, reviewed_by, reviewed_at, reviewed_content_hash, created_by)
     VALUES ($1,$2,$3,$4,1,$5,1,'INT. ROOM','room',$6,
             'APPROVED','editor',now(),$6,'test')
     RETURNING id`,
    [workspaceId, projectId, episodeId, sceneId, scriptRevisionId, hash],
  );
  const sceneRevisionId = sceneRevision.rows[0]?.id;
  if (!sceneRevisionId) throw new Error("scene revision missing");

  await pool.query(
    `UPDATE scene
        SET current_revision_id = $1,
            approved_revision_id = $1
      WHERE id = $2`,
    [sceneRevisionId, sceneId],
  );

  const shot = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO shot (workspace_id, project_id, episode_id, scene_id)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [workspaceId, projectId, episodeId, sceneId],
  );
  const shotId = shot.rows[0]?.id;
  if (!shotId) throw new Error("shot missing");

  const shotRevision = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO shot_revision
      (workspace_id, project_id, scene_id, shot_id, revision_no,
       source_scene_revision_id, ordinal, shot_type, camera, action,
       prompt_text, content_hash, review_status, reviewed_by, reviewed_at,
       reviewed_content_hash, created_by)
     VALUES ($1,$2,$3,$4,1,$5,1,'close','static','look',
             'prompt',$6,'APPROVED','editor',now(),$6,'test')
     RETURNING id`,
    [workspaceId, projectId, sceneId, shotId, sceneRevisionId, hash],
  );
  const shotRevisionId = shotRevision.rows[0]?.id;
  if (!shotRevisionId) throw new Error("shot revision missing");

  await pool.query(
    `UPDATE shot
        SET current_revision_id = $1,
            approved_revision_id = $1
      WHERE id = $2`,
    [shotRevisionId, shotId],
  );

  return { workspaceId, projectId, shotRevisionId, shotId, sceneId, sceneRevisionId };
}
