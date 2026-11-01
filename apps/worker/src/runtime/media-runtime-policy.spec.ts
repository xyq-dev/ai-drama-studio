import { describe,expect,it } from "vitest";
import { composeSourcesAllowed,mediaSiteAuthenticationConfigured,realMediaAccessAllowed } from "@ai-drama/contracts";
import { workerComposePolicy } from "./media-runtime-policy";
const validAuth={SITE_AUTH_ENABLED:"true",SITE_AUTH_PUBLIC_ORIGIN:"https://studio.example.test",SITE_AUTH_PASSWORD_HASH:`scrypt$17$8$1$${"a".repeat(22)}$${"b".repeat(43)}`};
describe("production media bootstrap policy",()=>{
  it("requires an explicit production allowance and complete site authentication for real composition and episodes",()=>{
    const base={production:true,localEnabled:true,episodeEnabled:true,mockDirectoryReady:true,workDirectoryReady:true,objectDirectoryReady:true,receiptReady:true,s3Ready:true};
    for(const auth of [false,true])for(const allowProduction of [false,true]){
      const access=realMediaAccessAllowed({nodeEnv:"production",siteAuthConfigured:auth,allowProduction});
      expect(workerComposePolicy({...base,realAccessAllowed:access})).toEqual({mockCompose:false,realCompose:auth&&allowProduction,localCompose:auth&&allowProduction,episodeCompose:auth&&allowProduction});
    }
    expect(workerComposePolicy({...base,realAccessAllowed:true,episodeEnabled:false}).episodeCompose).toBe(false);
    expect(workerComposePolicy({...base,realAccessAllowed:true,receiptReady:false}).realCompose).toBe(false);
  });
  it("validates auth rather than trusting the enabled switch, including HTTPS production origin and bounded password hashes",()=>{
    expect(mediaSiteAuthenticationConfigured(validAuth,"production")).toBe(true);
    for(const extra of [{SITE_AUTH_PASSWORD_HASH:"invalid"},{SITE_AUTH_PUBLIC_ORIGIN:"http://localhost:3000"},{SITE_AUTH_PUBLIC_ORIGIN:"https://studio.example.test/path"},{SITE_AUTH_ENABLED:"false"},{SITE_AUTH_PASSWORD_HASH:validAuth.SITE_AUTH_PASSWORD_HASH.replace("$17$","$20$")}])expect(mediaSiteAuthenticationConfigured({...validAuth,...extra},"production")).toBe(false);
  });
  it("rejects empty sources, Mock in the production real path, mixed or unsupported storage",()=>{
    const flags={allowReal:true,allowMockAv:false,allowMockSm:false};
    expect(composeSourcesAllowed([{role:"video",storageProvider:"s3"},{role:"music",storageProvider:"s3"}],flags)).toBe(true);
    for(const sources of [[],undefined,[{role:"video",storageProvider:"mock-object-store"}],[{role:"audio",storageProvider:"s3"}],[{role:"video",storageProvider:"s3"},{role:"music",storageProvider:"mock-object-store"}]])expect(composeSourcesAllowed(sources,flags)).toBe(false);
  });
});
