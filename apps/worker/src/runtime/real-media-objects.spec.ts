import { createHash } from "node:crypto";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe,expect,it,vi } from "vitest";
import { S3RealMediaObjects,type S3MediaClient } from "./real-media-objects";
import { downloadRealMediaResult } from "./real-media-materializer";
const scope={workspaceId:"11111111-1111-4111-8111-111111111111",projectId:"22222222-2222-4222-8222-222222222222",generationJobId:"33333333-3333-4333-8333-333333333333",jobAttemptId:"44444444-4444-4444-8444-444444444444"};
describe("durable real media objects",()=>{
  it("stages bounded chunks without overwriting files and removes interrupted partial content",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"s3-media-stage-"));const bytes=Buffer.from("chunked content");
    const checksumSha256=createHash("sha256").update(bytes).digest("hex");
    const source={role:"audio" as const,assetId:"asset",storageProvider:"s3",objectKey:`real-media/${scope.workspaceId}/${scope.projectId}/${scope.generationJobId}/${scope.jobAttemptId}/${checksumSha256}.wav`,byteSize:bytes.length,checksumSha256};
    try{
      const objects=new S3RealMediaObjects({put:async()=>"exists",get:async()=>({async *[Symbol.asyncIterator](){yield bytes.subarray(0,4);yield bytes.subarray(4);}})});
      const target=join(directory,"staged.wav");await objects.stageVerified(source,target,{...scope,maxBytes:100});expect(await readFile(target)).toEqual(bytes);
      await expect(objects.stageVerified(source,target,{...scope,maxBytes:100})).rejects.toMatchObject({code:"EEXIST"});expect(await readFile(target)).toEqual(bytes);
      const interrupted=new S3RealMediaObjects({put:async()=>"exists",get:async()=>({async *[Symbol.asyncIterator](){yield bytes.subarray(0,4);throw new Error("interrupted stream");}})});
      const partial=join(directory,"partial.wav");await expect(interrupted.stageVerified(source,partial,{...scope,maxBytes:100})).rejects.toThrow(/interrupted/);await expect(readFile(partial)).rejects.toMatchObject({code:"ENOENT"});
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it("uploads with exclusive semantics and verifies both initial creation and replay",async()=>{
    const bytes=Buffer.from("verified");const put=vi.fn(async(_input:Parameters<S3MediaClient["put"]>[0])=>"created" as const);
    const get=vi.fn(async function*(_key:string){yield bytes.subarray(0,3);yield bytes.subarray(3);});
    const objects=new S3RealMediaObjects({put,get:async key=>get(key)} as unknown as S3MediaClient);
    const stored=await objects.putVerified({...scope,bytes,mimeType:"audio/wav"});
    expect(put.mock.calls[0]?.[0]).toMatchObject({ifNoneMatch:"*"});
    expect(stored.checksumSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await objects.readVerified(stored,{...scope,maxBytes:bytes.length})).toEqual(bytes);
    await expect(objects.readVerified(stored,{...scope,projectId:scope.workspaceId,maxBytes:100})).rejects.toThrow(/scope/);
    expect(get).toHaveBeenCalledTimes(2);
  });
  it("rejects truncated, oversized and corrupt objects",async()=>{
    const bytes=Buffer.from("abc");const key=`real-media/${scope.workspaceId}/${scope.projectId}/${scope.generationJobId}/${scope.jobAttemptId}/${createHash("sha256").update(bytes).digest("hex")}.wav`;
    for(const supplied of [Buffer.from("ab"),Buffer.from("abcd"),Buffer.from("bad")]){
      const objects=new S3RealMediaObjects({put:async()=>"exists",get:async()=>({async *[Symbol.asyncIterator](){yield supplied;}})});
      await expect(objects.readVerified({storageProvider:"s3",objectKey:key,byteSize:3,checksumSha256:createHash("sha256").update(bytes).digest("hex")},{...scope,maxBytes:3})).rejects.toThrow();
    }
  });
  it("accepts only bounded canonical MP3 data receipts and never fetches untrusted references",async()=>{
    const bytes=Buffer.from("offline mp3 fixture");
    expect(await downloadRealMediaResult(`data:audio/mpeg;base64,${bytes.toString("base64")}`,100)).toEqual(bytes);
    for(const bad of ["data:audio/wav;base64,YQ==","data:audio/mpeg;base64,YQ=","https://127.0.0.1/private","https://dashscope-result-a.oss-cn-beijing.aliyuncs.com.evil.test/a","https://user:secret@dashscope-result-a.oss-cn-beijing.aliyuncs.com/a"]){
      await expect(downloadRealMediaResult(bad,100)).rejects.toThrow();
    }
    await expect(downloadRealMediaResult(`data:audio/mpeg;base64,${bytes.toString("base64")}`,3)).rejects.toThrow();
  });
});
