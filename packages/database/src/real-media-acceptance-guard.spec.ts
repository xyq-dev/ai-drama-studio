import { describe,expect,it } from "vitest";
import { checkRealMediaAcceptanceEnv, verifyRealMediaAcceptanceDatabase } from "./real-media-acceptance-guard";
describe("real-media disposable-database acceptance guard",()=>{
  const valid={REAL_MEDIA_ACCEPTANCE_AUTHORIZED:"true",REAL_MEDIA_ACCEPTANCE_DRAFT_AUTHORIZED:"true",REAL_MEDIA_ACCEPTANCE_DATABASE_NAME:"ads_media_acceptance_offline1",REAL_MEDIA_ACCEPTANCE_DATABASE_URL:"postgresql://localhost/ads_media_acceptance_offline1"};
  it("requires both explicit flags and an independent exact database name",()=>{
    expect(checkRealMediaAcceptanceEnv(valid).ok).toBe(true);
    for(const value of [{},{...valid,REAL_MEDIA_ACCEPTANCE_DRAFT_AUTHORIZED:"false"},{...valid,REAL_MEDIA_ACCEPTANCE_DATABASE_URL:"postgresql://localhost/business"},{...valid,DATABASE_URL:valid.REAL_MEDIA_ACCEPTANCE_DATABASE_URL},{...valid,DATABASE_URL:"postgres://other-host/ads_media_acceptance_offline1"}])expect(checkRealMediaAcceptanceEnv(value).ok).toBe(false);
  });
  it.each(["database", "dbname", "DB"])("rejects a dedicated URL %s database override before any connection",(key)=>{
    expect(checkRealMediaAcceptanceEnv({...valid,REAL_MEDIA_ACCEPTANCE_DATABASE_URL:`${valid.REAL_MEDIA_ACCEPTANCE_DATABASE_URL}?${key}=production`}).ok).toBe(false);
  });
  it("never falls back to a business URL and recognizes encoded same-database aliases",()=>{
    expect(checkRealMediaAcceptanceEnv({...valid,REAL_MEDIA_ACCEPTANCE_DATABASE_URL:undefined,DATABASE_URL:valid.REAL_MEDIA_ACCEPTANCE_DATABASE_URL}).ok).toBe(false);
    expect(checkRealMediaAcceptanceEnv({...valid,DATABASE_URL:"postgres://other-host/ads%5fmedia%5facceptance%5foffline1"}).ok).toBe(false);
    expect(checkRealMediaAcceptanceEnv({...valid,DATABASE_URL:"postgres://other-host/business?database=ads_media_acceptance_offline1"}).ok).toBe(false);
  });
  it("uses the full-object read-only verifier on the exact media acceptance name",async()=>{
    const calls:string[]=[];
    const result=await verifyRealMediaAcceptanceDatabase({query:async(sql)=>{calls.push(sql);return {rows:calls.length===1?[{name:valid.REAL_MEDIA_ACCEPTANCE_DATABASE_NAME}]:[{relations:"0"}]};}},valid.REAL_MEDIA_ACCEPTANCE_DATABASE_NAME);
    expect(result.ok).toBe(true);expect(calls).toHaveLength(2);expect(calls[1]).toContain("pg_catalog.pg_proc");expect(calls[1]).toContain("pg_catalog.pg_type");
  });
});
