import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { vimaxPlanningStartSchema, vimaxPlatformSourceSnapshotSchema, type VimaxPlanningRecord, type VimaxPlanningStore } from "@ai-drama/contracts";
import { freezeVimaxPlanning, hashVimaxPlanningRequest } from "@ai-drama/domain";
import { titleWritingProviderConfigs } from "./text-writing";
import { VimaxPlanningExecutor, validateVimaxPlanningOutput, vimaxPlanningView } from "./vimax-planning";
import { responsesAnswer, messagesAnswer, chatCompletionsAnswer } from "./title-writing-fixtures";
import type { WritingTransport } from "./text-writing";
const W="11111111-1111-4111-8111-111111111111", ID="99999999-9999-4999-8999-999999999994", NOW="2026-11-01T01:00:00.000Z";
function setup(providerKey: "openai" | "anthropic" | "deepseek" = "openai") {
  const raw=JSON.parse(readFileSync(resolve(__dirname,"../../../scripts/vimax-evaluation/fixtures/single-scene.json"),"utf8")), i=raw.input;
  const source=vimaxPlatformSourceSnapshotSchema.parse({schema:"ads.vimax-platform-source.v1",scriptRevisionNo:1,projectId:i.projectId,episodeId:i.episodeId,episodeNo:i.episodeNo,scriptRevisionId:i.scriptRevisionId,scriptContentHash:i.scriptContentHash,scriptText:i.scriptText,characters:i.characters});
  const request=vimaxPlanningStartSchema.parse({schema:"ads.vimax-planning.start.v1",target:{sceneId:"99999999-9999-4999-8999-999999999991",sceneRevisionId:"99999999-9999-4999-8999-999999999992",rowVersion:3},source:{scriptRevisionId:i.scriptRevisionId,scriptContentHash:i.scriptContentHash,characters:i.characters},sceneSpans:i.sceneSpans,selectedSceneKeys:i.selectedSceneKeys,sourceDialogue:i.sourceDialogue,requirements:i.requirements,confirmedTextSend:true});
  const providers=titleWritingProviderConfigs({OPENAI_API_KEY:"synthetic-openai-key",TITLE_WRITING_OPENAI_MODELS:"fixture-openai-model",ANTHROPIC_API_KEY:"sk-ant-api03-synthetic-test-key",DEEPSEEK_API_KEY:"synthetic-deepseek-key"});
  // Test configuration mirrors the server's allowed model; no key or network is real.
  const provider=providers[providerKey];
  if (!provider.ok) throw new Error("Test provider was not configured");
  const target={...request.target,sourceScriptRevisionId:i.scriptRevisionId,ordinal:1,heading:i.sceneSpans[0].heading,timeOfDay:"夜",summary:"原场景",locationRevisionId:null};
  const frozen=freezeVimaxPlanning(source,target,request,providerKey,provider.models[0]!); if(!frozen.ok) throw new Error("fixture blocked");
  const record:VimaxPlanningRecord={id:ID,workspaceId:W,projectId:source.projectId,episodeId:source.episodeId,actorId:"a",idempotencyKey:"planning-key",requestHash:hashVimaxPlanningRequest(source.projectId,source.episodeId,request),frozenHash:frozen.frozenHash,input:frozen.input,state:"reserved",executorId:"exec",leaseUntil:"2026-11-01T01:04:00.000Z",submittedAt:null,errorCode:null,providerRequestId:null,responseModel:null,usage:{status:"unknown",inputTokens:null,outputTokens:null,totalTokens:null},output:null,createdAt:NOW,finishedAt:null};
  const store={getById:vi.fn(async()=>structuredClone(record)),markSubmitted:vi.fn(async()=>{if(record.state!=="reserved")return false;record.state="submitted";record.submittedAt=NOW;return true;}),closeUnsent:vi.fn(async(_w,_id,_e,code)=>{record.state="rejected";record.errorCode=code;record.executorId=null;record.leaseUntil=null;record.finishedAt=NOW;return true;}),finish:vi.fn(async(_w,_id,executor,patch)=>{if(record.state!=="submitted"||record.executorId!==executor)return false;Object.assign(record,patch,{executorId:null,leaseUntil:null,finishedAt:NOW});return true;}),recoverExpired:vi.fn(async()=>0)} as unknown as VimaxPlanningStore;
  let status=200;const output={candidate:raw.candidate,supplements:raw.supplements};
  const transport=vi.fn<WritingTransport>(async()=>({status,headers:{get:()=>"fixture-request"},body:new TextEncoder().encode(JSON.stringify(providerKey==="openai"?responsesAnswer(output):providerKey==="anthropic"?messagesAnswer(output):chatCompletionsAnswer(output)))}));
  const executor=new VimaxPlanningExecutor({workspaceId:W,executorId:"exec",providers,store,transport,clock:()=>new Date(NOW)});
  return {record,store,transport,executor,providers,output,setStatus:(value:number)=>{status=value;}};
}
describe("ViMax one-call text executor",()=>{
  it.each(["openai","anthropic","deepseek"] as const)("uses the existing %s adapter once and retains exact validated output",async(provider)=>{
    const h=setup(provider);await Promise.all([h.executor.execute(ID),h.executor.execute(ID)]);await h.executor.execute(ID);
    expect(h.transport).toHaveBeenCalledTimes(1);expect(h.record.state).toBe("completed");
    expect(h.record.output?.request.supplements).toEqual(h.output.supplements);
    expect(vimaxPlanningView(h.record)).toMatchObject({requestKey:"planning-key",billing:"unknown",quotaAccounting:"reservation"});
    const sent=h.transport.mock.calls[0]![0];expect(sent.method).toBe("POST");expect(JSON.parse(sent.body)).toHaveProperty("model",h.record.input.model);
  });
  it("blocks a failed source/lease CAS before touching transport",async()=>{
    const h=setup();vi.mocked(h.store.markSubmitted).mockResolvedValue(false);await h.executor.execute(ID);expect(h.transport).not.toHaveBeenCalled();
  });
  it("refuses another executor and changed provider config without sending",async()=>{
    const h=setup();h.record.executorId="other";await h.executor.execute(ID);expect(h.transport).not.toHaveBeenCalled();
    h.record.executorId="exec";h.providers.openai.ok=false;await h.executor.execute(ID);expect(h.transport).not.toHaveBeenCalled();expect(h.record.errorCode).toBe("provider_unconfigured_before_send");
  });
  it("does not send a corrupted immutable freeze",async()=>{
    const h=setup();h.record.input.target.rowVersion++;await h.executor.execute(ID);expect(h.transport).not.toHaveBeenCalled();expect(h.record.errorCode).toBe("invalid_input_before_send");
  });
  it("UNKNOWN after a 503 or a thrown transport is terminal and maintain never resends",async()=>{
    const h=setup();h.setStatus(503);await h.executor.execute(ID);expect(h.record.state).toBe("unknown");await h.executor.execute(ID);await h.executor.maintain();expect(h.transport).toHaveBeenCalledTimes(1);expect(h.store.recoverExpired).toHaveBeenCalledOnce();
    const thrown=setup();thrown.transport.mockRejectedValue(new Error("connection ended"));await thrown.executor.execute(ID);expect(thrown.record.state).toBe("unknown");await thrown.executor.execute(ID);expect(thrown.transport).toHaveBeenCalledTimes(1);
  });
  it("rejects a schema-valid rewritten dialogue and preserves no adoption output",()=>{
    const h=setup();h.output.supplements.shots[0].dialogue[0].line="模型改写对白";
    expect(validateVimaxPlanningOutput(JSON.stringify(h.output),h.record.input)).toEqual({ok:false,code:"candidate_blocked"});
    expect(validateVimaxPlanningOutput("not json",h.record.input)).toEqual({ok:false,code:"invalid_output"});
  });
  it("cannot overwrite recovery with a late answer",async()=>{
    const h=setup();h.transport.mockImplementation(async()=>{h.record.state="unknown";h.record.executorId=null;return {status:200,headers:{get:()=>null},body:new TextEncoder().encode(JSON.stringify(responsesAnswer(h.output)))};});
    await h.executor.execute(ID);expect(h.record.state).toBe("unknown");expect(h.record.output).toBeNull();expect(h.store.finish).toHaveBeenCalledOnce();
  });
});
