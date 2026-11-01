import { describe,expect,it,vi } from "vitest";
import type { RealMediaExecution } from "@ai-drama/database";
import { MediaSubmissionUnknownError,type MediaSubmitResult } from "@ai-drama/providers";
import { realMediaInputHash } from "@ai-drama/domain";
import { createMediaHeartbeat,RealMediaRecovery,runRealMediaJob,type RealMediaWorkerDependencies } from "./real-media-job";
function execution():RealMediaExecution{
  const result:RealMediaExecution={workspaceId:"workspace",projectId:"project",shotRevisionId:"shot",jobId:"job",dispatchSeq:1,state:"QUEUED",cancelRequested:false,inputHash:"",attemptId:null,providerRequestId:null,receiptState:null,outputs:null,
    inputSnapshot:{schema:"real-media.v1",shotRevisionId:"shot",capability:"audio.tts",sourceText:"你好",sourceHash:"hash",
      configuration:{id:"provider",version:"v1",providerKey:"dashscope-media",capability:"audio.tts",model:"tts",region:"beijing",credentialRef:"fixed-ref",credentialVersion:"v1",enabled:true,queryAllowed:true,priceVersion:"v1",currency:"CNY",unitPrice:"0.1",unitType:"request",parameters:{}},
      budget:{authorizationId:"auth",quoteId:"quote",currency:"CNY",estimatedAmount:"0.1",maximumAmount:"0.1",priceVersion:"v1",authorizedBy:"actor",authorizedAt:"2026-11-01T00:00:00Z",expiresAt:"2027-01-01T00:00:00Z"}}};
  result.inputHash=realMediaInputHash(result.inputSnapshot);return result;
}
function deps(){
  let claimed:RealMediaExecution|null=null;
  const submit=vi.fn(async():Promise<MediaSubmitResult>=>{throw new Error("secret raw provider failure must not escape");});const inspect=vi.fn(async()=>({state:"ACTIVE",normalizedEventKey:"poll"}));
  const values={jobs:{acquireQueuedJob:vi.fn(async()=>({attemptId:"attempt",attemptNo:1})),renewRunningLease:vi.fn(async()=>true),failJob:vi.fn(),recordProviderEvent:vi.fn()},assets:{assertUsableShot:vi.fn()},
    store:{receiptReady:()=>true,configurationStillEnabled:async()=>true,beginSubmission:vi.fn(async()=>true),markUnknown:vi.fn(),rejectSubmission:vi.fn(),defer:vi.fn(),acknowledge:vi.fn(),claimRecovery:vi.fn(async(e:RealMediaExecution)=>{claimed=e;return true;}),loadExecution:vi.fn(async()=>claimed),renewDeliveryLease:vi.fn(async()=>true),releaseDeliveryLease:vi.fn(),assertDeliveryLeaseInTransaction:vi.fn()},
    adapterFor:vi.fn(async()=>({submit,inspect})),objects:{},materialize:vi.fn(),preflightLocal:vi.fn(async()=>undefined)};
  return {values,submit,inspect,dependencies:values as unknown as RealMediaWorkerDependencies};
}
describe("real media receipt recovery",()=>{
  it("renews a long in-flight submission and stops the RUNNING heartbeat before acknowledgement",async()=>{
    vi.useFakeTimers();
    try{
      const d=deps();let resolve!:(value:MediaSubmitResult)=>void;
      d.submit.mockImplementationOnce(()=>new Promise<MediaSubmitResult>(done=>{resolve=done;}));
      const work=runRealMediaJob(execution(),{...d.dependencies,heartbeatIntervalMs:10});await vi.advanceTimersByTimeAsync(0);
      expect(d.submit).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(100);
      expect(d.values.jobs.renewRunningLease.mock.calls.length).toBeGreaterThan(5);
      resolve({kind:"waiting",providerRequestId:"long-task",nextPollAt:new Date().toISOString()});await work;
      expect(d.values.store.acknowledge).toHaveBeenCalledOnce();expect(d.values.store.markUnknown).not.toHaveBeenCalled();
      const lastRenew=d.values.jobs.renewRunningLease.mock.invocationCallOrder.at(-1)!;
      expect(lastRenew).toBeLessThan(d.values.store.acknowledge.mock.invocationCallOrder[0]!);
      expect(d.values.store.renewDeliveryLease).toHaveBeenCalledOnce();
    }finally{vi.useRealTimers();}
  });
  it("retains a late safe receipt after losing ownership and refuses materialization",async()=>{
    const d=deps();d.values.store.renewDeliveryLease.mockResolvedValueOnce(false);
    d.submit.mockResolvedValueOnce({kind:"succeeded",providerRequestId:"late-request",outputs:[{kind:"AUDIO",retrieval:{kind:"URI",uri:"https://private.invalid"}}]});
    await runRealMediaJob(execution(),d.dependencies);
    expect(d.values.store.acknowledge).toHaveBeenCalledWith(expect.objectContaining({providerRequestId:"late-request",outputs:expect.any(Array)}));
    expect(d.values.materialize).not.toHaveBeenCalled();expect(d.values.store.releaseDeliveryLease).toHaveBeenCalledOnce();
  });
  it("allows only one recovery claimant to query or materialize an attempt",async()=>{
    const d=deps();d.values.store.claimRecovery.mockResolvedValueOnce(true).mockResolvedValueOnce(false);const e=execution();e.inputSnapshot.capability="video.generate";
    d.values.store.loadExecution.mockResolvedValueOnce({...e,state:"WAITING_EXTERNAL",attemptId:"attempt",receiptState:"ACKNOWLEDGED",providerRequestId:"task"});
    const recovery=new RealMediaRecovery(d.dependencies);
    await Promise.all([recovery.recover({...e,attemptId:"attempt",receiptState:"ACKNOWLEDGED",providerRequestId:"task"}),recovery.recover({...e,attemptId:"attempt",receiptState:"ACKNOWLEDGED",providerRequestId:"task"})]);
    expect(d.inspect).toHaveBeenCalledOnce();expect(d.values.store.releaseDeliveryLease).toHaveBeenCalledOnce();
  });
  it("serializes heartbeat calls and retains lease-loss evidence",async()=>{
    vi.useFakeTimers();try{const renew=vi.fn(async()=>false);const beat=createMediaHeartbeat(renew,10);await vi.advanceTimersByTimeAsync(15);expect(beat.alive()).toBe(false);await beat.stop();await vi.advanceTimersByTimeAsync(50);expect(renew).toHaveBeenCalledOnce();}finally{vi.useRealTimers();}
  });
  it("fails locally before intent or model submission when media tools are unavailable",async()=>{
    const d=deps();d.values.preflightLocal.mockRejectedValueOnce(new Error("missing ffmpeg"));
    await runRealMediaJob(execution(),d.dependencies);
    expect(d.values.store.beginSubmission).not.toHaveBeenCalled();expect(d.submit).not.toHaveBeenCalled();expect(d.values.store.markUnknown).not.toHaveBeenCalled();
    expect(d.values.jobs.failJob).toHaveBeenCalledWith(expect.objectContaining({retryable:false,errorCode:"REAL_MEDIA_SUBMIT_BLOCKED"}));
  });
  it("persists intent before sending and treats uncertain submission as unknown without failing or retrying",async()=>{
    const d=deps();await runRealMediaJob(execution(),d.dependencies);
    expect(d.values.store.beginSubmission).toHaveBeenCalledOnce();expect(d.submit).toHaveBeenCalledOnce();
    expect(d.values.store.markUnknown).toHaveBeenCalledWith("workspace","job","attempt",expect.any(String));expect(d.values.jobs.failJob).not.toHaveBeenCalled();
    expect(d.values.store.beginSubmission.mock.invocationCallOrder[0]).toBeLessThan(d.submit.mock.invocationCallOrder[0]!);
    await runRealMediaJob({...execution(),state:"WAITING_EXTERNAL",receiptState:"UNKNOWN"},d.dependencies);
    expect(d.submit).toHaveBeenCalledOnce();
  });
  it("preserves an id carried by an uncertain exception before retaining unknown exposure",async()=>{
    const d=deps();d.submit.mockRejectedValueOnce(new MediaSubmissionUnknownError("known-task"));
    await runRealMediaJob(execution(),d.dependencies);
    expect(d.values.store.acknowledge).toHaveBeenCalledWith(expect.objectContaining({providerRequestId:"known-task"}));
    expect(d.values.store.acknowledge.mock.invocationCallOrder[0]).toBeLessThan(d.values.store.markUnknown.mock.invocationCallOrder[0]!);
  });
  it("records a definitive refusal without an id as rejected and never automatically retries",async()=>{
    const d=deps();d.submit.mockResolvedValueOnce({kind:"failed",retryable:false,errorCode:"MEDIA_PROVIDER_REJECTED",errorMessage:"safe"});
    await runRealMediaJob(execution(),d.dependencies);
    expect(d.values.store.rejectSubmission).toHaveBeenCalledWith("workspace","attempt");expect(d.values.store.markUnknown).not.toHaveBeenCalled();
    expect(d.values.jobs.failJob).toHaveBeenCalledWith(expect.objectContaining({retryable:false,errorCode:"MEDIA_PROVIDER_REJECTED"}));
  });
  it("never resolves an adapter or resubmits an unknown attempt without an external id",async()=>{
    const d=deps();await new RealMediaRecovery(d.dependencies).recover({...execution(),state:"WAITING_EXTERNAL",attemptId:"attempt",receiptState:"UNKNOWN"});
    expect(d.values.store.markUnknown).toHaveBeenCalledOnce();expect(d.values.adapterFor).not.toHaveBeenCalled();expect(d.submit).not.toHaveBeenCalled();
  });
  it("queries known asynchronous ids with the frozen config and does not submit",async()=>{
    const d=deps();const e=execution();e.inputSnapshot.capability="video.generate";
    await new RealMediaRecovery(d.dependencies).recover({...e,state:"WAITING_EXTERNAL",attemptId:"attempt",receiptState:"ACKNOWLEDGED",providerRequestId:"task"});
    expect(d.values.adapterFor).toHaveBeenCalledWith(e.inputSnapshot.configuration,"query");expect(d.inspect).toHaveBeenCalledWith("task");expect(d.submit).not.toHaveBeenCalled();
  });
  it("refreshes an expired asynchronous output URL only by querying the original task",async()=>{
    const d=deps();d.values.materialize.mockRejectedValueOnce(new Error("expired output"));const e=execution();e.inputSnapshot.capability="video.generate";
    await new RealMediaRecovery(d.dependencies).recover({...e,state:"WAITING_EXTERNAL",attemptId:"attempt",receiptState:"ACKNOWLEDGED",providerRequestId:"original-task",
      outputs:[{kind:"VIDEO",retrieval:{kind:"URI",uri:"https://expired.invalid"}}]});
    expect(d.inspect).toHaveBeenCalledWith("original-task");expect(d.submit).not.toHaveBeenCalled();
  });
});
