import { describe,expect,it } from "vitest";
import type { RealMediaConfiguration } from "@ai-drama/contracts";
import { estimateRealMedia,realMediaAmountUnits,realMediaInputHash } from "./real-media";
const configuration:RealMediaConfiguration={id:"id",version:"v1",providerKey:"dashscope-media",capability:"audio.tts",model:"qwen3-tts-flash",region:"beijing",credentialRef:"media-env:beijing",credentialVersion:"v1",enabled:true,queryAllowed:true,priceVersion:"history",currency:"CNY",unitPrice:"0.00008",unitType:"character",parameters:{}};
describe("real media single-operation estimates",()=>{
  it("counts all Unicode codepoints conservatively without floating point rounding",()=>{
    expect(estimateRealMedia(configuration,"你好。😀")).toBe("0.00064000");
    expect(realMediaAmountUnits("0.00000001")).toBe(1n);
    for(const invalid of ["NaN","Infinity","-1","1e2","0.000000001","1.2.3"])expect(()=>realMediaAmountUnits(invalid)).toThrow();
  });
  it("freezes price, credential reference and first frame as part of the request identity",()=>{
    const base={configuration,sourceImage:{assetId:"a",checksumSha256:"a".repeat(64)}};
    expect(realMediaInputHash(base)).toBe(realMediaInputHash({sourceImage:base.sourceImage,configuration}));
    expect(realMediaInputHash(base)).not.toBe(realMediaInputHash({...base,configuration:{...configuration,credentialVersion:"v2"}}));
    expect(realMediaInputHash(base)).not.toBe(realMediaInputHash({...base,sourceImage:{...base.sourceImage,checksumSha256:"b".repeat(64)}}));
  });
});
