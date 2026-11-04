import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import type { LookupFunction } from "node:net";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { blockedAddress, type MediaProviderAdapter, type MediaProviderOutput } from "@ai-drama/providers";
import { PersistenceError } from "@ai-drama/database";
import type { RealMediaConfiguration } from "@ai-drama/contracts";
const run=promisify(execFile);
const healthyTools=new Map<string,{until:number;work:Promise<void>}>();
/** Local producer preflight runs before any paid submission; healthy codec probes are cached for one minute. */
export function preflightRealMediaTools(options:{workDir:string;ffmpegBin?:string;ffprobeBin?:string}):Promise<void>{
  const key=JSON.stringify(options);const cached=healthyTools.get(key);
  if(cached&&cached.until>Date.now())return cached.work;
  const work=(async()=>{
    let directory:string|undefined;
    try{
      await run(options.ffprobeBin??"ffprobe",["-v","error","-show_versions","-of","json"],{timeout:10_000,maxBuffer:1024*1024});
      const decoders=await run(options.ffmpegBin??"ffmpeg",["-hide_banner","-decoders"],{timeout:10_000,maxBuffer:1024*1024});
      for(const decoder of ["png","h264","pcm_s16le","mp3float"]){if(!new RegExp(`\\s${decoder}\\s`).test(decoders.stdout+decoders.stderr))throw new Error("required decoder missing");}
      await mkdir(options.workDir,{recursive:true});directory=await mkdtemp(join(options.workDir,"media-preflight-"));
      const mp4=join(directory,"probe.mp4");
      await run(options.ffmpegBin??"ffmpeg",["-v","error","-f","lavfi","-i","color=c=black:s=16x16:r=25","-f","lavfi","-i","anullsrc=r=48000:cl=stereo","-t","0.12","-c:v","libx264","-threads","1","-pix_fmt","yuv420p","-c:a","aac",mp4],{timeout:20_000,maxBuffer:1024*1024});
      await run(options.ffmpegBin??"ffmpeg",["-v","error","-i",mp4,"-f","null","-"],{timeout:10_000,maxBuffer:1024*1024});
      await run(options.ffmpegBin??"ffmpeg",["-v","error","-i",mp4,"-frames:v","1","-c:v","png",join(directory,"probe.png")],{timeout:10_000,maxBuffer:1024*1024});
      await run(options.ffmpegBin??"ffmpeg",["-v","error","-i",mp4,"-vn","-c:a","pcm_s16le",join(directory,"probe.wav")],{timeout:10_000,maxBuffer:1024*1024});
    }catch{throw new PersistenceError("REAL_MEDIA_TOOLS_UNAVAILABLE","Local media tools or required codecs are unavailable");}
    finally{if(directory)await rm(directory,{recursive:true,force:true});}
  })();
  healthyTools.set(key,{until:Date.now()+60_000,work});
  void work.catch(()=>{healthyTools.delete(key);});return work;
}
export interface VerifiedRealMedia { bytes:Buffer;mimeType:"image/png"|"video/mp4"|"audio/wav";width?:number;height?:number;durationMs?:number }
export type RealMediaMaterializer=(output:MediaProviderOutput,adapter:MediaProviderAdapter,configuration:RealMediaConfiguration)=>Promise<VerifiedRealMedia>;
function dimensions(stream:{width?:number;height?:number}):{width:number;height:number}{
  if(!Number.isSafeInteger(stream.width)||!Number.isSafeInteger(stream.height)||stream.width!<1||stream.height!<1||stream.width!>4096||stream.height!>4096)throw new Error("invalid media dimensions");
  return {width:stream.width!,height:stream.height!};
}
const OSS=/^dashscope-result-[a-z0-9-]+\.oss-cn-[a-z0-9-]+\.aliyuncs\.com$/;
/** Provider results are read without model credentials. Redirects, private DNS targets and oversized bodies fail. */
export async function downloadRealMediaResult(raw:string,maxBytes:number):Promise<Buffer>{
  if(raw.startsWith("data:")){
    const music=/^data:audio\/mpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
    const image=/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
    const match=music??image;
    const cap=music?4*1024*1024:8*1024*1024;
    if(!match||match[1]!.length>Math.ceil(cap/3)*4)throw new PersistenceError("REAL_MEDIA_OUTPUT_INVALID","Invalid binary media receipt");
    const bytes=Buffer.from(match[1]!,"base64");
    if(!bytes.length||bytes.length>Math.min(maxBytes,cap)||bytes.toString("base64")!==match[1])throw new PersistenceError("REAL_MEDIA_OUTPUT_INVALID","Invalid binary media receipt");
    if(image&&!bytes.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex")))throw new PersistenceError("REAL_MEDIA_OUTPUT_INVALID","Invalid image receipt");
    return bytes;
  }
  let url:URL;try{url=new URL(raw);}catch{throw new PersistenceError("REAL_MEDIA_OUTPUT_INVALID","Invalid provider output reference");}
  if(!["http:","https:"].includes(url.protocol)||!OSS.test(url.hostname)||url.username||url.password||url.hash||(url.port&&url.port!=="443"))throw new PersistenceError("REAL_MEDIA_OUTPUT_INVALID","Provider output host is not allowed");
  url.protocol="https:";
  const addresses=await lookup(url.hostname,{all:true});
  if(!addresses.length||addresses.some(value=>blockedAddress(value.address)))throw new PersistenceError("REAL_MEDIA_OUTPUT_INVALID","Provider output address is not public");
  const selected=addresses[0]!;
  const pinned:LookupFunction=(_host,options,callback)=>{
    if(options.all)(callback as unknown as (error:null,value:Array<{address:string;family:number}>)=>void)(null,[selected]);
    else callback(null,selected.address,selected.family);
  };
  return new Promise<Buffer>((resolve,reject)=>{
    const chunks:Buffer[]=[];let size=0;let settled=false;
    const fail=()=>{clearTimeout(timer);if(!settled){settled=true;reject(new PersistenceError("REAL_MEDIA_DOWNLOAD_FAILED","Provider output download failed"));}req.destroy();};
    const timer=setTimeout(fail,120_000);
    const req=request(url,{method:"GET",lookup:pinned,headers:{Accept:"application/octet-stream"}},res=>{
      if(res.statusCode!==200){res.resume();fail();return;}
      res.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes){fail();return;}chunks.push(chunk);});
      res.on("error",fail);res.on("aborted",fail);
      res.on("end",()=>{if(!settled){settled=true;clearTimeout(timer);if(size)resolve(Buffer.concat(chunks,size));else reject(new PersistenceError("REAL_MEDIA_OUTPUT_INVALID","Provider output is empty"));}});
    });
    req.on("error",()=>{clearTimeout(timer);fail();});req.setTimeout(30_000,fail);req.end();
  });
}
export function createRealMediaMaterializer(options:{workDir:string;ffmpegBin?:string;ffprobeBin?:string}):RealMediaMaterializer{
  return async(output,adapter,configuration)=>{
    const resolved=await adapter.resolveOutput(output);
    const maximum=output.kind==="VIDEO"?100*1024*1024:output.kind==="IMAGE"?10*1024*1024:20*1024*1024;
    const bytes=await downloadRealMediaResult(resolved.uri,maximum);
    await mkdir(options.workDir,{recursive:true});
    const directory=await mkdtemp(join(options.workDir,"real-media-"));
    const input=join(directory,"input.bin");const normalized=join(directory,output.kind==="IMAGE"?"output.png":"output.wav");
    try{
      await writeFile(input,bytes,{flag:"wx",mode:0o600});
      const probe=async(path:string)=>{
        const result=await run(options.ffprobeBin??"ffprobe",["-v","error","-show_streams","-show_format","-of","json",path],{timeout:30_000,maxBuffer:1024*1024});
        return JSON.parse(result.stdout) as {streams:Array<{codec_type:string;codec_name:string;width?:number;height?:number;duration?:string}>;format:{duration?:string;format_name?:string}};
      };
      const facts=await probe(input);const audio=facts.streams.filter(s=>s.codec_type==="audio");const video=facts.streams.filter(s=>s.codec_type==="video");
      if(output.kind==="IMAGE"){
        if(video.length!==1||audio.length)throw new Error("invalid image streams");
        await run(options.ffmpegBin??"ffmpeg",["-v","error","-i",input,"-frames:v","1","-c:v","png",normalized],{timeout:60_000,maxBuffer:1024*1024});
        const result=await probe(normalized);const v=result.streams.find(s=>s.codec_type==="video");if(!v)throw new Error("image stream missing");
        const size=dimensions(v);
        const resultBytes=await readFile(normalized);if(resultBytes.length>maximum)throw new Error("image too large");
        return {bytes:resultBytes,mimeType:"image/png",...size};
      }
      const durationMs=Math.round(Number(facts.format.duration)*1000);
      if(!Number.isSafeInteger(durationMs)||durationMs<1||durationMs>180_000)throw new Error("invalid media duration");
      if(output.kind==="VIDEO"){
        const expected=Number(configuration.parameters.duration??5)*1000;
        if(video.length!==1||audio.length||video[0]?.codec_name!=="h264"||!facts.format.format_name?.split(",").includes("mp4")||Math.abs(durationMs-expected)>1000)throw new Error("invalid video profile");
        await run(options.ffmpegBin??"ffmpeg",["-v","error","-i",input,"-f","null","-"],{timeout:120_000,maxBuffer:1024*1024});
        return {bytes,mimeType:"video/mp4",...dimensions(video[0]),durationMs};
      }
      if(!["AUDIO","MUSIC"].includes(output.kind)||audio.length!==1||video.length)throw new Error("invalid audio streams");
      await run(options.ffmpegBin??"ffmpeg",["-v","error","-i",input,"-vn","-ar","48000","-ac","2","-c:a","pcm_s16le",normalized],{timeout:120_000,maxBuffer:1024*1024});
      if((await stat(normalized)).size>maximum)throw new Error("audio too large");
      const result=await probe(normalized);const measured=Math.round(Number(result.format.duration)*1000);
      if(!Number.isSafeInteger(measured)||measured<1||measured>180_000||Math.abs(measured-durationMs)>250||result.streams.length!==1||result.streams[0]?.codec_type!=="audio"||result.streams[0]?.codec_name!=="pcm_s16le")throw new Error("invalid normalized audio profile");
      return {bytes:await readFile(normalized),mimeType:"audio/wav",durationMs:measured};
    }catch{throw new PersistenceError("REAL_MEDIA_OUTPUT_INVALID","Generated media did not pass technical validation");}
    finally{await rm(directory,{recursive:true,force:true});}
  };
}
export function realMediaBytesHash(bytes:Uint8Array):string{return createHash("sha256").update(bytes).digest("hex");}
