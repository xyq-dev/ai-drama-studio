import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaS3Client, readVerifiedS3MediaObject } from "./media-object-client";
const sdk=vi.hoisted(()=>({config:[] as unknown[],send:vi.fn(),destroy:vi.fn()}));
vi.mock("@aws-sdk/client-s3",()=>({S3Client:class{constructor(config:unknown){sdk.config.push(config);}send(command:unknown){return sdk.send(command);}destroy(){sdk.destroy();}},PutObjectCommand:class{constructor(readonly input:unknown){}},GetObjectCommand:class{constructor(readonly input:unknown){}}}));
const W="11111111-1111-4111-8111-111111111111",P="22222222-2222-4222-8222-222222222222",J="33333333-3333-4333-8333-333333333333",A="44444444-4444-4444-8444-444444444444";
function fixture(){const bytes=Buffer.from("verified object bytes"),checksum=createHash("sha256").update(bytes).digest("hex"),key=`real-media/${W}/${P}/${J}/${A}/${checksum}.wav`;return{bytes,checksum,key,input:{storageProvider:"s3",objectKey:key,byteSize:bytes.length,checksumSha256:checksum},scope:{workspaceId:W,projectId:P,maxBytes:1000}};}
async function* chunks(...values:Uint8Array[]){for(const value of values)yield value;}
beforeEach(()=>{sdk.config=[];sdk.send.mockReset();sdk.destroy.mockReset();});
describe("S3 media boundary without network",()=>{
  it("uses create-only writes and the declared checksum without exposing credentials",async()=>{
    const f=fixture(),client=new MediaS3Client({endpoint:"https://storage.example.test",region:"test",bucket:"bucket",accessKeyId:"test-access",secretAccessKey:"test-secret",forcePathStyle:true});sdk.send.mockResolvedValue({});
    expect(await client.put({key:f.key,bytes:f.bytes,contentType:"audio/wav",checksumSha256:f.checksum,ifNoneMatch:"*"})).toBe("created");expect(sdk.config[0]).toMatchObject({maxAttempts:1});expect(sdk.send.mock.calls[0]![0].input).toMatchObject({Key:f.key,IfNoneMatch:"*",ChecksumSHA256:Buffer.from(f.checksum,"hex").toString("base64"),ContentLength:f.bytes.length});expect(JSON.stringify(client)).not.toContain("test-secret");client.destroy();expect(sdk.destroy).toHaveBeenCalledOnce();
  });
  it("treats only an S3 precondition refusal as an existing object and sanitizes other SDK errors",async()=>{
    const f=fixture(),client=new MediaS3Client({endpoint:"https://storage.example.test",region:"test",bucket:"bucket",accessKeyId:"access",secretAccessKey:"secret",forcePathStyle:true});
    sdk.send.mockRejectedValueOnce({$metadata:{httpStatusCode:412}});expect(await client.put({key:f.key,bytes:f.bytes,contentType:"audio/wav",checksumSha256:f.checksum,ifNoneMatch:"*"})).toBe("exists");
    sdk.send.mockRejectedValueOnce(new Error("secret endpoint signed-request"));await expect(client.get(f.key)).rejects.toThrow("MEDIA_OBJECT_STORAGE_UNAVAILABLE");expect(sdk.send).toHaveBeenCalledTimes(2);
  });
  it("checks namespace before storage access and verifies streamed exact size and digest",async()=>{
    const f=fixture(),get=vi.fn(async()=>chunks(f.bytes.subarray(0,4),f.bytes.subarray(4)));expect(await readVerifiedS3MediaObject({get},f.input,f.scope)).toEqual(f.bytes);
    await expect(readVerifiedS3MediaObject({get},{...f.input,objectKey:f.key.replace(W,P)},f.scope)).rejects.toThrow("MEDIA_OBJECT_CONTENT_INVALID");expect(get).toHaveBeenCalledOnce();
    await expect(readVerifiedS3MediaObject({get:async()=>chunks(Buffer.concat([f.bytes,Buffer.from("extra")]))},f.input,f.scope)).rejects.toThrow("MEDIA_OBJECT_CONTENT_INVALID");
    await expect(readVerifiedS3MediaObject({get:async()=>chunks(f.bytes.subarray(0,3))},f.input,f.scope)).rejects.toThrow("MEDIA_OBJECT_CONTENT_INVALID");
    await expect(readVerifiedS3MediaObject({get:async()=>chunks(Buffer.alloc(f.bytes.length))},f.input,f.scope)).rejects.toThrow("MEDIA_OBJECT_CONTENT_INVALID");
  });
  it("rejects incomplete SDK streams and preserves midstream failure without returning partial bytes",async()=>{
    const f=fixture(),client=new MediaS3Client({endpoint:"https://storage.example.test",region:"test",bucket:"bucket",accessKeyId:"access",secretAccessKey:"secret",forcePathStyle:true});sdk.send.mockResolvedValue({Body:undefined});await expect(client.get(f.key)).rejects.toThrow("MEDIA_OBJECT_STORAGE_UNAVAILABLE");
    async function* failed(){yield f.bytes.subarray(0,3);throw new Error("stream failed");}await expect(readVerifiedS3MediaObject({get:async()=>failed()},f.input,f.scope)).rejects.toThrow("stream failed");
  });
});
