import { createHash } from "node:crypto";
import { realMediaAuthorizationSchema,realMediaGenerateSchema,realMediaQuoteRequestSchema,type RealMediaConfiguration,
  type RealMediaCapability,type SpeechCapabilities,type SpeechGenerationInput,type SpeechGenerationPort,type SpeechBatchDispatchRef } from "@ai-drama/contracts";
import { realMediaInputHash,realMediaJobKind } from "@ai-drama/domain";
import { PersistenceError,assertSpeechGenerationInputInTransaction,assertSpeechBatchDispatchInTransaction,bindSpeechBatchJobInTransaction,type JobPersistenceService,type MediaAssetStore,
  type RealMediaStore,type FrozenRealMediaInput,type MediaAssetRecord } from "@ai-drama/database";
import type { StudioContext } from "./studio.service";
type MediaTransactionClient=Parameters<MediaAssetStore["prepareRealShotGenerationInTransaction"]>[0];
export interface RealMediaContentReader {
  readVerified(asset:{storageProvider:string;objectKey:string;byteSize:number;checksumSha256:string},scope:{workspaceId:string;projectId:string;maxBytes:number}):Promise<Buffer>;
}
export interface RealMediaServiceOptions {
  workspaceId:string;enabled:boolean;readEnabled?:boolean;store:RealMediaStore;jobs:JobPersistenceService;assets:MediaAssetStore;
  configurationFor(capability:RealMediaCapability,client?:MediaTransactionClient):Promise<RealMediaConfiguration|null>;
  speechCatalog?(workspaceId:string,projectId:string):Promise<SpeechCapabilities>;
  objects?:RealMediaContentReader;
  characterReferenceGate?:"legacy"|"strict";
}
export class RealMediaService {
  constructor(private readonly options:RealMediaServiceOptions){}
  async capabilities(projectId:string){
    const ready=this.options.enabled&&this.options.store.receiptReady()&&await this.options.store.storageReady().catch(()=>false);
    const capabilities:RealMediaCapability[]=[];
    const unavailableCapabilities:Record<string,string>={};
    if(this.options.characterReferenceGate==="strict")unavailableCapabilities["video.generate"]="REAL_MEDIA_REFERENCE_PROFILE_UNSUPPORTED";
    if(ready)for(const capability of ["image.generate","video.generate","audio.tts","audio.music"] as const){
      if(capability==="video.generate"&&this.options.characterReferenceGate==="strict")continue;
      const config=await this.options.configurationFor(capability);if(config?.enabled)capabilities.push(capability);
    }
    // Project existence is checked by quote/generate under the established media gates.
    const readAvailable=(this.options.readEnabled??this.options.enabled)&&Boolean(this.options.objects)&&await this.options.store.storageReady().catch(()=>false);
    return {projectId,readAvailable,unavailableCapabilities,available:capabilities.length>0,reasonCode:!ready?"REAL_MEDIA_NOT_READY":!capabilities.length?"REAL_MEDIA_PROVIDER_DISABLED":null,capabilities,actualCost:"unknown",singleOperation:true};
  }
  private async ready(client?:MediaTransactionClient){
    if(!this.options.enabled||!this.options.store.receiptReady())throw new PersistenceError("REAL_MEDIA_NOT_READY","Real media is not configured");
    await this.options.store.requireReady(client);
  }
  async quote(projectId:string,shotRevisionId:string,body:unknown,actorId="server-owner"){
    await this.ready();const parsed=realMediaQuoteRequestSchema.safeParse(body);
    if(!parsed.success)throw new PersistenceError("VALIDATION_ERROR","Invalid real media quote request");
    if(parsed.data.capability==="video.generate"&&this.options.characterReferenceGate==="strict")throw new PersistenceError("REAL_MEDIA_REFERENCE_PROFILE_UNSUPPORTED","The first-frame video profile cannot prove strict selected character references");
    const config=await this.configuration(parsed.data.capability);
    const frozen=await this.options.store.transaction(async client=>{
      const source=await this.options.assets.prepareRealShotGenerationInTransaction(client,this.options.workspaceId,projectId,shotRevisionId,parsed.data.capability);
      const sourceText=parsed.data.capability==="audio.tts"?source.dialogue??"":source.promptText.trim();
      if(!sourceText.trim()||sourceText.length>4100)throw new PersistenceError("VALIDATION_ERROR","Saved media source text is empty or too long");
      const input:FrozenRealMediaInput={schema:"real-media.v1",shotRevisionId,capability:parsed.data.capability,sourceText,
        sourceHash:createHash("sha256").update(sourceText).digest("hex"),configuration:config,characterReferenceGate:this.options.characterReferenceGate??"legacy"};
      if(parsed.data.capability==="video.generate"){
        if(!parsed.data.sourceImageAssetId)throw new PersistenceError("REAL_MEDIA_SOURCE_REQUIRED","Select a generated first frame");
        const result=await client.query(`SELECT asset.* FROM asset JOIN generation_job job ON job.id=asset.source_generation_job_id
          WHERE asset.id=$1 AND asset.workspace_id=$2 AND asset.project_id=$3 AND asset.source_shot_revision_id=$4
          AND asset.kind='IMAGE' AND asset.status='ACTIVE' AND asset.storage_provider='s3' AND asset.mime_type='image/png'
          AND job.state='SUCCEEDED' AND job.input_snapshot->>'schema'='real-media.v1' FOR SHARE OF asset,job`,[parsed.data.sourceImageAssetId,this.options.workspaceId,projectId,shotRevisionId]);
        if(!result.rows[0])throw new PersistenceError("REAL_MEDIA_SOURCE_INVALID","First frame is not available for this shot");
        input.sourceImage={assetId:parsed.data.sourceImageAssetId,checksumSha256:String(result.rows[0].checksum_sha256)};
      }else if(parsed.data.sourceImageAssetId)throw new PersistenceError("VALIDATION_ERROR","This operation does not accept a first frame");
      return input;
    });
    return this.options.store.createQuote({workspaceId:this.options.workspaceId,projectId,actorId,frozen});
  }
  async authorize(projectId:string,body:unknown,actorId="server-owner"){
    await this.ready();const parsed=realMediaAuthorizationSchema.safeParse(body);
    if(!parsed.success)throw new PersistenceError("VALIDATION_ERROR","Confirm one quoted paid operation and its exact budget");
    return this.options.store.authorize({workspaceId:this.options.workspaceId,projectId,actorId,...parsed.data});
  }
  async costExposure(projectId:string){await this.options.store.requireReady();return this.options.store.costExposure(this.options.workspaceId,projectId);}
  async generate(projectId:string,shotRevisionId:string,body:unknown,context:StudioContext){
    const parsed=realMediaGenerateSchema.safeParse(body);
    if(!parsed.success)throw new PersistenceError("VALIDATION_ERROR","Invalid real media authorization");
    return this.createJob(projectId,shotRevisionId,parsed.data,context);
  }
  private async createJob(projectId:string,shotRevisionId:string,input:{quoteId:string;budgetAuthorizationId:string},context:StudioContext,speech?:SpeechGenerationInput,batchOperation?:SpeechBatchDispatchRef){
    if(!context.idempotencyKey||!/^[-A-Za-z0-9_.:]{1,200}$/.test(context.idempotencyKey))throw new PersistenceError("IDEMPOTENCY_KEY_REQUIRED","An idempotency key is required");
    const routeKey=speech?`/speech-plans/${speech.planRevisionId}/lines/${speech.lineId}/generate`:`/projects/${projectId}/shot-revisions/${shotRevisionId}/real-media/generate`;
    const requestIdentity=speech?{...input,lineInputRevisionId:speech.lineInputRevisionId,inputHash:speech.inputHash}:input;
    return this.options.jobs.createAndQueueWorkflowJob({workspaceId:this.options.workspaceId,actorId:context.actorId,
      httpMethod:"POST",routeKey,key:context.idempotencyKey,requestHash:realMediaInputHash(requestIdentity),expiresAt:new Date("9999-12-31T00:00:00Z")},async client=>{
      await this.ready(client);
      // Also inspect ordinary routes: a batch-owned quote cannot escape its cancellation/dispatch fence.
      await assertSpeechBatchDispatchInTransaction(client,batchOperation,{speech,...input,idempotencyKey:context.idempotencyKey!,actorId:context.actorId});
      const snapshot=await this.options.store.consumeAuthorization(client,{workspaceId:this.options.workspaceId,projectId,actorId:context.actorId,...input});
      if(snapshot.shotRevisionId!==shotRevisionId)throw new PersistenceError("REAL_MEDIA_INPUT_CHANGED","Quote belongs to another shot");
      if(snapshot.capability==="video.generate"&&this.options.characterReferenceGate==="strict")throw new PersistenceError("REAL_MEDIA_REFERENCE_PROFILE_UNSUPPORTED","The first-frame video profile cannot prove strict selected character references");
      const current=await this.configuration(snapshot.capability,client);
      if(realMediaInputHash(current)!==realMediaInputHash(snapshot.configuration))throw new PersistenceError("REAL_MEDIA_CONFIGURATION_CHANGED","Provider configuration changed; obtain a new quote");
      const source=await this.options.assets.prepareRealShotGenerationInTransaction(client,this.options.workspaceId,projectId,shotRevisionId,snapshot.capability);
      if(speech){
        if(!snapshot.speech||realMediaInputHash(snapshot.speech)!==realMediaInputHash(speech))throw new PersistenceError("REAL_MEDIA_INPUT_CHANGED","Speech input changed since quote");
        await assertSpeechGenerationInputInTransaction(client,speech);
      }else{
        if(snapshot.speech)throw new PersistenceError("REAL_MEDIA_INPUT_CHANGED","Use the speech line generation route");
        const text=snapshot.capability==="audio.tts"?source.dialogue??"":source.promptText.trim();
        if(text!==snapshot.sourceText)throw new PersistenceError("REAL_MEDIA_INPUT_CHANGED","Saved source text changed; obtain a new quote");
      }
      return {workspaceId:this.options.workspaceId,projectId,sourceShotRevisionId:shotRevisionId,type:realMediaJobKind(snapshot.capability),
        requestedBy:context.actorId,kind:realMediaJobKind(snapshot.capability),inputHash:realMediaInputHash(snapshot),inputSnapshot:snapshot,traceId:context.traceId};
    },async(client,created)=>{
      await this.options.store.bindAuthorization(client,input.quoteId,created);
      if(batchOperation)await bindSpeechBatchJobInTransaction(client,batchOperation,created);
    });
  }
  private async configuration(capability:RealMediaCapability,client?:MediaTransactionClient){
    const config=await this.options.configurationFor(capability,client);
    if(!config?.enabled||config.capability!==capability)throw new PersistenceError("REAL_MEDIA_PROVIDER_DISABLED","This media provider is unavailable");
    return config;
  }
  speechPort():SpeechGenerationPort{
    return {
      capabilities:async(workspaceId,projectId)=>{
        if(workspaceId!==this.options.workspaceId||!this.options.enabled||!this.options.store.receiptReady()||!await this.options.store.storageReady().catch(()=>false))return {available:false,reasonCode:"REAL_MEDIA_NOT_READY",catalogVersion:"none",voices:[]};
        return this.options.speechCatalog?this.options.speechCatalog(workspaceId,projectId):{available:false,reasonCode:"SPEECH_PROVIDER_NOT_CONFIGURED",catalogVersion:"none",voices:[]};
      },
      quote:async(input)=>{
        await this.ready();if(input.workspaceId!==this.options.workspaceId)throw new PersistenceError("NOT_FOUND","Workspace not found");
        const config=await this.configuration("audio.tts");
        if(input.voice.providerConfigurationId!==config.id||input.voice.providerConfigurationVersion!==config.version||input.voice.model!==config.model||input.emotion!=="neutral"||input.speed!==1||[...input.spokenText].length>600)throw new PersistenceError("SPEECH_VOICE_UNSUPPORTED","This voice supports at most 600 characters with neutral delivery at normal speed");
        await this.options.store.transaction(client=>assertSpeechGenerationInputInTransaction(client,input));
        const quote=await this.options.store.createQuote({workspaceId:input.workspaceId,projectId:input.projectId,actorId:"server-owner",
          frozen:{schema:"real-media.v1",shotRevisionId:input.shotRevisionId,capability:"audio.tts",sourceText:input.spokenText,
            sourceHash:createHash("sha256").update(input.spokenText).digest("hex"),configuration:config,speech:input}});
        return {...quote,inputHash:input.inputHash};
      },
      authorize:async(input)=>{
        if(input.workspaceId!==this.options.workspaceId)throw new PersistenceError("NOT_FOUND","Workspace not found");
        return this.authorize(input.projectId,{quoteId:input.quoteId,maximumAmount:input.maximumAmount,
          confirmedUncertainJobIds:input.confirmedUncertainJobIds,confirmSinglePaidOperation:true},input.actorId);
      },
      generate:async(input)=>{
        const {quoteId,budgetAuthorizationId,actorId,traceId,idempotencyKey,batchOperation,...speechInput}=input;
        const result=await this.createJob(input.projectId,input.shotRevisionId,{quoteId,budgetAuthorizationId},
          {actorId,traceId,idempotencyKey},speechInput,batchOperation);
        return {jobId:result.body.jobId,workflowRunId:result.body.workflowRunId,reused:result.replayed};
      },
    };
  }
  async readAssetContent(assetId:string):Promise<{mimeType:string;bytes:Buffer}>{
    if(!(this.options.readEnabled??this.options.enabled))throw new PersistenceError("REAL_MEDIA_NOT_READY","Authenticated media access is not configured");
    const asset:MediaAssetRecord=await this.options.assets.getWorkspaceAsset(this.options.workspaceId,assetId);
    if(asset.storageProvider!=="s3"||!this.options.objects||!["ACTIVE","STALE","SUPERSEDED"].includes(asset.status))throw new PersistenceError("NOT_FOUND","Media object unavailable");
    const maximum=asset.kind==="VIDEO"?100*1024*1024:asset.kind==="IMAGE"?10*1024*1024:20*1024*1024;
    return {mimeType:asset.mimeType,bytes:await this.options.objects.readVerified(asset,{workspaceId:this.options.workspaceId,projectId:asset.projectId,maxBytes:maximum})};
  }
}
