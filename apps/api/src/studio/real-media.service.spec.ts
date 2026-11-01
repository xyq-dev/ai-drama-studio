import { describe,expect,it,vi } from "vitest";
import type { RealMediaServiceOptions } from "./real-media.service";
import { RealMediaService } from "./real-media.service";
function options(){
  const raw={workspaceId:"workspace",enabled:true,store:{receiptReady:()=>true,storageReady:async()=>true,requireReady:async()=>undefined,
    authorize:vi.fn(),createQuote:vi.fn()},jobs:{createAndQueueWorkflowJob:vi.fn()},assets:{},configurationFor:vi.fn(async()=>null)};
  return {raw,typed:raw as unknown as RealMediaServiceOptions};
}
describe("explicit real-media budget API",()=>{
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
