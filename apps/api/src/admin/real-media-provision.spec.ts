import { describe, expect, it, vi } from "vitest";
import type { RealMediaConfiguration } from "@ai-drama/contracts";
import type { DatabasePool } from "@ai-drama/database";
import { provisionRealMediaProviders } from "./real-media-provision";
const W="11111111-1111-4111-8111-111111111111",ID="22222222-2222-4222-8222-222222222222";
function config():RealMediaConfiguration{return {id:ID,version:"media-v1",providerKey:"dashscope-media",capability:"image.generate",model:"qwen-image-3.0",region:"beijing",credentialRef:"env:dashscope-media",credentialVersion:"v1",enabled:true,queryAllowed:true,priceVersion:"operator-v1",currency:"CNY",unitPrice:"0.18",unitType:"image",parameters:{},maximumOperationAmount:"1"};}
function setup(existing?:Record<string,unknown>){const queries:Array<{sql:string;values?:unknown[]}>=[],release=vi.fn(),query=vi.fn(async(sql:string,values?:unknown[])=>{queries.push({sql,values});return {rows:sql.includes("FROM workspace")?[{id:W}]:sql.includes("FROM provider_configuration")?(existing?[existing]:[]):[]};});const connect=vi.fn(async()=>({query,release}));return {pool:{connect} as unknown as DatabasePool,connect,queries,release};}
describe("explicit real provider provisioning without database execution",()=>{
  it("writes only the fixed provider reference with one allowed attempt and no credential values",async()=>{
    const h=setup();expect(await provisionRealMediaProviders(h.pool,{workspaceId:W,configurations:[config()]})).toEqual({ids:[ID],created:1});const insert=h.queries.find(q=>q.sql.startsWith("INSERT"))!;expect(insert.sql).toContain("180000,1");expect(insert.values).toEqual([ID,W,"dashscope-media","image.generate","env:dashscope-media"]);expect(h.queries.at(-1)!.sql).toBe("COMMIT");expect(h.release).toHaveBeenCalledOnce();
  });
  it("rejects duplicate capabilities, unsupported provider pairs and invalid scope before opening a connection",async()=>{
    const h=setup();for(const configurations of [[config(),config()],[{...config(),providerKey:"elevenlabs-media",credentialRef:"env:elevenlabs-media"}]])await expect(provisionRealMediaProviders(h.pool,{workspaceId:W,configurations})).rejects.toThrow("REAL_MEDIA_PROVISION_INVALID");await expect(provisionRealMediaProviders(h.pool,{workspaceId:"-".repeat(36),configurations:[config()]})).rejects.toThrow("REAL_MEDIA_PROVISION_INVALID");expect(h.connect).not.toHaveBeenCalled();
  });
  it("never silently enables an existing disabled row or keeps a row with a retrying policy",async()=>{
    const row={id:ID,enabled:false,encrypted_credential_ref:"env:dashscope-media",max_attempts:1,default_timeout_ms:180000};const h=setup(row);await expect(provisionRealMediaProviders(h.pool,{workspaceId:W,configurations:[config()]})).rejects.toThrow("REQUIRES_REVIEW");expect(h.queries.at(-1)!.sql).toBe("ROLLBACK");expect(h.queries.some(q=>q.sql.startsWith("UPDATE"))).toBe(false);
    const retry=setup({...row,enabled:true,max_attempts:3});await expect(provisionRealMediaProviders(retry.pool,{workspaceId:W,configurations:[config()]})).rejects.toThrow("REQUIRES_REVIEW");
    const explicit=setup(row);expect(await provisionRealMediaProviders(explicit.pool,{workspaceId:W,configurations:[config()],enableExisting:true})).toEqual({ids:[ID],created:0});expect(explicit.queries.filter(q=>q.sql.startsWith("UPDATE"))).toHaveLength(1);
  });
});
