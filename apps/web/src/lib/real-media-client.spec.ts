// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealMediaQuote, SpeechMixPreflight } from "@ai-drama/contracts";
import { StudioClient } from "./studio-client";
import { checkedRealMediaQuote, clearRealMediaPending, createRealMediaClient, readRealMediaPending, realMediaPendingKey, rememberRealMediaPending, type RealMediaPending } from "./real-media-client";
const P="11111111-1111-4111-8111-111111111111",S="22222222-2222-4222-8222-222222222222",Q="33333333-3333-4333-8333-333333333333",A="44444444-4444-4444-8444-444444444444",K="55555555-5555-4555-8555-555555555555",J="66666666-6666-4666-8666-666666666666",W="77777777-7777-4777-8777-777777777777",OTHER="88888888-8888-4888-8888-888888888888";
const quote=():RealMediaQuote=>({quoteId:Q,inputHash:"a".repeat(64),capability:"image.generate",currency:"CNY",estimatedAmount:"0.50",maximumAmount:"1.00",expiresAt:"2099-01-01T00:00:00.000Z",providerConfigurationId:A,providerConfigurationVersion:"config-v1",priceVersion:"price-v1",actualCost:"unknown",singleOperation:true,uncertainJobIds:[OTHER]});
const pending=():RealMediaPending=>({schema:"ads.real-media.pending.v1",projectId:P,shotRevisionId:S,key:K,quote:quote(),maximumAmount:"0.75",authorizationId:null});
function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});}
beforeEach(()=>sessionStorage.clear());afterEach(()=>vi.restoreAllMocks());
describe("real media client validates real API receipts and keeps request identity",()=>{
  it("preserves exact quoted unknown identities, authorization bound and one generate POST",async()=>{
    const calls:Array<{url:string;init?:RequestInit}>=[];
    const fetch=vi.fn(async(url:string,init?:RequestInit)=>{calls.push({url,init});if(url.endsWith("/quote"))return json(quote());if(url.endsWith("/authorize"))return json({quoteId:Q,budgetAuthorizationId:A});if(url.endsWith("/generate"))return json({jobId:J,workflowRunId:W,dispatchSeq:1},202);throw new Error("Unexpected request");});
    const api=createRealMediaClient(new StudioClient(fetch));const q=await api.quote(P,S,"image.generate");const auth=await api.authorize(P,q,"0.75",K);expect(auth).toBe(A);expect(await api.generate(P,S,Q,auth,K)).toMatchObject({jobId:J,workflowRunId:W});
    expect(calls.filter(c=>c.url.endsWith("/generate"))).toHaveLength(1);
    const authorized=calls.find(c=>c.url.endsWith("/authorize"))!;expect(JSON.parse(String(authorized.init?.body))).toEqual({quoteId:Q,maximumAmount:"0.75",confirmSinglePaidOperation:true,confirmedUncertainJobIds:[OTHER]});
    const sent=calls.find(c=>c.url.endsWith("/generate"))!;expect(new Headers(sent.init?.headers).get("Idempotency-Key")).toBe(K);expect(JSON.parse(String(sent.init?.body))).toEqual({quoteId:Q,budgetAuthorizationId:A});
  });
  it.each([{quoteId:"bad"},{inputHash:"bad"},{capability:"other"},{actualCost:"0"},{singleOperation:false},{uncertainJobIds:["bad"]},{maximumAmount:"NaN"},{estimatedAmount:0.5},{maximumAmount:1},{priceVersion:""}])("rejects malformed quotes %o",patch=>{expect(()=>checkedRealMediaQuote({...quote(),...patch})).toThrow();});
  it("filters existing mock assets while strictly checking scoped real S3 records",async()=>{
    const asset={id:A,kind:"VIDEO",status:"ACTIVE",sourceShotRevisionId:S,checksumSha256:"b".repeat(64),durationMs:5000,storageProvider:"s3"};
    const fetch=vi.fn<(url:string,init?:RequestInit)=>Promise<Response>>(async()=>json({items:[asset,{storageProvider:"mock-object-store"}],nextCursor:null}));const api=createRealMediaClient(new StudioClient(fetch));expect(await api.assets(S)).toEqual({items:[asset],nextCursor:null});
    fetch.mockResolvedValueOnce(json({items:[{...asset,sourceShotRevisionId:OTHER}],nextCursor:null}));await expect(api.assets(S)).rejects.toMatchObject({code:"INVALID_RESPONSE"});
    fetch.mockResolvedValueOnce(json({items:[{...asset,durationMs:0}],nextCursor:null}));await expect(api.assets(S)).rejects.toMatchObject({code:"INVALID_RESPONSE"});
  });
  it("rejects malformed successful receipts and never retries a failed generation request",async()=>{
    const fetch=vi.fn<(url:string,init?:RequestInit)=>Promise<Response>>(async()=>json({jobId:J},202)),api=createRealMediaClient(new StudioClient(fetch));await expect(api.generate(P,S,Q,A,K)).rejects.toMatchObject({code:"INVALID_RESPONSE"});expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(json({error:{code:"UNAVAILABLE",message:"Unknown delivery"}},503));await expect(api.generate(P,S,Q,A,K)).rejects.toMatchObject({status:503});expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects an authorization receipt belonging to another quote",async()=>{
    const fetch=vi.fn<(url:string,init?:RequestInit)=>Promise<Response>>(async()=>json({quoteId:OTHER,budgetAuthorizationId:A}));const api=createRealMediaClient(new StudioClient(fetch));
    await expect(api.authorize(P,quote(),"0.75",K)).rejects.toMatchObject({code:"INVALID_RESPONSE"});expect(fetch).toHaveBeenCalledOnce();
  });
  it("validates job scope and recognized capabilities without any mutation",async()=>{
    const fetch=vi.fn<(url:string,init?:RequestInit)=>Promise<Response>>(async()=>json({id:OTHER,state:"SUCCEEDED"})),api=createRealMediaClient(new StudioClient(fetch));await expect(api.job(J)).rejects.toMatchObject({code:"INVALID_RESPONSE"});
    fetch.mockResolvedValueOnce(json({available:false,reasonCode:"REAL_MEDIA_NOT_READY",capabilities:[]}));expect((await api.capabilities(P)).available).toBe(false);
    fetch.mockResolvedValueOnce(json({available:true,capabilities:["not-a-capability"]}));await expect(api.capabilities(P)).rejects.toMatchObject({code:"INVALID_RESPONSE"});expect(fetch.mock.calls.every(c=>c[1]?.method==="GET")).toBe(true);
  });
  it("retains immutable pending identity and only permits adding the same authorization",()=>{
    const original=pending();rememberRealMediaPending(original);expect(readRealMediaPending(P,S)).toEqual(original);
    for(const patch of [{key:OTHER},{maximumAmount:"1.00"},{quote:{...original.quote,quoteId:OTHER}}])expect(()=>rememberRealMediaPending({...original,...patch})).toThrow();
    const authorized={...original,authorizationId:A};rememberRealMediaPending(authorized);expect(()=>rememberRealMediaPending({...authorized,authorizationId:OTHER})).toThrow();expect(clearRealMediaPending(original)).toBe(false);expect(readRealMediaPending(P,S)).toEqual(authorized);expect(clearRealMediaPending(authorized)).toBe(true);
  });
  it("refuses invalid stored scope and never clears a newer request identity",()=>{
    const original=pending();rememberRealMediaPending(original);const newer={...original,key:OTHER};sessionStorage.setItem(realMediaPendingKey(P,S),JSON.stringify(newer));expect(clearRealMediaPending(original)).toBe(false);expect(readRealMediaPending(P,S)).toEqual(newer);
    sessionStorage.setItem(realMediaPendingKey(P,S),JSON.stringify({...original,shotRevisionId:OTHER}));expect(()=>readRealMediaPending(P,S)).toThrow();
  });
  it("sends the measured compose guard with its original idempotency key",async()=>{
    const fetch=vi.fn<(url:string,init?:RequestInit)=>Promise<Response>>(async()=>json({jobId:J,workflowRunId:W,dispatchSeq:1},202));const api=createRealMediaClient(new StudioClient(fetch));
    const preflight:SpeechMixPreflight={inputHash:"c".repeat(64),manifest:{schema:"voice.shot.mix.v1",workspaceId:P,projectId:P,shotRevisionId:S,planRevisionId:Q,planHash:"d".repeat(64),selectionHash:"e".repeat(64),videoAssetId:A,videoChecksumSha256:"b".repeat(64),videoDurationMs:5000,totalSpeechMs:1000,lines:[],subtitles:{format:"vtt",alignmentVersion:"sentence-duration-v1",checksumSha256:"f".repeat(64),cues:[]},mix:{audioOverflow:"reject",audioUnderflow:"pad-silence",sampleRate:48000,channels:2,musicAssetId:OTHER,musicChecksumSha256:"a".repeat(64),originalAudio:"mute",musicGain:0.25,ducking:true}},subtitleVtt:"WEBVTT\n\n",guards:{planRowVersion:1,assets:[]}};
    await api.compose(S,preflight,K);const [url,init]=fetch.mock.calls[0]!;expect(url).toContain(`/shot-revisions/${S}/voice-compose`);expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(K);expect(JSON.parse(String(init?.body))).toEqual({planRevisionId:Q,videoAssetId:A,musicAssetId:OTHER,originalAudio:"mute",musicGain:0.25,ducking:true,expectedInputHash:preflight.inputHash});
  });
});
