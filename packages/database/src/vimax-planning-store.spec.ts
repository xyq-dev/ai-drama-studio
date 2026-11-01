import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { vimaxPlanningStartSchema, vimaxPlatformSourceSnapshotSchema, type VimaxPlanningReservation, type VimaxPlanningRecord } from "@ai-drama/contracts";
import { freezeVimaxPlanning, hashVimaxPlanningRequest } from "@ai-drama/domain";
import { PostgresVimaxPlanningStore, VIMAX_PLANNING_COLUMNS } from "./vimax-planning-store";
import { recentWritingCalls } from "./writing-candidate-store";
import type { DatabasePool } from "./job-service";
const W="11111111-1111-4111-8111-111111111111", ID="99999999-9999-4999-8999-999999999994", NOW="2026-11-01T01:00:00.000Z", LATER="2026-11-01T01:04:00.000Z";
type Row=Record<string,unknown>;
function setup(options:{ready?:boolean;probeError?:boolean;existing?:boolean;pending?:boolean;active?:boolean;shots?:number;sourceChanged?:boolean;prior?:Row[];recent?:number;planningActive?:Row[];titleActive?:Row[];state?:VimaxPlanningRecord["state"]}={}) {
  const raw=JSON.parse(readFileSync(resolve(__dirname,"../../../scripts/vimax-evaluation/fixtures/single-scene.json"),"utf8")), i=raw.input;
  const source=vimaxPlatformSourceSnapshotSchema.parse({schema:"ads.vimax-platform-source.v1",scriptRevisionNo:1,projectId:i.projectId,episodeId:i.episodeId,episodeNo:i.episodeNo,scriptRevisionId:i.scriptRevisionId,scriptContentHash:i.scriptContentHash,scriptText:i.scriptText,characters:i.characters});
  const request=vimaxPlanningStartSchema.parse({schema:"ads.vimax-planning.start.v1",target:{sceneId:"99999999-9999-4999-8999-999999999991",sceneRevisionId:"99999999-9999-4999-8999-999999999992",rowVersion:3},source:{scriptRevisionId:i.scriptRevisionId,scriptContentHash:i.scriptContentHash,characters:i.characters},sceneSpans:i.sceneSpans,selectedSceneKeys:i.selectedSceneKeys,sourceDialogue:i.sourceDialogue,requirements:i.requirements,confirmedTextSend:true});
  const target={...request.target,sourceScriptRevisionId:i.scriptRevisionId,ordinal:1,heading:i.sceneSpans[0].heading,timeOfDay:"夜",summary:"原场景",locationRevisionId:null};
  const frozen=freezeVimaxPlanning(source,target,request,"openai","fixture-model");if(!frozen.ok)throw new Error("fixture blocked");
  const reservation:VimaxPlanningReservation={id:ID,workspaceId:W,projectId:source.projectId,episodeId:source.episodeId,actorId:"a",idempotencyKey:"key",requestHash:hashVimaxPlanningRequest(source.projectId,source.episodeId,request),request,providerKey:"openai",model:"fixture-model",executorId:"exec",leaseUntil:LATER,createdAt:NOW};
  const state=options.state??"reserved";
  const row:Row={id:ID,workspace_id:W,project_id:source.projectId,episode_id:source.episodeId,actor_id:"a",idempotency_key:"key",request_hash:reservation.requestHash,frozen_hash:frozen.frozenHash,frozen_json:frozen.input,source_script_revision_id:source.scriptRevisionId,scene_id:target.sceneId,baseline_scene_revision_id:target.sceneRevisionId,baseline_scene_row_version:3,provider_key:"openai",model:"fixture-model",state,executor_id:["reserved","submitted"].includes(state)?"exec":null,lease_until:["reserved","submitted"].includes(state)?LATER:null,submitted_at:state==="reserved"?null:NOW,error_code:state==="unknown"?"executor_lost":null,provider_request_id:null,response_model:null,usage_json:{status:"unknown",inputTokens:null,outputTokens:null,totalTokens:null},billing_status:"unknown",output_json:null,created_at:NOW,finished_at:["reserved","submitted"].includes(state)?null:NOW};
  const calls:{sql:string;values:unknown[]}[]=[];
  const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
    calls.push({sql,values});
    if(sql.includes("obj_description")){if(options.probeError)throw new Error("probe connection failure");return {rows:[{version:options.ready===false?null:"ads.vimax-planning.storage.v1",columns:VIMAX_PLANNING_COLUMNS.length,guards:1}]};}
    if(sql.includes("to_regclass('auto_creation_run')"))return {rows:[{vimax:true}]};
    if(sql.startsWith("SELECT id, project_id FROM vimax_planning_request"))return {rows:options.planningActive??[]};
    if(sql.startsWith("SELECT id, project_id FROM title_writing_run"))return {rows:options.titleActive??[]};
    if(sql.includes("SELECT id, state, actor_id"))return {rows:options.prior??[]};
    if(sql.includes("FROM vimax_planning_request")) {
      if(sql.includes("count(*)"))return {rows:[{recent:options.recent??0}]};
      if(sql.includes("idempotency_key=$3"))return {rows:options.existing?[row]:[]};
      return {rows:[row]};
    }
    if(sql.includes("to_regclass('title_writing_call')"))return {rows:[{vimax:true}]};
    if(sql.includes("FROM project"))return {rows:[{id:source.projectId,writing_mode:"short"}]};
    if(sql.includes("FROM episode"))return {rows:[{id:source.episodeId,episode_no:source.episodeNo,current_script_revision_id:source.scriptRevisionId,approved_script_revision_id:options.sourceChanged?null:source.scriptRevisionId}]};
    if(sql.includes("FROM script_revision"))return {rows:[{revision_no:1,content_json:{text:source.scriptText},review_status:"APPROVED",freshness_status:"CURRENT"}]};
    if(sql.includes("FROM character c"))return {rows:source.characters.map(c=>({id:c.characterId,current_revision_id:c.revisionId,revision_id:c.revisionId,name:c.name,freshness_status:"CURRENT"}))};
    if(sql.includes("FROM stale_recalculation"))return {rows:options.pending?[{}]:[]};
    if(sql.includes("FROM title_writing_run"))return {rows:options.active?[{}]:[]};
    if(sql.includes("FROM scene s"))return {rows:[{scene_id:target.sceneId,row_version:3,archived_at:null,scene_revision_id:target.sceneRevisionId,source_script_revision_id:source.scriptRevisionId,ordinal:1,heading:target.heading,time_of_day:"夜",summary:"原场景",location_revision_id:null,freshness_status:"CURRENT",active_shot_count:options.shots??0}]};
    if(sql.startsWith("INSERT INTO vimax_planning_request"))return {rows:[row],rowCount:1};
    if(sql.startsWith("UPDATE vimax_planning_request"))return {rows:[],rowCount:1};
    return {rows:[]};
  });
  const release=vi.fn();const store=new PostgresVimaxPlanningStore({connect:async()=>({query,release})} as unknown as DatabasePool);
  return {store,query,calls,row,reservation,source,raw,release};
}
const mutations=(calls:{sql:string}[])=>calls.filter(c=>/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/.test(c.sql));
const limits={sinceIso:"2026-10-31T01:00:00.000Z",maxCallsPerDay:10,maxActiveRuns:10};
describe("persistent governed planning transactions",()=>{
  it("fails closed without draft storage and never runs DDL",async()=>{
    const h=setup({ready:false});expect(await h.store.storageReady()).toBe(false);await expect(h.store.create(h.reservation,limits)).rejects.toMatchObject({code:"VIMAX_PLANNING_STORAGE_UNAVAILABLE"});expect(mutations(h.calls)).toEqual([]);expect(h.calls.some(c=>c.sql.includes("FROM project"))).toBe(false);
  });
  it("does not disguise query failures as missing schema",async()=>{const h=setup({probeError:true});await expect(h.store.storageReady()).rejects.toThrow("probe connection failure");expect(h.release).toHaveBeenCalledOnce();});
  it("replays original keys before checking changed sources, quotas or providers",async()=>{
    const h=setup({existing:true,sourceChanged:true,recent:999});expect((await h.store.create(h.reservation,limits)).kind).toBe("existing");expect(mutations(h.calls)).toEqual([]);expect(h.calls.some(c=>c.sql.includes("FROM project"))).toBe(false);
    h.reservation.request.requirements.style+=" ";h.reservation.requestHash=hashVimaxPlanningRequest(h.reservation.projectId,h.reservation.episodeId,h.reservation.request);expect((await h.store.create(h.reservation,limits)).kind).toBe("conflict");
  });
  it.each([{pending:true,code:"SOURCE_STALE"},{active:true,code:"VIMAX_PLANNING_ACTIVE_BREAKDOWN"},{shots:1,code:"VIMAX_PLANNING_HAS_SHOTS"},{sourceChanged:true,code:"VIMAX_PLANNING_SOURCE_CHANGED"},{recent:10,code:"VIMAX_PLANNING_DAILY_CAP"}])("refuses %o with zero reservations",async({code,...options})=>{
    const h=setup(options);expect(await h.store.create(h.reservation,limits)).toEqual({kind:"blocked",code});expect(mutations(h.calls)).toEqual([]);
  });
  it("reserves under run → call → project → episode → scene ordering and shares the daily cap",async()=>{
    const h=setup();expect((await h.store.create(h.reservation,limits)).kind).toBe("created");
    const locks=h.calls.filter(c=>c.sql.includes("advisory")||c.sql.includes("FOR UPDATE"));expect(locks[0]!.values).toEqual([`title_writing_run:${W}`]);expect(locks[1]!.values).toEqual([`title_writing_call:${W}`]);
    expect(locks.findIndex(c=>c.sql.includes("FROM project"))).toBeLessThan(locks.findIndex(c=>c.sql.includes("FROM episode")));expect(locks.at(-1)!.sql).toContain("FOR UPDATE OF s");expect(mutations(h.calls)).toHaveLength(1);
    expect(h.calls.some(c=>c.sql.includes("count(*)::int AS recent FROM vimax_planning_request"))).toBe(true);
  });
  it("enforces the shared active cap and refuses a project owned by an existing writing run",async()=>{
    const h=setup({planningActive:[{id:ID,project_id:"other-project"}]});expect(await h.store.create(h.reservation,{...limits,maxActiveRuns:1})).toEqual({kind:"blocked",code:"VIMAX_PLANNING_ACTIVE_CAP"});expect(mutations(h.calls)).toEqual([]);
    const same=setup();const sqlTitle=same.query.getMockImplementation()!;same.query.mockImplementation(async(sql,values=[])=>sql.startsWith("SELECT id, project_id FROM title_writing_run")?{rows:[{id:ID,project_id:same.source.projectId}]}:sqlTitle(sql,values));
    expect(await same.store.create(same.reservation,limits)).toEqual({kind:"blocked",code:"VIMAX_PLANNING_PROJECT_ACTIVE"});
  });
  it("blocks an active target and requires confirmation of the same actor's latest UNKNOWN",async()=>{
    const open=setup({prior:[{id:ID,state:"submitted",actor_id:"a"}]});expect(await open.store.create(open.reservation,limits)).toEqual({kind:"active",requestId:ID});
    const unknown=setup({prior:[{id:ID,state:"unknown",actor_id:"a"}]});expect(await unknown.store.create(unknown.reservation,limits)).toEqual({kind:"needs_confirmation",requestId:ID});
    unknown.reservation.request.confirmUncertainRequestId=ID;unknown.reservation.requestHash=hashVimaxPlanningRequest(unknown.reservation.projectId,unknown.reservation.episodeId,unknown.reservation.request);expect((await unknown.store.create(unknown.reservation,limits)).kind).toBe("created");
  });
  it("rechecks sources before submitted CAS and closes changed inputs without a send",async()=>{
    const h=setup({sourceChanged:true});expect(await h.store.markSubmitted(W,ID,"exec",NOW,LATER)).toBe(false);expect(mutations(h.calls)).toEqual([expect.objectContaining({sql:expect.stringContaining("source_changed_before_send")})]);
    const live=setup();expect(await live.store.markSubmitted(W,ID,"exec",NOW,LATER)).toBe(true);expect(mutations(live.calls)[0]!.sql).toContain("lease_until>$4 AND lease_until>clock_timestamp()");
  });
  it("rejects expired and foreign executors without changing the row",async()=>{
    const h=setup();expect(await h.store.markSubmitted(W,ID,"other",NOW,LATER)).toBe(false);expect(await h.store.markSubmitted(W,ID,"exec",LATER,LATER)).toBe(false);expect(mutations(h.calls)).toEqual([]);
  });
  it("serves historical reads without consulting live sources and detects hash corruption",async()=>{
    const h=setup({state:"unknown",sourceChanged:true});expect((await h.store.get(W,h.source.projectId,h.source.episodeId,"a",ID))?.state).toBe("unknown");expect(h.calls.some(c=>c.sql.includes("FROM project"))).toBe(false);expect(mutations(h.calls)).toEqual([]);
    h.row.frozen_hash="0".repeat(64);await expect(h.store.getById(W,ID)).rejects.toMatchObject({code:"VIMAX_PLANNING_CORRUPT"});
  });
  it("cannot finish after recovery and cannot substitute new request requirements into a valid answer",async()=>{
    const h=setup({state:"unknown"});const patch={state:"unknown" as const,errorCode:"timeout",providerRequestId:null,responseModel:null,usage:{status:"unknown" as const,inputTokens:null,outputTokens:null,totalTokens:null},output:null};expect(await h.store.finish(W,ID,"exec",patch,NOW)).toBe(false);expect(mutations(h.calls)).toEqual([]);
    const live=setup({state:"submitted"});const r=live.reservation.request;const output={schema:"ads.vimax-candidate.create.v1" as const,target:r.target,request:{schema:"ads.vimax-platform-preview.request.v1" as const,source:r.source,sceneSpans:r.sceneSpans,selectedSceneKeys:r.selectedSceneKeys,sourceDialogue:r.sourceDialogue,requirements:{...r.requirements,style:r.requirements.style+" changed"},candidate:live.raw.candidate,supplements:live.raw.supplements}};
    await expect(live.store.finish(W,ID,"exec",{...patch,state:"completed",errorCode:null,output},NOW)).rejects.toMatchObject({code:"VALIDATION_ERROR"});
  });
  it("recovery and cancel are scoped CAS bookkeeping without network or new reservation",async()=>{
    const h=setup({state:"submitted"});await h.store.recoverExpired(W,LATER);expect(mutations(h.calls)[0]!.sql).toContain("THEN 'unknown'");expect(mutations(h.calls)[0]!.sql).toContain("lease_until<=$2");
    await h.store.cancel(W,h.source.projectId,h.source.episodeId,"a",ID,NOW);expect(mutations(h.calls).at(-1)!.sql).toContain("state='reserved'");expect(mutations(h.calls).every(c=>c.sql.startsWith("UPDATE"))).toBe(true);
  });
  it("all legacy callers of the shared quota count planning reservations conservatively",async()=>{
    const query=vi.fn(async(sql:string)=>({rows:sql.includes("to_regclass")?[{title:true,candidate:true,auto:true,series:true,vimax:true}]:[{recent:1}]}));
    expect(await recentWritingCalls({query} as never,W,NOW)).toBe(5);const planning=query.mock.calls.find(c=>c[0].includes("FROM vimax_planning_request"))![0];expect(planning).not.toContain("state");
  });
  it("keeps SQL opt-in and protects immutable identity, terminal receipts and send evidence",()=>{
    const sql=readFileSync(resolve(__dirname,"../prisma/drafts/20261101000100_vimax_planning_request.sql"),"utf8");expect(sql).toContain("DRAFT ONLY");expect(sql).toContain("UNIQUE (workspace_id,actor_id,idempotency_key)");expect(sql).toContain("Planning receipts are permanent");expect(sql).toContain("NEW.submitted_at IS NOT DISTINCT FROM OLD.submitted_at");expect(sql).toContain("OLD.state='reserved' AND NEW.state='submitted'");
  });
});
