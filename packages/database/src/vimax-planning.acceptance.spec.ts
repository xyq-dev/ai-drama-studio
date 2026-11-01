/**
 * Explicit opt-in PostgreSQL draft acceptance. Never uses DATABASE_URL, drops/truncates data, invokes providers or
 * opens media. Requires a brand-new named empty disposable DB and BOTH independently reviewed draft flags.
 * Not collected by ordinary test/integration. Writing this suite is not authorization to execute it.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vimaxEvaluationInputSchema, vimaxPlanningStartSchema, type VimaxPlanningRecord, type VimaxPlanningReservation, type WritingCandidateRecord, type TitleRunRecord } from "@ai-drama/contracts";
import { hashVimaxPlanningRequest } from "@ai-drama/domain";
import { runMigrations } from "./migrations";
import { PostgresTitleWritingStore } from "./title-writing-store";
import { TextChainService } from "./text-chain";
import { checkTitleWritingAcceptanceEnv, verifyTitleWritingAcceptanceDatabase } from "./title-writing-acceptance-guard";
import { VimaxCandidateStore } from "./vimax-candidate-store";
import { PostgresVimaxPlanningStore } from "./vimax-planning-store";
import { PostgresWritingCandidateStore, recentWritingCalls, runningWritingRuns, writingCallLockKey } from "./writing-candidate-store";

const decision=checkTitleWritingAcceptanceEnv(process.env);
if(!decision.ok)throw new Error(`ViMax planning acceptance refused: ${decision.reason}`);
if(process.env.VIMAX_CANDIDATE_ACCEPTANCE_DRAFT_AUTHORIZED!=="true"||process.env.VIMAX_PLANNING_ACCEPTANCE_DRAFT_AUTHORIZED!=="true") {
  throw new Error("ViMax planning acceptance requires VIMAX_CANDIDATE_ACCEPTANCE_DRAFT_AUTHORIZED=true and VIMAX_PLANNING_ACCEPTANCE_DRAFT_AUTHORIZED=true after independent draft review");
}
const pool=new Pool({connectionString:decision.url,max:8,connectionTimeoutMillis:5000,statement_timeout:15000,query_timeout:20000,application_name:"vimax-planning-draft-acceptance"});
const store=new PostgresVimaxPlanningStore(pool),candidates=new VimaxCandidateStore(pool),chain=new TextChainService(pool);
const actor="server-owner",usage={status:"unknown" as const,inputTokens:null,outputTokens:null,totalTokens:null};
let beforeDraft=true;let discovered:string[]=[];
let input!:ReturnType<typeof vimaxEvaluationInputSchema.parse>;
async function tx<T>(work:(client:PoolClient)=>Promise<T>):Promise<T>{const c=await pool.connect();try{await c.query("BEGIN");const r=await work(c);await c.query("COMMIT");return r;}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}}
async function scalar(sql:string,values:unknown[]=[]):Promise<string>{return (await pool.query<{id:string}>(sql,values)).rows[0]!.id;}
async function version(table:"project"|"episode",id:string):Promise<number>{return Number((await pool.query(`SELECT ${table==="project"?"version":"row_version"} AS value FROM ${table} WHERE id=$1`,[id])).rows[0]!.value);}
beforeAll(async()=>{
  const safe=await verifyTitleWritingAcceptanceDatabase(pool,decision.databaseName);if(!safe.ok)throw new Error(`ViMax planning refused before writes: ${safe.reason}`);
  const migrated=await runMigrations(pool);discovered=[...migrated.applied,...migrated.alreadyApplied];beforeDraft=await store.storageReady();if(beforeDraft)throw new Error("Planning draft appeared in ordinary migrations");
  for(const file of ["20261031000100_vimax_storyboard_candidate.sql","20261101000100_vimax_planning_request.sql"]){const sql=await readFile(resolve(__dirname,"../prisma/drafts",file),"utf8");await tx(c=>c.query(sql));}
  const raw=JSON.parse(await readFile(resolve(__dirname,"../../../scripts/vimax-evaluation/fixtures/single-scene.json"),"utf8"));input=vimaxEvaluationInputSchema.parse(raw.input);
});
afterAll(async()=>{await pool.end();});
async function world(){
  const workspaceId=await scalar("INSERT INTO workspace(name) VALUES('ViMax planning synthetic acceptance') RETURNING id");
  const projectId=await scalar("INSERT INTO project(workspace_id,title) VALUES($1,'ViMax planning synthetic acceptance') RETURNING id",[workspaceId]);
  const story=await chain.createStoryRevision({workspaceId,projectId,content:{text:"Synthetic story"},createdBy:actor,expectedVersion:1});
  let review=await chain.transitionReview({table:"story_revision",workspaceId,revisionId:story.revisionId,expectedVersion:story.rowVersion,expectedReviewVersion:1,to:"IN_REVIEW"});
  await chain.approveStory({workspaceId,projectId,revisionId:story.revisionId,expectedVersion:review.rowVersion,expectedReviewVersion:review.reviewVersion,reviewedBy:actor});
  const episodeId=await scalar("SELECT id FROM episode WHERE workspace_id=$1 AND project_id=$2 AND episode_no=1",[workspaceId,projectId]);
  const script=await chain.createScriptRevision({workspaceId,projectId,episodeId,sourceStoryRevisionId:story.revisionId,content:{text:input.scriptText},createdBy:actor,expectedVersion:await version("episode",episodeId)});
  review=await chain.transitionReview({table:"script_revision",workspaceId,revisionId:script.revisionId,expectedVersion:script.rowVersion,expectedReviewVersion:1,to:"IN_REVIEW"});
  await chain.approveScript({workspaceId,episodeId,revisionId:script.revisionId,expectedVersion:review.rowVersion,expectedReviewVersion:review.reviewVersion,reviewedBy:actor});
  for(const character of input.characters)await tx(async c=>chain.createTextEntityRevisionInTransaction(c,{kind:"character",workspaceId,projectId,name:character.name,sourceScriptRevisionId:script.revisionId,content:{description:"Synthetic character"},createdBy:actor,expectedVersion:await version("project",projectId)}));
  const scene=await tx(async c=>chain.createSceneRevisionInTransaction(c,{workspaceId,projectId,episodeId,sourceScriptRevisionId:script.revisionId,ordinal:1,heading:input.sceneSpans[0]!.heading,timeOfDay:"夜",summary:"Original synthetic scene",createdBy:actor,expectedVersion:await version("episode",episodeId)}));
  const targets=await candidates.targets(workspaceId,projectId,episodeId),target=targets.targets.find(t=>t.sceneId===scene.entityId)!;
  const originalNames=new Map(input.characters.map(c=>[c.key,c.name])),keys=new Map(targets.source.characters.map(c=>[c.name,c.key]));
  const request=vimaxPlanningStartSchema.parse({schema:"ads.vimax-planning.start.v1",target:{sceneId:target.sceneId,sceneRevisionId:target.sceneRevisionId,rowVersion:target.rowVersion},source:{scriptRevisionId:targets.source.scriptRevisionId,scriptContentHash:targets.source.scriptContentHash,characters:targets.source.characters},sceneSpans:input.sceneSpans,selectedSceneKeys:input.selectedSceneKeys,sourceDialogue:input.sourceDialogue.map(l=>({...l,characterKey:l.characterKey?keys.get(originalNames.get(l.characterKey)!):null})),requirements:input.requirements,confirmedTextSend:true});
  return {workspaceId,projectId,episodeId,request,scene,script};
}
type World=Awaited<ReturnType<typeof world>>;
function reservation(w:World,key:string=randomUUID()):VimaxPlanningReservation{const now=new Date();return {id:randomUUID(),workspaceId:w.workspaceId,projectId:w.projectId,episodeId:w.episodeId,actorId:actor,idempotencyKey:key,requestHash:hashVimaxPlanningRequest(w.projectId,w.episodeId,w.request),request:structuredClone(w.request),providerKey:"openai",model:"synthetic-model",executorId:`planning:${randomUUID()}`,createdAt:now.toISOString(),leaseUntil:new Date(now.getTime()+240000).toISOString()};}
const limits=(maxCallsPerDay=100)=>({sinceIso:new Date(Date.now()-86400000).toISOString(),maxCallsPerDay,maxActiveRuns:10});
async function create(w:World,r=reservation(w),cap=100):Promise<VimaxPlanningRecord>{const result=await store.create(r,limits(cap));if(result.kind!=="created")throw new Error(`Expected created, got ${result.kind}`);return result.record;}
async function count(w:World){return Number((await pool.query("SELECT count(*)::int AS n FROM vimax_planning_request WHERE workspace_id=$1",[w.workspaceId])).rows[0]!.n);}
describe("ViMax planning reviewed drafts on a new empty PostgreSQL database",()=>{
  it("applies drafts only explicitly and confirms full readiness without an ordinary migration entry",async()=>{
    expect(beforeDraft).toBe(false);expect(await store.storageReady()).toBe(true);expect(await candidates.storageReady()).toBe(true);
    expect(discovered.some(s=>s.includes("vimax"))).toBe(false);
    const ledger=await pool.query("SELECT name FROM schema_migration WHERE name LIKE '%vimax%'");expect(ledger.rowCount).toBe(0);
  });
  it("concurrent permanent same-key reservations create exactly one row and changed payload conflicts",async()=>{
    const w=await world(),r=reservation(w);const results=await Promise.all([store.create(r,limits()),store.create({...r,id:randomUUID(),executorId:"other"},limits())]);
    expect(results.map(x=>x.kind).sort()).toEqual(["created","existing"]);expect(await count(w)).toBe(1);
    const changed=structuredClone(r);changed.request.requirements.style+=" ";changed.requestHash=hashVimaxPlanningRequest(w.projectId,w.episodeId,changed.request);
    expect(await store.create(changed,limits())).toEqual({kind:"conflict"});expect(await count(w)).toBe(1);
    const replay=await store.create({...r,providerKey:"deepseek",model:"different-default"},limits(0));expect(replay.kind).toBe("existing");
  });
  it("source changes before reserve or submitted CAS produce no paid send state",async()=>{
    const before=await world();await pool.query("UPDATE episode SET approved_script_revision_id=NULL WHERE id=$1",[before.episodeId]);
    expect(await store.create(reservation(before),limits())).toEqual({kind:"blocked",code:"VIMAX_PLANNING_SOURCE_CHANGED"});expect(await count(before)).toBe(0);
    const w=await world(),r=await create(w);await pool.query("UPDATE episode SET approved_script_revision_id=NULL WHERE id=$1",[w.episodeId]);
    expect(await store.markSubmitted(w.workspaceId,r.id,r.executorId!,new Date().toISOString(),new Date(Date.now()+240000).toISOString())).toBe(false);
    const closed=await store.getById(w.workspaceId,r.id);expect(closed).toMatchObject({state:"rejected",errorCode:"source_changed_before_send",submittedAt:null});
    expect((await store.create(reservation(w,r.idempotencyKey),limits(0))).kind).toBe("existing");
  });
  it("uses the database clock to fence an expired owner even when caller time is stale",async()=>{
    const w=await world(),r=reservation(w),stale=new Date(Date.now()-60000).toISOString();r.createdAt=stale;r.leaseUntil=new Date(Date.now()-1000).toISOString();await create(w,r);
    expect(await store.markSubmitted(w.workspaceId,r.id,r.executorId,stale,new Date(Date.now()+240000).toISOString())).toBe(false);
    expect((await store.getById(w.workspaceId,r.id))?.state).toBe("reserved");
    expect(await store.recoverExpired(w.workspaceId,new Date().toISOString())).toBe(1);expect(await store.getById(w.workspaceId,r.id)).toMatchObject({state:"rejected",errorCode:"executor_lost_before_send",submittedAt:null,executorId:null});
  });
  it("submission CAS wins once, expired submitted becomes UNKNOWN, and late owner cannot finish or resend",async()=>{
    const w=await world(),r=await create(w),now=new Date().toISOString(),lease=new Date(Date.now()+240000).toISOString();
    expect(await store.markSubmitted(w.workspaceId,r.id,"foreign",now,lease)).toBe(false);
    const won=await Promise.all([store.markSubmitted(w.workspaceId,r.id,r.executorId!,now,lease),store.markSubmitted(w.workspaceId,r.id,r.executorId!,now,lease)]);expect(won.filter(Boolean)).toHaveLength(1);
    await store.recoverExpired(w.workspaceId,new Date(Date.now()+300000).toISOString());
    expect(await store.getById(w.workspaceId,r.id)).toMatchObject({state:"unknown",executorId:null,errorCode:"executor_lost"});
    expect(await store.finish(w.workspaceId,r.id,r.executorId!,{state:"unknown",errorCode:"timeout",providerRequestId:null,responseModel:null,usage,output:null},now)).toBe(false);
    expect(await store.markSubmitted(w.workspaceId,r.id,r.executorId!,now,lease)).toBe(false);
    const next=reservation(w);expect(await store.create(next,limits())).toEqual({kind:"needs_confirmation",requestId:r.id});
    next.request.confirmUncertainRequestId=r.id;next.requestHash=hashVimaxPlanningRequest(w.projectId,w.episodeId,next.request);expect((await store.create(next,limits())).kind).toBe("created");expect(await count(w)).toBe(2);
  });
  it("cancel versus submit has a single winner and submitted cancellation retains possible charge",async()=>{
    const w=await world(),r=await create(w),now=new Date().toISOString(),lease=new Date(Date.now()+240000).toISOString();
    await Promise.all([store.cancel(w.workspaceId,w.projectId,w.episodeId,actor,r.id,now),store.markSubmitted(w.workspaceId,r.id,r.executorId!,now,lease)]);
    const final=await store.getById(w.workspaceId,r.id);expect(["submitted","rejected"]).toContain(final?.state);
    if(final?.state==="submitted"){expect(final.submittedAt).not.toBeNull();expect((await store.cancel(w.workspaceId,w.projectId,w.episodeId,actor,r.id,now))?.state).toBe("submitted");}
    else expect(final).toMatchObject({errorCode:"canceled_before_send",submittedAt:null});
  });
  it("planning reservations consume the legacy shared quota and canceled reservations stay explicitly occupied",async()=>{
    const w=await world(),r=await create(w,undefined,1);await store.cancel(w.workspaceId,w.projectId,w.episodeId,actor,r.id,new Date().toISOString());
    const charged=await tx(async c=>{await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[writingCallLockKey(w.workspaceId)]);return recentWritingCalls(c,w.workspaceId,limits().sinceIso);});expect(charged).toBe(1);
    expect(await store.create(reservation(w),limits(1))).toEqual({kind:"blocked",code:"VIMAX_PLANNING_DAILY_CAP"});
    const now=new Date().toISOString();const legacy:WritingCandidateRecord={id:randomUUID(),workspaceId:w.workspaceId,projectId:w.projectId,actorId:actor,idempotencyKey:randomUUID(),requestHash:"c".repeat(64),input:{schema:"ads.writing-candidate.input.v1",promptVersion:"synthetic",projectId:w.projectId,mode:"story",episodeId:null,episodeNo:null,providerKey:"openai",model:"synthetic",base:{sourceRevisionId:null,ifMatch:1},request:{premise:"",genre:"",audience:"",characters:"",mustKeep:"",mustNotChange:"",currentText:""}},state:"reserved",executorId:"legacy",leaseUntil:new Date(Date.now()+240000).toISOString(),errorCode:null,providerRequestId:null,responseModel:null,usage,candidate:null,confirmedRequestId:null,createdAt:now,finishedAt:null};
    expect(await new PostgresWritingCandidateStore(pool).create(legacy,limits(1))).toEqual({kind:"blocked",code:"WRITING_CANDIDATE_DAILY_CAP"});
  });
  it("shares active concurrency in both directions with legacy title writing",async()=>{
    const w=await world(),r=await create(w);
    const active=await tx(c=>runningWritingRuns(c,w.workspaceId));expect(active).toEqual([expect.objectContaining({kind:"vimax",id:r.id,projectId:w.projectId})]);
    const other=await scalar("INSERT INTO project(workspace_id,title) VALUES($1,'Legacy concurrency synthetic') RETURNING id",[w.workspaceId]);
    const now=new Date().toISOString();const title:TitleRunRecord={id:randomUUID(),workspaceId:w.workspaceId,projectId:other,actorId:actor,idempotencyKey:randomUUID(),inputHash:"a".repeat(64),
      input:{schema:"ads.title-writing.input.v1",promptVersion:"ads.title-writing.prompt.v1",title:"Synthetic title",settings:{episodeCount:3,episodeSeconds:90,style:""},providerKey:"openai",model:"synthetic-model"},
      state:"running",errorCode:null,cancelRequestedAt:null,executorId:null,leaseUntil:null,callCap:8,callsUsed:0,storySave:"pending",storyRevisionId:null,createdAt:now,updatedAt:now};
    const titles=new PostgresTitleWritingStore(pool,chain);expect(await titles.createRun(title,{maxActiveRuns:1})).toEqual({kind:"blocked",code:"TITLE_WRITING_ACTIVE_RUN_CAP"});
    await store.cancel(w.workspaceId,w.projectId,w.episodeId,actor,r.id,new Date().toISOString());
    expect((await titles.createRun(title,{maxActiveRuns:1})).kind).toBe("created");
    expect(await store.create(reservation(w),{...limits(),maxActiveRuns:1})).toEqual({kind:"blocked",code:"VIMAX_PLANNING_ACTIVE_CAP"});
    expect(await count(w)).toBe(1);
  });
  it("SQL rejects forged start states, mutable identities, terminal rewrites and receipt deletion",async()=>{
    const w=await world(),r=await create(w);await expect(pool.query("UPDATE vimax_planning_request SET model='changed' WHERE id=$1",[r.id])).rejects.toMatchObject({code:"23514"});
    await store.cancel(w.workspaceId,w.projectId,w.episodeId,actor,r.id,new Date().toISOString());
    await expect(pool.query("UPDATE vimax_planning_request SET state='reserved' WHERE id=$1",[r.id])).rejects.toMatchObject({code:"23514"});
    await expect(pool.query("DELETE FROM vimax_planning_request WHERE id=$1",[r.id])).rejects.toMatchObject({code:"23514"});
  });
});
