import { randomUUID } from "node:crypto";
import type { RealMediaConfiguration } from "@ai-drama/contracts";
import { assertRealMediaInput,realMediaInputHash } from "@ai-drama/domain";
import { PersistenceError, commitSpeechTake, assertSpeechGenerationInputInTransaction, type JobPersistenceService, type MediaAssetRecord, type MediaAssetStore,
  type RealMediaExecution, type RealMediaStore, type RealMediaReceiptOutput } from "@ai-drama/database";
import { MediaSubmissionUnknownError,type MediaProviderAdapter,type MediaProviderOutput } from "@ai-drama/providers";
import type { RealMediaMaterializer } from "./real-media-materializer";
import type { RealMediaObjectStore } from "./real-media-objects";
export interface RealMediaWorkerDependencies {
  jobs:JobPersistenceService;assets:MediaAssetStore;store:RealMediaStore;objects:RealMediaObjectStore;
  adapterFor(configuration:RealMediaConfiguration,mode:"submit"|"query"):Promise<MediaProviderAdapter>;
  materialize:RealMediaMaterializer;
  preflightLocal():Promise<void>;
  heartbeatIntervalMs?:number;
  leaseMs?:number;
  characterReferenceGate?:"legacy"|"strict";
}
export function createMediaHeartbeat(renew:()=>Promise<boolean>,intervalMs=20_000){
  let live=true;let stopped=false;let tail=Promise.resolve();
  const pulse=async()=>{tail=tail.then(async()=>{if(stopped)return;try{if(!await renew())live=false;}catch{live=false;}});await tail;return live;};
  const timer=setInterval(()=>{void pulse();},intervalMs);timer.unref?.();
  return {pulse,alive:()=>live,async stop(){stopped=true;clearInterval(timer);await tail;}};
}
export async function runRealMediaJob(execution:RealMediaExecution,dependencies:RealMediaWorkerDependencies):Promise<void>{
  if(execution.inputSnapshot.schema!=="real-media.v1")throw new PersistenceError("REAL_MEDIA_INPUT_INVALID","Wrong real media snapshot");
  if(["SUCCEEDED","FAILED","CANCELED"].includes(execution.state))return;
  // Redelivery can only recover the original attempt; it never calls submit again.
  if(execution.state!=="QUEUED")return;
  const snapshot=execution.inputSnapshot;
  const leaseOwner=`real-media:${process.pid}:${randomUUID()}`;
  const acquired=await dependencies.jobs.acquireQueuedJob({workspaceId:execution.workspaceId,jobId:execution.jobId,
    dispatchSeq:execution.dispatchSeq,leaseOwner,leaseMs:dependencies.leaseMs??120_000,traceId:`real-media:${execution.jobId}`,
    providerConfigurationId:snapshot.configuration.id});
  if(!acquired)return;
  const active={...execution,attemptId:acquired.attemptId};
  const runningHeartbeat=createMediaHeartbeat(()=>dependencies.jobs.renewRunningLease({workspaceId:execution.workspaceId,jobId:execution.jobId,
    attemptId:acquired.attemptId,leaseOwner,leaseMs:dependencies.leaseMs??120_000,requireActualClock:true}),dependencies.heartbeatIntervalMs);
  let deliveryHeartbeat:ReturnType<typeof createMediaHeartbeat>|undefined;
  let submitted=false;
  try{
    if(!dependencies.store.receiptReady()||!snapshot.configuration.enabled||!await dependencies.store.configurationStillEnabled(snapshot.configuration))throw new PersistenceError("REAL_MEDIA_NOT_CONFIGURED","Real media is not configured for submission");
    if(realMediaInputHash(snapshot)!==execution.inputHash)throw new PersistenceError("REAL_MEDIA_INPUT_INVALID","Frozen media input hash changed");
    assertRealMediaInput(snapshot);
    if(snapshot.capability==="video.generate"&&dependencies.characterReferenceGate==="strict")throw new PersistenceError("REAL_MEDIA_REFERENCE_PROFILE_UNSUPPORTED","The first-frame video profile cannot prove strict selected character references");
    await dependencies.preflightLocal();
    await dependencies.assets.assertUsableShot(execution.workspaceId,execution.projectId,execution.shotRevisionId,snapshot.capability==="image.generate"?"preview":"approved");
    const adapter=await dependencies.adapterFor(snapshot.configuration,"submit");
    const image=snapshot.sourceImage?await sourceImage(execution,dependencies):undefined;
    // All local validation finishes before intent. From this point every failure conservatively retains exposure.
    if(!await dependencies.store.beginSubmission({execution,attemptId:acquired.attemptId,leaseOwner,characterReferenceGate:dependencies.characterReferenceGate,
      validateInTransaction:async client=>{
        const source=await dependencies.assets.prepareRealShotGenerationInTransaction(client,execution.workspaceId,execution.projectId,execution.shotRevisionId,snapshot.capability);
        if(snapshot.speech)await assertSpeechGenerationInputInTransaction(client,snapshot.speech);
        else if((snapshot.capability==="audio.tts"?source.dialogue??"":source.promptText.trim())!==snapshot.sourceText)throw new PersistenceError("REAL_MEDIA_INPUT_CHANGED","Source changed before sending");
        if(snapshot.sourceImage){
          const found=await client.query(`SELECT a.id FROM asset a JOIN generation_job j ON j.id=a.source_generation_job_id
            WHERE a.id=$1 AND a.workspace_id=$2 AND a.project_id=$3 AND a.source_shot_revision_id=$4 AND a.status='ACTIVE'
              AND a.kind='IMAGE' AND a.checksum_sha256=$5 AND j.state='SUCCEEDED' FOR SHARE OF a,j`,
          [snapshot.sourceImage.assetId,execution.workspaceId,execution.projectId,execution.shotRevisionId,snapshot.sourceImage.checksumSha256]);
          if(!found.rows[0])throw new PersistenceError("REAL_MEDIA_SOURCE_INVALID","First frame changed before sending");
        }
      }}))return;
    submitted=true;
    const result=await adapter.submit({workspaceId:execution.workspaceId,projectId:execution.projectId,shotRevisionId:execution.shotRevisionId,
      generationJobId:execution.jobId,jobAttemptId:acquired.attemptId,providerConfigurationId:snapshot.configuration.id,
      clientRequestKey:`${execution.jobId}:${acquired.attemptNo}`,inputHash:execution.inputHash,inputSnapshot:snapshot,
      traceId:`real-media:${execution.jobId}`,capability:snapshot.capability,...(image?{resolvedSourceImage:image}:{})});
    await runningHeartbeat.stop();
    if(!result.providerRequestId&&(result.kind==="failed"||result.kind==="canceled")){
      await dependencies.store.rejectSubmission(execution.workspaceId,acquired.attemptId);
      await failKnown({...execution,attemptId:acquired.attemptId},dependencies,result.kind==="failed"?result.errorCode:"REAL_MEDIA_PROVIDER_CANCELED",leaseOwner);return;
    }
    if(!result.providerRequestId){await dependencies.store.markUnknown(execution.workspaceId,execution.jobId,acquired.attemptId,leaseOwner);return;}
    await dependencies.store.acknowledge({workspaceId:execution.workspaceId,jobId:execution.jobId,attemptId:acquired.attemptId,
      providerRequestId:result.providerRequestId,usage:result.accounting?.usage,...(result.kind==="succeeded"?{outputs:result.outputs as RealMediaReceiptOutput[]}:{})});
    if(!await dependencies.store.renewDeliveryLease(active,leaseOwner,dependencies.leaseMs))return;
    deliveryHeartbeat=createMediaHeartbeat(()=>dependencies.store.renewDeliveryLease(active,leaseOwner,dependencies.leaseMs),dependencies.heartbeatIntervalMs);
    if(result.kind==="succeeded")await persistOutput({...execution,attemptId:acquired.attemptId,providerRequestId:result.providerRequestId},result.outputs[0],adapter,dependencies,leaseOwner);
    else if(result.kind==="failed"||result.kind==="canceled")await failKnown({...execution,attemptId:acquired.attemptId,providerRequestId:result.providerRequestId},dependencies,result.kind==="failed"?result.errorCode:"REAL_MEDIA_PROVIDER_CANCELED",leaseOwner);
  }catch(error){
    if(submitted){
      if(error instanceof MediaSubmissionUnknownError&&error.providerRequestId)await dependencies.store.acknowledge({workspaceId:execution.workspaceId,
        jobId:execution.jobId,attemptId:acquired.attemptId,providerRequestId:error.providerRequestId});
      await dependencies.store.markUnknown(execution.workspaceId,execution.jobId,acquired.attemptId,leaseOwner);
    }
    else await dependencies.jobs.failJob({workspaceId:execution.workspaceId,jobId:execution.jobId,attemptId:acquired.attemptId,
      traceId:`real-media:local:${execution.jobId}`,errorCode:error&&typeof error==="object"&&"code" in error&&error.code==="REAL_MEDIA_REFERENCE_PROFILE_UNSUPPORTED"?"REAL_MEDIA_REFERENCE_PROFILE_UNSUPPORTED":"REAL_MEDIA_SUBMIT_BLOCKED",errorMessage:"Media submission was blocked before sending",retryable:false,
      beforeFailure:client=>dependencies.store.assertDeliveryLeaseInTransaction(client,active,leaseOwner)});
  }finally{
    await runningHeartbeat.stop();await deliveryHeartbeat?.stop();await dependencies.store.releaseDeliveryLease(active,leaseOwner);
  }
}
async function sourceImage(e:RealMediaExecution,d:RealMediaWorkerDependencies){
  const reference=e.inputSnapshot.sourceImage!;const asset=await d.assets.getWorkspaceAsset(e.workspaceId,reference.assetId);
  if(asset.kind!=="IMAGE"||asset.projectId!==e.projectId||asset.sourceShotRevisionId!==e.shotRevisionId||asset.status!=="ACTIVE"||asset.checksumSha256!==reference.checksumSha256||asset.mimeType!=="image/png")throw new PersistenceError("REAL_MEDIA_SOURCE_INVALID","Frozen source image is no longer usable");
  return {bytes:await d.objects.readVerified(asset,{workspaceId:e.workspaceId,projectId:e.projectId,maxBytes:10*1024*1024}),mimeType:"image/png" as const,checksumSha256:reference.checksumSha256};
}
async function persistOutput(e:RealMediaExecution,output:MediaProviderOutput,adapter:MediaProviderAdapter,d:RealMediaWorkerDependencies,leaseOwner:string):Promise<MediaAssetRecord|null>{
  if(!e.attemptId||!e.providerRequestId)throw new PersistenceError("REAL_MEDIA_RECEIPT_INVALID","Provider receipt is missing");
  const expected={"image.generate":"IMAGE","video.generate":"VIDEO","audio.tts":"AUDIO","audio.music":"MUSIC"}[e.inputSnapshot.capability];
  if(output.kind!==expected)throw new PersistenceError("REAL_MEDIA_OUTPUT_INVALID","Provider returned the wrong asset kind");
  const media=await d.materialize(output,adapter,e.inputSnapshot.configuration);
  if(!await d.store.renewDeliveryLease(e,leaseOwner,d.leaseMs))throw new PersistenceError("REAL_MEDIA_LEASE_LOST","Media delivery executor lost its lease");
  const object=await d.objects.putVerified({workspaceId:e.workspaceId,projectId:e.projectId,generationJobId:e.jobId,jobAttemptId:e.attemptId,bytes:media.bytes,mimeType:media.mimeType});
  return d.assets.completeAttemptWithAsset(d.jobs,{workspaceId:e.workspaceId,projectId:e.projectId,kind:output.kind,
    ...object,mimeType:media.mimeType,width:media.width,height:media.height,durationMs:media.durationMs,
    sourceJobAttemptId:e.attemptId,sourceShotRevisionId:e.shotRevisionId,providerConfigurationId:e.inputSnapshot.configuration.id,
    providerRequestId:e.providerRequestId,generationJobId:e.jobId,traceId:`real-media:complete:${e.jobId}`,
    metadata:{schema:"real-media.asset.v1",technicalReview:"passed",visualReview:"pending",actualCost:"unknown"},
    beforeLock:async client=>{
      await d.assets.prepareRealShotGenerationInTransaction(client,e.workspaceId,e.projectId,e.shotRevisionId,e.inputSnapshot.capability);
      await d.store.assertDeliveryLeaseInTransaction(client,e,leaseOwner);
    },
    afterPersist:async(client,asset)=>{
      await d.store.assertDeliveryLeaseInTransaction(client,e,leaseOwner);
      if(e.inputSnapshot.sourceImage){
        const source=await client.query("SELECT id FROM asset WHERE id=$1 AND workspace_id=$2 AND project_id=$3 AND status='ACTIVE' AND checksum_sha256=$4 FOR SHARE",[e.inputSnapshot.sourceImage.assetId,e.workspaceId,e.projectId,e.inputSnapshot.sourceImage.checksumSha256]);
        if(!source.rows[0])throw new PersistenceError("REAL_MEDIA_SOURCE_INVALID","Source image changed before completion");
        await client.query("INSERT INTO asset_dependency(workspace_id,project_id,dependent_asset_id,source_asset_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",[e.workspaceId,e.projectId,asset.id,e.inputSnapshot.sourceImage.assetId]);
      }
      if(e.inputSnapshot.speech)await commitSpeechTake(client,{workspaceId:e.workspaceId,projectId:e.projectId,assetId:asset.id,jobId:e.jobId,attemptId:e.attemptId!,speechInput:e.inputSnapshot.speech});
      await d.store.assertDeliveryLeaseInTransaction(client,e,leaseOwner);
      await d.store.finishInTransaction(client,e.attemptId!,"SUCCEEDED");
    }});
}
async function failKnown(e:RealMediaExecution,d:RealMediaWorkerDependencies,errorCode:string,leaseOwner:string){
  await d.jobs.failJob({workspaceId:e.workspaceId,jobId:e.jobId,attemptId:e.attemptId!,traceId:`real-media:failed:${e.jobId}`,
    errorCode:/^[A-Za-z0-9_.:-]{1,80}$/.test(errorCode)?errorCode:"REAL_MEDIA_PROVIDER_FAILED",errorMessage:"Provider request did not complete",retryable:false,
    beforeFailure:async client=>{await d.store.assertDeliveryLeaseInTransaction(client,e,leaseOwner);if(e.providerRequestId)await d.store.finishInTransaction(client,e.attemptId!,"FAILED");}});
}
export class RealMediaRecovery {
  constructor(private readonly dependencies:RealMediaWorkerDependencies){}
  async reconcileOnce():Promise<void>{
    if(!this.dependencies.store.receiptReady()||!await this.dependencies.store.storageReady())return;
    for(const execution of await this.dependencies.store.listRecoverable()){
      try{await this.recover(execution);}catch{await this.dependencies.store.defer(execution.workspaceId,execution.jobId,30);}
    }
  }
  async recover(e:RealMediaExecution):Promise<void>{
    const d=this.dependencies;if(!e.attemptId||e.inputSnapshot.schema!=="real-media.v1")return;
    const owner=`real-media-recovery:${process.pid}:${randomUUID()}`;
    if(!await d.store.claimRecovery(e,owner,d.leaseMs))return;
    const heartbeat=createMediaHeartbeat(()=>d.store.renewDeliveryLease(e,owner,d.leaseMs),d.heartbeatIntervalMs);
    try{
      const current=await d.store.loadExecution(e.workspaceId,e.jobId);
      if(current&&current.attemptId===e.attemptId&&["RUNNING","WAITING_EXTERNAL"].includes(current.state))await this.recoverClaimed(current,owner);
    }finally{await heartbeat.stop();await d.store.releaseDeliveryLease(e,owner);}
  }
  private async recoverClaimed(e:RealMediaExecution,leaseOwner:string):Promise<void>{
    const d=this.dependencies;
    if(!e.attemptId)return;
    if(e.cancelRequested){await d.jobs.confirmCancellation({workspaceId:e.workspaceId,jobId:e.jobId,attemptId:e.attemptId,traceId:`real-media:cancel:${e.jobId}`});return;}
    if(!e.receiptState){await d.jobs.failJob({workspaceId:e.workspaceId,jobId:e.jobId,attemptId:e.attemptId,traceId:`real-media:unsent:${e.jobId}`,errorCode:"REAL_MEDIA_NOT_SENT",errorMessage:"Worker stopped before submitting; a new quote is required",retryable:false,beforeFailure:client=>d.store.assertDeliveryLeaseInTransaction(client,e,leaseOwner)});return;}
    if(e.receiptState==="REJECTED"){await failKnown(e,d,"REAL_MEDIA_PROVIDER_REJECTED",leaseOwner);return;}
    if(!e.providerRequestId){await d.store.markUnknown(e.workspaceId,e.jobId,e.attemptId,leaseOwner);return;}
    const adapter=await d.adapterFor(e.inputSnapshot.configuration,"query");
    // Synchronous TTS/music have no query API: their encrypted receipt is sufficient to resume delivery.
    if(e.outputs?.length){
      try{await persistOutput(e,e.outputs[0] as MediaProviderOutput,adapter,d,leaseOwner);return;}
      catch(error){
        if(error instanceof PersistenceError&&["JOB_TERMINAL","ATTEMPT_SUPERSEDED","JOB_INVALID_TRANSITION","REAL_MEDIA_LEASE_LOST"].includes(error.code))return;
        // Image/video query can refresh an expired signed URL. Synchronous outputs have no query recovery API.
        if(e.inputSnapshot.capability==="audio.tts"||e.inputSnapshot.capability==="audio.music"){
          await d.store.markUnknown(e.workspaceId,e.jobId,e.attemptId,leaseOwner);return;
        }
      }
    }
    if(e.inputSnapshot.capability==="audio.tts"||e.inputSnapshot.capability==="audio.music"){
      await d.store.markUnknown(e.workspaceId,e.jobId,e.attemptId,leaseOwner);return;
    }
    const observation=await adapter.inspect(e.providerRequestId);
    await d.jobs.recordProviderEvent({workspaceId:e.workspaceId,providerConfigurationId:e.inputSnapshot.configuration.id,jobAttemptId:e.attemptId,
      providerRequestId:e.providerRequestId,source:"POLL",normalizedEventKey:observation.normalizedEventKey,externalStatus:observation.state});
    if(observation.state==="SUCCEEDED"){
      await d.store.acknowledge({workspaceId:e.workspaceId,jobId:e.jobId,attemptId:e.attemptId,providerRequestId:e.providerRequestId,outputs:observation.outputs as RealMediaReceiptOutput[],usage:observation.accounting?.usage});
      await persistOutput(e,observation.outputs[0],adapter,d,leaseOwner);
    }else if(observation.state==="FAILED"||observation.state==="CANCELED")await failKnown(e,d,observation.state==="FAILED"?observation.errorCode:"REAL_MEDIA_PROVIDER_CANCELED",leaseOwner);
    else await d.store.defer(e.workspaceId,e.jobId,observation.state==="UNKNOWN"?60:15);
  }
}
