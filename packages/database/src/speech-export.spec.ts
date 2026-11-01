import { describe,expect,it,vi } from "vitest";
import type { PoolClient } from "pg";
import { speechExactHash } from "@ai-drama/domain";
import { speechExportVoices } from "./speech-export";
const voice={catalogVoiceId:"cherry",name:"Cherry",providerConfigurationId:"11111111-1111-4111-8111-111111111111",providerConfigurationVersion:"v1",providerKey:"dashscope-media",model:"qwen3-tts-flash",modelVersion:"v1",voiceId:"Cherry",locale:"zh-CN",rightsRef:"https://help.aliyun.com/voice",capabilities:{emotions:["neutral"],speedMin:1,speedMax:1,maxTextCharacters:600}};
describe("portable frozen speech voice export",()=>{
  it("exports the exact scoped speaker and voice snapshot, and refuses private or changed metadata",async()=>{
    let snapshot:unknown=voice;
    const query=vi.fn(async()=>({rows:[{id:"revision",binding_id:"binding",speaker_id:"narrator",content_hash:speechExactHash(voice),voice_json:snapshot,provider_configuration_id:voice.providerConfigurationId,provider_key:voice.providerKey}]}));
    const client={query} as unknown as PoolClient;
    const result=await speechExportVoices(client,"workspace","project",["revision"]);
    expect(result[0]).toMatchObject({speakerId:"narrator",voiceRevision:{id:"revision",bindingId:"binding",voiceId:"Cherry",locale:"zh-CN",providerConfigurationVersion:"v1"}});
    snapshot={...voice,apiKey:"never-export"};await expect(speechExportVoices(client,"workspace","project",["revision"])).rejects.toMatchObject({code:"COMPOSE_INPUT_INVALID"});
    snapshot={...voice,name:"Different voice"};await expect(speechExportVoices(client,"workspace","project",["revision"])).rejects.toMatchObject({code:"COMPOSE_INPUT_INVALID"});
  });
});
