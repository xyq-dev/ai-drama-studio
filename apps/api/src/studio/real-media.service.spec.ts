import { describe,expect,it,vi } from "vitest";
import type { RealMediaServiceOptions } from "./real-media.service";
import { RealMediaService } from "./real-media.service";
function options(){
  const raw={workspaceId:"workspace",enabled:true,store:{receiptReady:()=>true,storageReady:async()=>true,requireReady:async()=>undefined,
    authorize:vi.fn(),createQuote:vi.fn()},jobs:{createAndQueueWorkflowJob:vi.fn()},assets:{},configurationFor:vi.fn(async()=>null)};
  return {raw,typed:raw as unknown as RealMediaServiceOptions};
}
describe("explicit real-media budget API",()=>{
  it("reports the kept OpenAI storyboard as the selected image without reporting it as a ComfyUI job", async () => {
    const o = options();
    const query = vi.fn(async (sql: string, _values: string[]) => {
      if (sql.includes("SELECT 1 FROM shot_revision") || sql.includes("to_regclass('comfyui_shot_image_selection')")) return { rows: [{ ready: true }] };
      if (sql.includes("SELECT selected.asset_id") && sql.includes("'openai-media'")) return { rows: [{ asset_id: "retained-openai-image" }] };
      return { rows: [] };
    });
    const service = new RealMediaService({
      ...o.typed,
      store: { ...o.raw.store, transaction: async (work: (client: unknown) => Promise<unknown>) => work({ query }) } as unknown as RealMediaServiceOptions["store"],
    });
    await expect(service.comfyUiShot("project", "shot-revision")).resolves.toMatchObject({
      selectedAssetId: "retained-openai-image", selectionAvailable: true, jobs: [],
    });
    const [selectionSql, selectionScope] = query.mock.calls.find(([sql]) => sql.includes("SELECT selected.asset_id"))!;
    expect(selectionScope).toEqual(["workspace", "project", "shot-revision"]);
    expect(selectionSql).toContain("asset.checksum_sha256=selected.asset_checksum_sha256");
    expect(selectionSql).toContain("job.source_shot_revision_id=asset.source_shot_revision_id");
    expect(selectionSql).toContain("'{configuration,model}'='gpt-image-2.5-sunburst'");
    expect(selectionSql).toContain("'{autoStoryboard,runId}' IS NOT NULL");
    expect(selectionSql).toContain("asset.width=1024 AND asset.height=1536");
    expect(selectionSql).toContain("shot.current_revision_id=revision.id AND shot.approved_revision_id=revision.id");
    expect(selectionSql).toContain("revision.review_status='APPROVED' AND revision.freshness_status='CURRENT'");
    const [jobsSql] = query.mock.calls.find(([sql]) => sql.includes("SELECT job.id,job.state"))!;
    expect(jobsSql).toContain("'comfyui'");
    expect(jobsSql).not.toContain("'openai-media'");
  });
  it.each([["dashscope-media","qwen-image-3.0"],["openai-media","gpt-image-2.5-flare"],
    ["openai-media","dall-e-3"],["comfyui","sd-1.5"]])("refuses %s / %s instead of substituting for Sunburst",async(providerKey,model)=>{
    const o=options();
    const configurationFor=vi.fn(async()=>({providerKey,model,capability:"image.generate",enabled:true}));
    const service=new RealMediaService({...o.typed,objects:{readVerified:vi.fn()},configurationFor} as RealMediaServiceOptions);
    await expect(service.quote("project","shot",{capability:"image.generate",autoStoryboardRunId:"11111111-1111-4111-8111-111111111111"}))
      .rejects.toMatchObject({code:"AUTO_STORYBOARD_OPENAI_UNAVAILABLE"});
    expect(o.raw.store.createQuote).not.toHaveBeenCalled();
    expect(configurationFor).toHaveBeenCalledWith("image.generate",undefined);
  });
  it("keeps new storyboard spends and selections closed without authenticated media delivery",async()=>{
    const o=options(),service=new RealMediaService({...o.typed,readEnabled:false,objects:{readVerified:vi.fn()}});
    const runId="11111111-1111-4111-8111-111111111111";
    await expect(service.quote("project","shot",{capability:"image.generate",autoStoryboardRunId:runId})).rejects.toMatchObject({code:"AUTO_STORYBOARD_OPENAI_UNAVAILABLE"});
    await expect(service.selectAutoStoryboardImage("project",runId,"shot",{assetId:"22222222-2222-4222-8222-222222222222",expectedSelectedAssetId:null}))
      .rejects.toMatchObject({code:"AUTO_STORYBOARD_SELECTION_UNAVAILABLE"});
    expect(o.raw.configurationFor).not.toHaveBeenCalled();
  });
  it("reports independent readiness and freezes only the saved shot and scoped cast after selection is available",async()=>{
    const o=options();
    const ids=(index:number)=>`10000000-0000-4000-8000-${String(index).padStart(12,"0")}`;
    const [workspaceId,projectId,runId,episodeId,shotId,shotRevisionId]=[1,2,3,4,5,6].map(ids) as [string,string,string,string,string,string];
    let selectionAvailable=false;
    const query=vi.fn(async(sql:string)=>({rows:sql.includes("to_regclass('comfyui_shot_image_selection')")?[{selection:selectionAvailable,characters:false}]:
      sql.includes("FOR UPDATE")?[{id:projectId}]:sql.includes("script_revision_replacement")?[{episode_no:1,episode_id:episodeId,
        package_complete:true,story_saved:true,story_approved:true,script_placed:true,script_approved:true,scene_id:ids(7),scene_ready:true,
        shot_id:shotId,shot_revision_id:shotRevisionId,shot_usable:true,action:"推开门"}]:sql.includes("SELECT prompt_text")?[{prompt_text:"  推开门。 "}]:
        sql.includes("AS appearance")?[{name:"林青",appearance:"灰色短外套"}]:[]}));
    const configuration={id:ids(9),capability:"image.generate",providerKey:"openai-media",enabled:true,model:"gpt-image-2.5-sunburst",region:"image.example.test",
      currency:"USD",unitType:"image",unitPrice:"0.04",parameters:{baseUrl:"https://image.example.test",quality:"max",size:"1024x1536"}};
    const service=new RealMediaService({...o.typed,workspaceId,objects:{readVerified:vi.fn()},configurationFor:async()=>configuration,
      store:{...o.raw.store,transaction:async(work:(client:unknown)=>Promise<unknown>)=>work({query})},
      assets:{prepareRealShotGenerationInTransaction:vi.fn()}} as unknown as RealMediaServiceOptions);
    const body={capability:"image.generate",autoStoryboardRunId:runId};
    const view=await service.autoStoryboards(projectId,runId);
    expect(view).toMatchObject({imageAvailable:true,selectionAvailable:false,characterReferencesAvailable:false,
      episodes:[{episodeNo:1,episodeId,blocked:null,shots:[{shotRevisionId,state:"ready",jobId:null,previewAssetId:null}]}]});
    await expect(service.quote(projectId,shotRevisionId,body)).rejects.toMatchObject({code:"AUTO_STORYBOARD_SELECTION_UNAVAILABLE"});
    expect(o.raw.store.createQuote).not.toHaveBeenCalled();
    selectionAvailable=true;
    await service.quote(projectId,shotRevisionId,body);
    expect(o.raw.store.createQuote).toHaveBeenCalledWith({workspaceId,projectId,actorId:"server-owner",
      frozen:{schema:"real-media.v1",capability:"image.generate",shotRevisionId,configuration,autoStoryboard:{runId,shotId},
        sourceHash:expect.stringMatching(/^[a-f0-9]{64}$/u),sourceText:"推开门。\n\n角色形象：林青：灰色短外套"}});
  });
  it("rejects a ComfyUI or reference-image override on an auto storyboard quote",async()=>{
    const o=options(),service=new RealMediaService(o.typed);
    const body={capability:"image.generate",autoStoryboardRunId:"11111111-1111-4111-8111-111111111111"};
    await expect(service.quote("project","shot",{...body,sourceImageAssetId:"22222222-2222-4222-8222-222222222222"})).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    await expect(service.quote("project","shot",{...body,comfyui:{workflowId:"sd15-txt2img",prompt:"other",width:1024,height:1024}})).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    expect(o.raw.configurationFor).not.toHaveBeenCalled();
    expect(o.raw.store.createQuote).not.toHaveBeenCalled();
  });
  it("keeps budget exposure and authenticated historical reads available when paid generation is switched off",async()=>{
    const o=options();const costExposure=vi.fn(async()=>({actualCost:"unknown",unknownSubmissionCount:1,currencies:[]}));
    const service=new RealMediaService({...o.typed,enabled:false,readEnabled:true,objects:{readVerified:vi.fn()},store:{...o.raw.store,costExposure} as unknown as RealMediaServiceOptions["store"]});
    expect(await service.capabilities("project")).toMatchObject({available:false,readAvailable:true});
    await expect(service.costExposure("project")).resolves.toMatchObject({unknownSubmissionCount:1});expect(costExposure).toHaveBeenCalledWith("workspace","project");
    expect(o.raw.configurationFor).not.toHaveBeenCalled();
  });
  it("closes fixed-profile real video under strict references before quote creation or provider selection",async()=>{
    const o=options();const service=new RealMediaService({...o.typed,characterReferenceGate:"strict"});
    await expect(service.quote("project","shot",{capability:"video.generate",sourceImageAssetId:"11111111-1111-4111-8111-111111111111"})).rejects.toMatchObject({code:"REAL_MEDIA_REFERENCE_PROFILE_UNSUPPORTED"});
    expect(o.raw.store.createQuote).not.toHaveBeenCalled();expect(o.raw.configurationFor).not.toHaveBeenCalled();
    expect((await service.capabilities("project")).unavailableCapabilities).toMatchObject({"video.generate":"REAL_MEDIA_REFERENCE_PROFILE_UNSUPPORTED"});
  });
  it("replays a permanent existing job before live feature, storage or provider checks",async()=>{
    const o=options();o.raw.enabled=false;o.raw.store.receiptReady=()=>false;
    o.raw.jobs.createAndQueueWorkflowJob.mockResolvedValueOnce({replayed:true,status:202,body:{jobId:"original",workflowRunId:"workflow",dispatchSeq:1}});
    const result=await new RealMediaService(o.typed).generate("project","shot",{quoteId:"11111111-1111-4111-8111-111111111111",budgetAuthorizationId:"22222222-2222-4222-8222-222222222222"},{actorId:"actor",traceId:"trace",idempotencyKey:"permanent-key"});
    expect(result.body.jobId).toBe("original");expect(o.raw.configurationFor).not.toHaveBeenCalled();
  });
  it("preserves exact dialogue whitespace in a TTS quote",async()=>{
    const o=options();const createQuote=vi.fn();
    const typed={...o.typed,configurationFor:async()=>({id:"provider",version:"v1",providerKey:"dashscope-media",capability:"audio.tts",enabled:true}),
      store:{...o.raw.store,createQuote,transaction:async(work:(client:unknown)=>Promise<unknown>)=>work({})},
      assets:{prepareRealShotGenerationInTransaction:async()=>({promptText:"prompt",dialogue:"  原样对白。  "})}} as unknown as RealMediaServiceOptions;
    await new RealMediaService(typed).quote("project","shot",{capability:"audio.tts"});
    expect(createQuote).toHaveBeenCalledWith(expect.objectContaining({frozen:expect.objectContaining({sourceText:"  原样对白。  "})}));
  });
  it("fails closed before quote or job creation without private receipt storage",async()=>{
    const o=options();o.raw.store.receiptReady=()=>false;const service=new RealMediaService(o.typed);
    expect(await service.capabilities("project")).toMatchObject({available:false,reasonCode:"REAL_MEDIA_NOT_READY"});
    await expect(service.quote("project","shot",{capability:"image.generate"})).rejects.toThrow(/configured/);
    expect(o.raw.store.createQuote).not.toHaveBeenCalled();expect(o.raw.jobs.createAndQueueWorkflowJob).not.toHaveBeenCalled();
  });
  it("requires explicit confirmation and rejects client provider, URL or price injection",async()=>{
    const o=options();const service=new RealMediaService(o.typed);
    for(const body of [{quoteId:"11111111-1111-4111-8111-111111111111",maximumAmount:"0.18"},{quoteId:"11111111-1111-4111-8111-111111111111",maximumAmount:"0.18",confirmSinglePaidOperation:false}])await expect(service.authorize("project",body)).rejects.toThrow(/Confirm/);
    await expect(service.quote("project","shot",{capability:"image.generate",providerKey:"evil",url:"https://evil",unitPrice:"0"})).rejects.toThrow(/Invalid/);
    expect(o.raw.store.authorize).not.toHaveBeenCalled();expect(o.raw.configurationFor).not.toHaveBeenCalled();
  });
  it("requires a request key and accepts no unquoted job body",async()=>{
    const o=options();const service=new RealMediaService(o.typed);const body={quoteId:"11111111-1111-4111-8111-111111111111",budgetAuthorizationId:"22222222-2222-4222-8222-222222222222"};
    await expect(service.generate("project","shot",body,{actorId:"actor",traceId:"trace"})).rejects.toThrow(/idempotency/i);
    await expect(service.generate("project","shot",{...body,inputSnapshot:{}},{actorId:"actor",traceId:"trace",idempotencyKey:"key"})).rejects.toThrow(/Invalid/);
    expect(o.raw.jobs.createAndQueueWorkflowJob).not.toHaveBeenCalled();
  });
});
