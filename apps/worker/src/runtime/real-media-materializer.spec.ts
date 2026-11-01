import { execFile } from "node:child_process";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe,expect,it } from "vitest";
import type { MediaProviderAdapter } from "@ai-drama/providers";
import type { RealMediaConfiguration } from "@ai-drama/contracts";
import { createRealMediaMaterializer,preflightRealMediaTools } from "./real-media-materializer";
describe("local pre-paid media dependency preflight",()=>{
  it("refuses missing binaries with a safe local error",async()=>{
    await expect(preflightRealMediaTools({workDir:tmpdir(),ffprobeBin:"/definitely-missing/ffprobe"})).rejects.toMatchObject({code:"REAL_MEDIA_TOOLS_UNAVAILABLE"});
  });
  it.skipIf(process.env.REAL_MEDIA_TOOL_SMOKE!=="true")("preflights installed codecs and normalizes an offline MP3 fixture into probed WAV",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"real-media-offline-"));
    try{
      await preflightRealMediaTools({workDir:directory});
      const file=join(directory,"fixture.mp3");
      await promisify(execFile)("ffmpeg",["-v","error","-f","lavfi","-i","sine=frequency=440:duration=0.2","-c:a","libmp3lame",file],{timeout:10000,maxBuffer:1024*1024});
      const uri=`data:audio/mpeg;base64,${(await readFile(file)).toString("base64")}`;
      const adapter={resolveOutput:async()=>({uri})} as unknown as MediaProviderAdapter;
      const configuration={parameters:{}} as RealMediaConfiguration;
      const result=await createRealMediaMaterializer({workDir:directory})({kind:"MUSIC",retrieval:{kind:"URI",uri}},adapter,configuration);
      expect(result.mimeType).toBe("audio/wav");expect(result.bytes.subarray(0,4).toString()).toBe("RIFF");
      expect(result.durationMs).toBeGreaterThanOrEqual(190);expect(result.durationMs).toBeLessThan(300);
    }finally{await rm(directory,{recursive:true,force:true});}
  },30000);
});
