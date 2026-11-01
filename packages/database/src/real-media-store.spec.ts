import type { PoolClient } from "pg";
import { describe,expect,it,vi } from "vitest";
import { RealMediaStore,type RealMediaExecution } from "./real-media-store";
import type { DatabasePool } from "./job-service";
function pool(query:ReturnType<typeof vi.fn>){return {connect:async()=>({query,release:()=>undefined})} as unknown as DatabasePool;}
describe("real media private receipts",()=>{
  it("checks actual eligibility after obtaining row locks instead of trusting the pre-lock predicate",async()=>{
    const query=vi.fn(async(sql:string)=>({rows:sql.includes("FROM project")?[{id:"p"}]:sql.includes("SELECT j.id FROM generation_job j JOIN job_attempt")?[{id:"j"}]:[],rowCount:1}));
    const store=new RealMediaStore(pool(query));
    const execution={workspaceId:"w",projectId:"p",jobId:"j",inputHash:"h",inputSnapshot:{shotRevisionId:"shot",capability:"audio.tts",sourceHash:"hash",configuration:{id:"pc",providerKey:"dashscope-media"},budget:{authorizationId:"auth",confirmedUncertainJobIds:[]}}} as unknown as RealMediaExecution;
    await expect(store.beginSubmission({execution,attemptId:"a",leaseOwner:"owner",validateInTransaction:async()=>undefined})).rejects.toMatchObject({code:"REAL_MEDIA_SUBMIT_BLOCKED"});
    expect(query.mock.calls.some(call=>String(call[0]).includes("SELECT 1 FROM generation_job j JOIN job_attempt"))).toBe(true);
    expect(query.mock.calls.some(call=>String(call[0]).includes("INSERT INTO real_media_submission"))).toBe(false);
    query.mockClear();await expect(store.transaction(client=>store.assertDeliveryLeaseInTransaction(client,execution,"owner"))).rejects.toMatchObject({code:"REAL_MEDIA_LEASE_LOST"});
  });
  it("blocks strict first-frame submissions inside the persistence boundary as well",async()=>{
    const query=vi.fn(async()=>({rows:[]}));const store=new RealMediaStore(pool(query));
    const execution={inputSnapshot:{capability:"video.generate",characterReferenceGate:"legacy"}} as RealMediaExecution;
    await expect(store.beginSubmission({execution,attemptId:"a",leaseOwner:"owner",characterReferenceGate:"strict",validateInTransaction:async()=>undefined})).rejects.toMatchObject({code:"REAL_MEDIA_REFERENCE_PROFILE_UNSUPPORTED"});
    expect(query.mock.calls).toHaveLength(2); // BEGIN + rollback, no source read or paid intent.
  });
  it("requires the exact frozen and current unknown-job set before granting another paid operation",async()=>{
    let current=[{id:"old-job"}];
    const row={estimated_amount:"0.18",maximum_amount:"0.18",quote_limit_amount:"0.50",authorization_id:null,expires_at:"2099-01-01T00:00:00Z",
      uncertain_job_ids:["old-job"],input_snapshot:{shotRevisionId:"shot",capability:"audio.tts",sourceHash:"hash",speech:{lineId:"stable-line"}}};
    const query=vi.fn(async(sql:string)=>({rows:sql.includes("obj_description")?[{ready:true}]:sql.includes("FROM project")?[{id:"p"}]:sql.includes("SELECT *")?[row]:sql.includes("JOIN real_media_submission")?current:[],rowCount:1}));
    const store=new RealMediaStore(pool(query));const input={workspaceId:"w",projectId:"p",actorId:"actor",quoteId:"q",maximumAmount:"0.30"};
    await expect(store.authorize(input)).rejects.toMatchObject({code:"REAL_MEDIA_UNCERTAIN_CHANGED"});
    current=[{id:"new-unknown"}];await expect(store.authorize({...input,confirmedUncertainJobIds:["old-job"]})).rejects.toMatchObject({code:"REAL_MEDIA_UNCERTAIN_CHANGED"});
    expect(query.mock.calls.some(call=>String(call[0]).includes("UPDATE real_media_authorization"))).toBe(false);
    current=[{id:"old-job"}];expect(await store.authorize({...input,confirmedUncertainJobIds:["old-job"]})).toMatchObject({quoteId:"q"});
    const discovery=query.mock.calls.find(call=>String(call[0]).includes("JOIN real_media_submission"))![0];
    expect(discovery).toContain("(s.state='UNKNOWN' OR (s.state='INTENT' AND s.provider_request_id IS NULL))");
  });
  it("counts known-ID unknown outcomes without adding their ledger estimate to unposted reservations",async()=>{
    const query=vi.fn(async(sql:string)=>({rows:sql.includes("obj_description")?[{ready:true}]:sql.includes("FROM project")?[{id:"p"}]:sql.includes("count(*)::int AS count")?[{count:1}]:[]}));
    const exposure=await new RealMediaStore(pool(query)).costExposure("w","p");
    expect(exposure).toEqual({actualCost:"unknown",unknownSubmissionCount:1,currencies:[]});
    expect(query.mock.calls.some(call=>String(call[0]).includes("(state='UNKNOWN' OR (state='INTENT' AND provider_request_id IS NULL))"))).toBe(true);
    expect(query.mock.calls.some(call=>/INSERT|UPDATE|DELETE/.test(String(call[0])))).toBe(false);
  });
  it("blocks a newly appeared unknown job at the final intent boundary",async()=>{
    const query=vi.fn(async(sql:string)=>({rows:sql.includes("FROM project")?[{id:"p"}]:sql.includes("JOIN real_media_submission")?[{id:"other-paid-intent"}]:[],rowCount:0}));
    const store=new RealMediaStore(pool(query));const execution={workspaceId:"w",projectId:"p",jobId:"j",inputSnapshot:{shotRevisionId:"shot",capability:"audio.tts",sourceHash:"hash",budget:{confirmedUncertainJobIds:[]}}} as unknown as RealMediaExecution;
    await expect(store.beginSubmission({execution,attemptId:"a",leaseOwner:"owner",validateInTransaction:async()=>undefined})).rejects.toMatchObject({code:"REAL_MEDIA_UNCERTAIN_CHANGED"});
    expect(query.mock.calls.some(call=>String(call[0]).includes("INSERT INTO real_media_submission"))).toBe(false);
  });
  it("permanently replays the same confirmed maximum, even after expiry, and refuses a changed maximum",async()=>{
    const row={estimated_amount:"0.18",maximum_amount:"0.30",quote_limit_amount:"0.50",authorization_id:"authorized",expires_at:"2000-01-01T00:00:00Z"};
    const query=vi.fn(async(sql:string)=>({rows:sql.includes("obj_description")?[{ready:true}]:sql.includes("SELECT *")?[row]:sql.includes("FROM project")?[{id:"p"}]:[],rowCount:1}));
    const store=new RealMediaStore(pool(query));const input={workspaceId:"w",projectId:"p",actorId:"actor",quoteId:"q",maximumAmount:"0.30"};
    expect(await store.authorize(input)).toEqual({budgetAuthorizationId:"authorized",quoteId:"q"});
    await expect(store.authorize({...input,maximumAmount:"0.31"})).rejects.toMatchObject({code:"REAL_MEDIA_BUDGET_MISMATCH"});
    expect(query.mock.calls.some(call=>String(call[0]).includes("UPDATE real_media_authorization"))).toBe(false);
  });
  it("checks readiness without applying draft SQL",async()=>{
    const query=vi.fn(async(_sql:string)=>({rows:[{ready:false}]}));const store=new RealMediaStore(pool(query));
    await expect(store.requireReady()).rejects.toThrow(/not provisioned/);expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).not.toMatch(/CREATE|ALTER|INSERT/);
  });
  it("seals synchronous outputs before persistence and never writes signed URLs as JSON",async()=>{
    const query=vi.fn(async(sql:string)=>({rows:sql.includes("RETURNING provider_configuration_id")?[{provider_configuration_id:"provider"}]:[],rowCount:1}));
    const seal=vi.fn(()=>"encrypted-private-receipt");const store=new RealMediaStore(pool(query),{receiptCipher:{seal,open:()=>[]}});
    const uri="https://dashscope-result-a.oss-cn-beijing.aliyuncs.com/audio?signature=private";
    await store.acknowledge({workspaceId:"w",jobId:"j",attemptId:"a",providerRequestId:"request",outputs:[{kind:"AUDIO",retrieval:{kind:"URI",uri}}]});
    expect(seal).toHaveBeenCalledOnce();expect(JSON.stringify(query.mock.calls)).not.toContain(uri);
    expect(JSON.stringify(query.mock.calls)).toContain("encrypted-private-receipt");
    expect(JSON.stringify(query.mock.calls)).toContain("ESTIMATED");expect(JSON.stringify(query.mock.calls)).not.toContain("'ACTUAL'");
  });
  it("validates current sources before the live-lease intent CAS and does not claim a lost executor",async()=>{
    const query=vi.fn(async(sql:string)=>({rows:sql.includes("FROM project")?[{id:"p"}]:[],rowCount:0}));const store=new RealMediaStore(pool(query));
    const validate=vi.fn(async(_client:PoolClient)=>undefined);
    const execution={workspaceId:"w",projectId:"p",jobId:"j",inputHash:"h",inputSnapshot:{budget:{authorizationId:"auth"},configuration:{id:"pc",providerKey:"dashscope-media"},capability:"audio.tts"}} as unknown as RealMediaExecution;
    await expect(store.beginSubmission({execution,attemptId:"a",leaseOwner:"owner",validateInTransaction:validate})).rejects.toThrow(/changed/);
    expect(validate).toHaveBeenCalledOnce();expect(query.mock.calls.some(call=>String(call[0]).includes("j.lease_owner=$9 AND j.lease_until>clock_timestamp()"))).toBe(true);
    expect(query.mock.calls.some(call=>String(call[0]).includes("INSERT INTO real_media_submission"))).toBe(false);
  });
});
