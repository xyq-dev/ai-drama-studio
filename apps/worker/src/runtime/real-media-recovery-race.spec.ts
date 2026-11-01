import { describe, expect, it, vi } from "vitest";
import type { RealMediaExecution } from "@ai-drama/database";
import { RealMediaRecovery, type RealMediaWorkerDependencies } from "./real-media-job";

/** A receipt may commit between the recoverable-list snapshot and the successful owner CAS. No network is used. */
describe("real media recovery rechecks receipt after claiming ownership",()=>{
  it("does not classify a newly committed submission as never sent from an old list snapshot",async()=>{
    const listed={workspaceId:"workspace",projectId:"project",shotRevisionId:"shot",jobId:"job",dispatchSeq:1,state:"RUNNING",cancelRequested:false,inputHash:"a".repeat(64),attemptId:"attempt",providerRequestId:null,receiptState:null,outputs:null,
      inputSnapshot:{schema:"real-media.v1",capability:"image.generate",configuration:{id:"provider",queryAllowed:true}}} as unknown as RealMediaExecution;
    const current={...listed,state:"WAITING_EXTERNAL",providerRequestId:"committed-task",receiptState:"ACKNOWLEDGED" as const};
    const failJob=vi.fn(),inspect=vi.fn(async()=>({state:"ACTIVE",normalizedEventKey:"poll:active",responseHash:"b".repeat(64)}));
    const dependencies={jobs:{failJob,recordProviderEvent:vi.fn()},store:{claimRecovery:vi.fn(async()=>true),
      loadExecution:vi.fn(async()=>current),renewDeliveryLease:vi.fn(async()=>true),releaseDeliveryLease:vi.fn(),defer:vi.fn()},
      adapterFor:vi.fn(async()=>({inspect,submit:vi.fn(()=>{throw new Error("Recovery may never submit");})}))} as unknown as RealMediaWorkerDependencies;
    await new RealMediaRecovery(dependencies).recover(listed);
    expect(failJob).not.toHaveBeenCalled();expect(inspect).toHaveBeenCalledExactlyOnceWith("committed-task");
  });
});
