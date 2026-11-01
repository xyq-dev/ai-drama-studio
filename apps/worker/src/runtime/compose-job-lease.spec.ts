import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { COMPOSE_RENDER_PROFILE,type ComposeJobSnapshot } from "@ai-drama/domain";
import { runComposeJob,type ComposeExecution } from "./compose-job";

const spawn=vi.hoisted(()=>vi.fn());
vi.mock("node:child_process",()=>({spawn}));
const roots:string[]=[];
const uid=(value:string)=>`${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-8${value.repeat(3)}-${value.repeat(12)}`;
function deferred(){let resolve:()=>void=()=>undefined;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function root(){const path=await mkdtemp(join(tmpdir(),"compose-lease-"));roots.push(path);return path;}
let renderGate=deferred(),renderStarted=deferred();
beforeEach(()=>{
  renderGate=deferred();renderGate.resolve();renderStarted=deferred();
  spawn.mockReset().mockImplementation((_command:string,args:string[])=>{
    const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null as number|null,pid:undefined,kill:vi.fn()});
    void(async()=>{
      await writeFile(args[args.indexOf("--output")+1]!,"encoded-output");renderStarted.resolve();
      await renderGate.promise;child.stdout.write(JSON.stringify({durationMs:1000,elapsedMs:1}));child.exitCode=0;child.emit("close",0);
    })();
    return child;
  });
});
afterEach(async()=>{vi.useRealTimers();vi.restoreAllMocks();await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function fixture(){
  const bytes=Buffer.from("real-source"),hash=createHash("sha256").update(bytes).digest("hex");
  const workspaceId=uid("1"),projectId=uid("2"),jobId=uid("3"),attemptId=uid("4");
  const snapshot={input:{renderProfile:COMPOSE_RENDER_PROFILE,sourceObjects:[{role:"video",assetId:uid("5"),storageProvider:"s3",byteSize:bytes.length,checksumSha256:hash,
    objectKey:`real-media/${workspaceId}/${projectId}/${uid("6")}/${uid("7")}/${hash}.mp4`}]}} as ComposeJobSnapshot;
  const execution:ComposeExecution={workspaceId,projectId,shotRevisionId:uid("8"),jobId,dispatchSeq:1,inputHash:hash,inputSnapshot:snapshot,traceId:"trace"};
  const jobs={acquireQueuedJob:vi.fn(async()=>({attemptId,attemptNo:1})),renewRunningLease:vi.fn(async()=>true),cancelRequested:vi.fn(async()=>false),confirmCancellation:vi.fn(async()=>undefined),failJob:vi.fn(async()=>undefined)};
  const commitLocalCompose=vi.fn(async(_jobs:unknown,_input:{objectKey:string})=>({id:"asset"}));
  const options={jobs:jobs as never,assets:{commitLocalCompose} as never,workDir:await root(),objectDir:await root(),pythonBin:"test-renderer",pythonPath:"",leaseOwner:"owner",leaseMs:30_000};
  return {bytes,execution,jobs,commitLocalCompose,options};
}
describe("real compose whole-attempt lease",()=>{
  it("renews while S3 staging exceeds the original lease and continues through rendering and commit with one heartbeat",async()=>{
    const f=await fixture(),staging=deferred(),staged=deferred(),committing=deferred(),committed=deferred();
    f.commitLocalCompose.mockImplementationOnce(async()=>{committing.resolve();await committed.promise;return {id:"asset"};});
    vi.useFakeTimers();const intervals=vi.spyOn(globalThis,"setInterval");
    const running=runComposeJob(f.execution,{...f.options,objectReader:{stageVerified:async(_source,target)=>{staged.resolve();await staging.promise;await writeFile(target,f.bytes,{flag:"wx"});}}});
    try{
      await staged.promise;await vi.advanceTimersByTimeAsync(45_000);
      expect(spawn).not.toHaveBeenCalled();expect(f.jobs.renewRunningLease.mock.calls.length).toBeGreaterThan(8);
      expect(f.jobs.renewRunningLease).toHaveBeenLastCalledWith(expect.objectContaining({attemptId:uid("4"),leaseOwner:"owner",requireActualClock:true}));
      staging.resolve();await committing.promise;
      const beforeCommitWait=f.jobs.renewRunningLease.mock.calls.length;await vi.advanceTimersByTimeAsync(35_000);
      expect(f.jobs.renewRunningLease.mock.calls.length).toBeGreaterThan(beforeCommitWait+5);
      expect(intervals).toHaveBeenCalledTimes(1);committed.resolve();await running;
      expect(f.commitLocalCompose).toHaveBeenCalledOnce();expect(f.jobs.failJob).not.toHaveBeenCalled();
      const key=f.commitLocalCompose.mock.calls[0]![1].objectKey;
      expect(await readFile(join(f.options.objectDir,key),"utf8")).toBe("encoded-output");
      expect(vi.getTimerCount()).toBe(0);
    }finally{staging.resolve();committed.resolve();await running;}
  });
  it.each(["cancel","lost-owner","database-error"])("discards slow staged bytes after %s without rendering, committing or failing another owner",async(mode)=>{
    const f=await fixture(),staging=deferred(),staged=deferred();vi.useFakeTimers();
    const running=runComposeJob(f.execution,{...f.options,objectReader:{stageVerified:async(_source,target)=>{staged.resolve();await staging.promise;await writeFile(target,f.bytes,{flag:"wx"});}}});
    try{
      await staged.promise;
      if(mode==="database-error")f.jobs.renewRunningLease.mockRejectedValueOnce(new Error("unavailable"));
      else f.jobs.renewRunningLease.mockResolvedValueOnce(false);
      f.jobs.cancelRequested.mockResolvedValue(mode==="cancel");
      await vi.advanceTimersByTimeAsync(5000);staging.resolve();await running;
      expect(spawn).not.toHaveBeenCalled();expect(f.commitLocalCompose).not.toHaveBeenCalled();expect(f.jobs.failJob).not.toHaveBeenCalled();
      expect(f.jobs.confirmCancellation).toHaveBeenCalledTimes(mode==="cancel"?1:0);expect(vi.getTimerCount()).toBe(0);
    }finally{staging.resolve();await running;}
  });
  it("keeps the original Mock renderer-only heartbeat and renewal contract",async()=>{
    const f=await fixture(),mockRoot=await root();renderGate=deferred();
    await writeFile(join(mockRoot,"source.bin"),f.bytes);
    f.execution.inputSnapshot.input.sourceObjects[0]={...f.execution.inputSnapshot.input.sourceObjects[0]!,storageProvider:"mock-object-store",objectKey:"source.bin"};
    vi.useFakeTimers();const running=runComposeJob(f.execution,{...f.options,mockObjectDir:mockRoot});
    try{
      await renderStarted.promise;expect(f.jobs.renewRunningLease).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);expect(f.jobs.renewRunningLease).toHaveBeenCalledTimes(1);
      expect(f.jobs.renewRunningLease).toHaveBeenLastCalledWith(expect.not.objectContaining({requireActualClock:true}));
      renderGate.resolve();await running;expect(f.commitLocalCompose).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    }finally{renderGate.resolve();await running;}
  });
});
