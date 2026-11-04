import { describe,expect,it } from "vitest";
import type { RealMediaConfiguration } from "@ai-drama/contracts";
import { assertRealMediaInput, estimateRealMedia,realMediaAmountUnits,realMediaInputHash } from "./real-media";
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
  it("prices eleven_v4 speech once per spoken character and refuses music-priced speech",()=>{
    const speech={...configuration,providerKey:"elevenlabs-tts",model:"eleven_v4",region:"global",currency:"USD" as const,unitPrice:"0.00008",credentialRef:"env:elevenlabs-tts"};
    expect(estimateRealMedia(speech,"你好")).toBe("0.00016000");
    expect(()=>estimateRealMedia({...speech,model:"eleven_multilingual_v2"},"你好")).toThrow(/eleven_v4/);
    expect(()=>estimateRealMedia({...configuration,providerKey:"elevenlabs-media",capability:"audio.tts",model:"music_v2"},"你好")).toThrow(/Music configuration cannot price speech/);
    expect(()=>assertRealMediaInput({schema:"real-media.v1",shotRevisionId:"00000000-0000-4000-8000-000000000002",capability:"audio.tts",sourceText:"你好",sourceHash:"a".repeat(64),configuration:speech})).toThrow(/per-line website worker/);
  });
  it("prices speech-2.8-hd once per character and keeps it off the website worker",()=>{
    const speech={...configuration,providerKey:"minimax-tts",model:"speech-2.8-hd",region:"api.minimaxi.com",currency:"CNY" as const,unitPrice:"0.00008",credentialRef:"env:minimax-tts"};
    expect(estimateRealMedia(speech,"你好")).toBe("0.00016000");
    expect(()=>estimateRealMedia({...speech,model:"speech-02-hd"},"你好")).toThrow(/speech-2.8-hd/);
    expect(()=>assertRealMediaInput({schema:"real-media.v1",shotRevisionId:"00000000-0000-4000-8000-000000000002",capability:"audio.tts",sourceText:"你好",sourceHash:"a".repeat(64),configuration:speech})).toThrow(/does not fall back to ElevenLabs/);
  });
});
