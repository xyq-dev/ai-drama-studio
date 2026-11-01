import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import type { ComposeSourceObject } from "@ai-drama/domain";
import { PersistenceError } from "@ai-drama/database";

export interface RealMediaStoredObject { storageProvider:"s3"; objectKey:string;byteSize:number;checksumSha256:string }
export interface RealMediaObjectStore {
  putVerified(input:{workspaceId:string;projectId:string;generationJobId:string;jobAttemptId:string;bytes:Uint8Array;mimeType:string}):Promise<RealMediaStoredObject>;
  readVerified(input:{storageProvider:string;objectKey:string;byteSize:number;checksumSha256:string},scope:{workspaceId:string;projectId:string;maxBytes:number}):Promise<Buffer>;
  stageVerified(source:ComposeSourceObject,targetPath:string,scope:{workspaceId:string;projectId:string;maxBytes:number}):Promise<void>;
}
/** SDK is supplied by runtime so this boundary is tested without a bucket, network or credential. */
export interface S3MediaClient {
  put(input:{key:string;bytes:Uint8Array;contentType:string;checksumSha256:string;ifNoneMatch:"*"}):Promise<"created"|"exists">;
  get(key:string):Promise<AsyncIterable<Uint8Array>>;
}
const UUID="[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const KEY=new RegExp(`^real-media/(${UUID})/(${UUID})/(${UUID})/(${UUID})/([a-f0-9]{64})\\.(png|mp4|wav|vtt)$`);
function checkedKey(key:string,scope:{workspaceId:string;projectId:string},checksum:string):void{
  const match=KEY.exec(key);
  if(!match||match[1]!==scope.workspaceId||match[2]!==scope.projectId||match[5]!==checksum)throw new PersistenceError("ASSET_CONTENT_INVALID","Object key is outside the requested scope");
}
export class S3RealMediaObjects implements RealMediaObjectStore {
  constructor(private readonly client:S3MediaClient){}
  async putVerified(input:{workspaceId:string;projectId:string;generationJobId:string;jobAttemptId:string;bytes:Uint8Array;mimeType:string}):Promise<RealMediaStoredObject>{
    const ext=({"image/png":"png","video/mp4":"mp4","audio/wav":"wav","text/vtt":"vtt"} as Record<string,string>)[input.mimeType];
    if(!ext||!input.bytes.byteLength)throw new PersistenceError("ASSET_CONTENT_INVALID","Unsupported media content");
    const checksumSha256=createHash("sha256").update(input.bytes).digest("hex");
    const objectKey=`real-media/${input.workspaceId}/${input.projectId}/${input.generationJobId}/${input.jobAttemptId}/${checksumSha256}.${ext}`;
    checkedKey(objectKey,input,checksumSha256);
    const status=await this.client.put({key:objectKey,bytes:input.bytes,contentType:input.mimeType,checksumSha256,ifNoneMatch:"*"});
    const stored={storageProvider:"s3" as const,objectKey,byteSize:input.bytes.byteLength,checksumSha256};
    // Both creation and replay require readback. ETag is not a SHA-256 or an integrity guarantee.
    if(status!=="created"&&status!=="exists")throw new PersistenceError("ASSET_CONTENT_INVALID","Object upload failed");
    await this.readVerified(stored,{...input,maxBytes:input.bytes.byteLength});
    return stored;
  }
  async readVerified(input:{storageProvider:string;objectKey:string;byteSize:number;checksumSha256:string},scope:{workspaceId:string;projectId:string;maxBytes:number}):Promise<Buffer>{
    if(input.storageProvider!=="s3"||!Number.isSafeInteger(input.byteSize)||input.byteSize<1||input.byteSize>scope.maxBytes)throw new PersistenceError("ASSET_CONTENT_INVALID","Invalid media byte limit");
    checkedKey(input.objectKey,scope,input.checksumSha256);
    const chunks:Buffer[]=[];let size=0;const hash=createHash("sha256");
    for await(const chunk of await this.client.get(input.objectKey)){
      size+=chunk.byteLength;if(size>input.byteSize||size>scope.maxBytes)throw new PersistenceError("ASSET_CONTENT_INVALID","Object exceeded declared byte size");
      hash.update(chunk);chunks.push(Buffer.from(chunk));
    }
    if(size!==input.byteSize||hash.digest("hex")!==input.checksumSha256)throw new PersistenceError("ASSET_CONTENT_INVALID","Object checksum or size mismatch");
    return Buffer.concat(chunks,size);
  }
  async stageVerified(source:ComposeSourceObject,targetPath:string,scope:{workspaceId:string;projectId:string;maxBytes:number}):Promise<void>{
    if(source.storageProvider!=="s3"||!Number.isSafeInteger(source.byteSize)||source.byteSize<1||source.byteSize>scope.maxBytes)throw new PersistenceError("ASSET_CONTENT_INVALID","Invalid media byte limit");
    checkedKey(source.objectKey,scope,source.checksumSha256);
    const file=await open(targetPath,"wx",0o600);const hash=createHash("sha256");let size=0;let valid=false;
    try{
      for await(const chunk of await this.client.get(source.objectKey)){
        size+=chunk.byteLength;if(size>source.byteSize||size>scope.maxBytes)throw new PersistenceError("ASSET_CONTENT_INVALID","Object exceeded declared byte size");
        hash.update(chunk);await file.writeFile(chunk);
      }
      if(size!==source.byteSize||hash.digest("hex")!==source.checksumSha256)throw new PersistenceError("ASSET_CONTENT_INVALID","Object checksum or size mismatch");
      valid=true;
    }finally{await file.close();if(!valid)await rm(targetPath,{force:true}).catch(()=>undefined);}
  }
}
