import { describe,expect,it } from "vitest";
import { checkRealMediaAcceptanceEnv } from "./real-media-acceptance-guard";
describe("real-media disposable-database acceptance guard",()=>{
  const valid={REAL_MEDIA_ACCEPTANCE_AUTHORIZED:"true",REAL_MEDIA_ACCEPTANCE_DRAFT_AUTHORIZED:"true",REAL_MEDIA_ACCEPTANCE_DATABASE_NAME:"ads_media_acceptance_offline1",REAL_MEDIA_ACCEPTANCE_DATABASE_URL:"postgresql://localhost/ads_media_acceptance_offline1"};
  it("requires both explicit flags and an independent exact database name",()=>{
    expect(checkRealMediaAcceptanceEnv(valid).ok).toBe(true);
    for(const value of [{},{...valid,REAL_MEDIA_ACCEPTANCE_DRAFT_AUTHORIZED:"false"},{...valid,REAL_MEDIA_ACCEPTANCE_DATABASE_URL:"postgresql://localhost/business"},{...valid,DATABASE_URL:valid.REAL_MEDIA_ACCEPTANCE_DATABASE_URL},{...valid,DATABASE_URL:"postgres://other-host/ads_media_acceptance_offline1"}])expect(checkRealMediaAcceptanceEnv(value).ok).toBe(false);
  });
});
