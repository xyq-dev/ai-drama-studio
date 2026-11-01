import { beforeEach,describe,expect,it,vi } from "vitest";
import type { RealMediaConfiguration,RealMediaSnapshot,SpeechGenerationInput } from "@ai-drama/contracts";
import { assertSpeechBatchDispatchInTransaction,assertSpeechGenerationInputInTransaction,bindSpeechBatchJobInTransaction,PersistenceError } from "@ai-drama/database";
import { RealMediaService,type RealMediaServiceOptions } from "./real-media.service";

vi.mock("@ai-drama/database",async importOriginal=>({
  ...await importOriginal<typeof import("@ai-drama/database")>(),
  assertSpeechBatchDispatchInTransaction:vi.fn(async()=>undefined),
  assertSpeechGenerationInputInTransaction:vi.fn(async()=>undefined),
  bindSpeechBatchJobInTransaction:vi.fn(async()=>undefined),
}));
const quoteId="11111111-1111-4111-8111-111111111111",budgetAuthorizationId="22222222-2222-4222-8222-222222222222";
const configuration:RealMediaConfiguration={id:"provider",version:"v1",providerKey:"dashscope-media",capability:"audio.tts",model:"qwen3-tts-flash",region:"cn-beijing",
  credentialRef:"server:key",credentialVersion:"1",enabled:true,queryAllowed:true,priceVersion:"price1",currency:"CNY",unitPrice:"0.001",unitType:"character",parameters:{}};
const speech:SpeechGenerationInput={workspaceId:"workspace",projectId:"project",shotRevisionId:"shot",planRevisionId:"plan",lineId:"line",lineInputRevisionId:"line-input",
  inputHash:"a".repeat(64),displayText:" 原样对白。 ",spokenText:" 原样对白。 ",voice:{} as SpeechGenerationInput["voice"],emotion:"neutral",speed:1};
function fixture(){
  const client={query:vi.fn()},events:string[]=[];
  const created={jobId:"job",workflowRunId:"workflow",dispatchSeq:1};
  const receipt={status:202,body:created,replayed:false};
  const snapshot:RealMediaSnapshot={schema:"real-media.v1",shotRevisionId:"shot",capability:"audio.tts",sourceText:speech.spokenText,sourceHash:"b".repeat(64),configuration,speech,
    budget:{quoteId,authorizationId:budgetAuthorizationId,currency:"CNY",estimatedAmount:"0.01",maximumAmount:"0.01",priceVersion:"price1",authorizedBy:"actor",authorizedAt:"2026-11-01T00:00:00Z",expiresAt:"2026-11-01T00:05:00Z"}};
  const consumeAuthorization=vi.fn(async()=>{events.push("consume");return snapshot;});
  const bindAuthorization=vi.fn(async()=>{events.push("authorization-bound");});
  const jobs=vi.fn(async(_scope:unknown,resolve:(client:unknown)=>Promise<unknown>,after:(client:unknown,created:unknown)=>Promise<void>)=>{
    await resolve(client);await after(client,created);return receipt;
  });
  const authorize=vi.fn(async()=>({budgetAuthorizationId}));
  const options={workspaceId:"workspace",enabled:true,store:{receiptReady:()=>true,requireReady:async()=>undefined,consumeAuthorization,bindAuthorization,authorize},
    jobs:{createAndQueueWorkflowJob:jobs},assets:{prepareRealShotGenerationInTransaction:async()=>({dialogue:speech.spokenText})},configurationFor:async()=>configuration} as unknown as RealMediaServiceOptions;
  return {client,created,receipt,events,jobs,consumeAuthorization,bindAuthorization,authorize,options,service:new RealMediaService(options)};
}
beforeEach(()=>vi.clearAllMocks());
describe("real-media speech batch integration",()=>{
  it("checks batch ownership on ordinary generation before consuming any authorization",async()=>{
    const f=fixture();vi.mocked(assertSpeechBatchDispatchInTransaction).mockRejectedValueOnce(new PersistenceError("SPEECH_BATCH_CONFIRMATION_CHANGED","Batch dispatch reference required"));
    await expect(f.service.generate("project","shot",{quoteId,budgetAuthorizationId},{actorId:"actor",traceId:"trace",idempotencyKey:"single-key"})).rejects.toMatchObject({code:"SPEECH_BATCH_CONFIRMATION_CHANGED"});
    expect(assertSpeechBatchDispatchInTransaction).toHaveBeenCalledWith(f.client,undefined,expect.objectContaining({quoteId,budgetAuthorizationId,idempotencyKey:"single-key"}));
    expect(f.consumeAuthorization).not.toHaveBeenCalled();expect(f.bindAuthorization).not.toHaveBeenCalled();
  });
  it("keeps dispatch tokens outside frozen speech and permanent request identity, and binds the same Job atomically",async()=>{
    const f=fixture(),ref={batchId:"batch",operationId:"operation",dispatchToken:"first-owner"};
    await expect(f.service.speechPort().generate({...speech,quoteId,budgetAuthorizationId,actorId:"actor",traceId:"trace",idempotencyKey:"operation-key",batchOperation:ref})).resolves.toEqual({jobId:"job",workflowRunId:"workflow",reused:false});
    expect(assertSpeechBatchDispatchInTransaction).toHaveBeenCalledWith(f.client,ref,{speech,quoteId,budgetAuthorizationId,idempotencyKey:"operation-key",actorId:"actor"});
    expect(assertSpeechGenerationInputInTransaction).toHaveBeenCalledWith(f.client,speech);
    expect(bindSpeechBatchJobInTransaction).toHaveBeenCalledWith(f.client,ref,f.created);
    expect(f.events).toEqual(["consume","authorization-bound"]);
    const originalScope=f.jobs.mock.calls[0]![0];
    f.jobs.mockImplementationOnce(async()=>({...f.receipt,replayed:true}));
    const result=await f.service.speechPort().generate({...speech,quoteId,budgetAuthorizationId,actorId:"actor",traceId:"new-trace",idempotencyKey:"operation-key",batchOperation:{...ref,dispatchToken:"new-owner"}});
    expect(result.reused).toBe(true);expect(f.jobs.mock.calls[1]![0]).toEqual(originalScope);
    expect(assertSpeechBatchDispatchInTransaction).toHaveBeenCalledTimes(1);expect(f.consumeAuthorization).toHaveBeenCalledTimes(1);expect(bindSpeechBatchJobInTransaction).toHaveBeenCalledTimes(1);
  });
  it("authorizes only the quoted bounded operation from the server batch port",async()=>{
    const f=fixture(),port=f.service.speechPort();
    await expect(port.authorize!({workspaceId:"workspace",projectId:"project",actorId:"actor",quoteId,maximumAmount:"0.01",confirmedUncertainJobIds:[],idempotencyKey:"authorization-key"})).resolves.toEqual({budgetAuthorizationId});
    expect(f.authorize).toHaveBeenCalledWith({workspaceId:"workspace",projectId:"project",actorId:"actor",quoteId,maximumAmount:"0.01",confirmedUncertainJobIds:[],confirmSinglePaidOperation:true});
    await expect(port.authorize!({workspaceId:"other",projectId:"project",actorId:"actor",quoteId,maximumAmount:"0.01",confirmedUncertainJobIds:[],idempotencyKey:"other-key"})).rejects.toMatchObject({code:"NOT_FOUND"});
    expect(f.authorize).toHaveBeenCalledTimes(1);
  });
});
