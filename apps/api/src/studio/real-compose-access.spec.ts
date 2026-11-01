import { describe,expect,it,vi } from "vitest";
import type { MediaAssetStore } from "@ai-drama/database";
import { StudioService } from "./studio.service";
import { loadApiEnv } from "../config/env";
import { siteAuthFromEnv } from "../auth/site-auth.config";
import { mediaSiteAuthenticationConfigured } from "@ai-drama/contracts";
const w="11111111-1111-4111-8111-111111111111",s="22222222-2222-4222-8222-222222222222",v="33333333-3333-4333-8333-333333333333",m="44444444-4444-4444-8444-444444444444";
function setup(storageProvider="s3"){
  const queued:unknown[]=[];const client={};
  const assets={getWorkspaceAsset:vi.fn(async()=>({storageProvider})),preflightCompose:vi.fn(async()=>({inputHash:"a".repeat(64)})),
    freezeComposeInput:vi.fn(async()=>({projectId:w,inputHash:"a".repeat(64),snapshot:{input:{sourceObjects:[{role:"video",storageProvider},{role:"music",storageProvider}]}}}))};
  const jobs={createAndQueueWorkflowJob:vi.fn(async(_scope:unknown,factory:(c:unknown)=>Promise<unknown>)=>{const frozen=await factory(client);queued.push(frozen);return {status:202,body:{jobId:"job"}};})};
  const service=new StudioService(jobs as never,{} as never,{} as never,w,undefined,assets as unknown as MediaAssetStore,false,null,false,false,true,"/local-compose",true,false,undefined,"legacy",true,true);
  return {service,assets,queued};
}
describe("real composition with production Mock flags closed",()=>{
  it("advertises and queues verified real video/music without opening Mock video or music",async()=>{
    const {service,queued}=setup();expect(service.capabilities().compose.shot).toBe(true);
    await expect(service.preflightShotCompose(s,{videoAssetId:v,musicAssetId:m})).resolves.toMatchObject({status:200});
    await expect(service.composeShot(s,{videoAssetId:v,musicAssetId:m,expectedInputHash:"a".repeat(64)},{actorId:"owner",traceId:"trace",idempotencyKey:"compose"})).resolves.toMatchObject({status:202});
    expect(queued).toHaveLength(1);expect(queued[0]).toMatchObject({type:"MEDIA_COMPOSE",kind:"MEDIA_COMPOSE"});
    await expect(service.generateShotVideo(s,{}, {actorId:"owner",traceId:"trace",idempotencyKey:"mock"})).rejects.toMatchObject({code:"CONFIGURATION_ERROR"});
  });
  it("rejects persisted Mock sources in the real path before creating a queued job",async()=>{
    const {service,queued,assets}=setup("mock-object-store");
    await expect(service.preflightShotCompose(s,{videoAssetId:v,musicAssetId:m})).rejects.toMatchObject({code:"CONFIGURATION_ERROR"});expect(assets.preflightCompose).not.toHaveBeenCalled();
    await expect(service.composeShot(s,{videoAssetId:v,musicAssetId:m,expectedInputHash:"a".repeat(64)},{actorId:"owner",traceId:"trace",idempotencyKey:"mock-swap"})).rejects.toMatchObject({code:"CONFIGURATION_ERROR"});expect(queued).toEqual([]);
  });
  it("keeps worker and actual API site-auth readiness aligned on production configurations",()=>{
    const base={NODE_ENV:"production",DATABASE_URL:"postgresql://test/test",REDIS_URL:"redis://localhost",S3_ENDPOINT:"https://s3.example.test",S3_REGION:"test",S3_BUCKET:"test",S3_ACCESS_KEY_ID:"test",S3_SECRET_ACCESS_KEY:"test",APP_WORKSPACE_ID:w};
    const valid={SITE_AUTH_ENABLED:"true",SITE_AUTH_PUBLIC_ORIGIN:"https://studio.example.test",SITE_AUTH_PASSWORD_HASH:`scrypt$17$8$1$${"a".repeat(22)}$${"b".repeat(43)}`};
    for(const extra of [{},{SITE_AUTH_ENABLED:"false"},{SITE_AUTH_PUBLIC_ORIGIN:"http://localhost:3000"},{SITE_AUTH_PASSWORD_HASH:"bad"},{SITE_AUTH_USERNAME:""}]){
      const input={...base,...valid,...extra};expect(mediaSiteAuthenticationConfigured(input,"production")).toBe(siteAuthFromEnv(loadApiEnv(input)).kind==="enabled");
    }
  });
});
