// @vitest-environment happy-dom
// Local fixture client only. These tests prove browser command identity and controls, not paid production.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeechBatchInventory, SpeechBatchView, SpeechGenerationInput } from "@ai-drama/contracts";
import { ApiError } from "../lib/studio-client";
import { checkedSpeechBatch, clearSpeechBatchPending, createSpeechBatchClient, readSpeechBatchPending, readSpeechBatchStop,
  rememberSpeechBatchPending, rememberSpeechBatchStop, type SpeechBatchPending } from "../lib/speech-batch-client";
import { StudioClient } from "../lib/studio-client";
import { SpeechBatchPanel } from "./speech-batch-panel";
const id=(n:number)=>`${n.toString(16).padStart(8,"0")}-1111-4111-8111-111111111111`;
const P=id(1),E=id(2),B=id(3),O=id(4),L=id(5),I=id(6),S=id(7),Q=id(8),K=id(9),OTHER=id(10);
function batch():SpeechBatchView{
  const quote={quoteId:Q,inputHash:"a".repeat(64),currency:"CNY" as const,estimatedAmount:"0.01",maximumAmount:"0.10",
    expiresAt:"2099-01-01T00:00:00.000Z",providerConfigurationId:id(11),providerConfigurationVersion:"v1",priceVersion:"v1",uncertainJobIds:[]};
  return {id:B,projectId:P,episodeId:E,frozenHash:"b".repeat(64),state:"quoted",confirmation:null,cancelRequested:false,createdAt:"2026-11-01T00:00:00.000Z",
    frozen:{schema:"voice.episode.batch.v1",projectId:P,episodeId:E,sourceHash:"c".repeat(64),expiresAt:quote.expiresAt,
      budgets:[{currency:"CNY",estimatedAmount:"0.01",maximumAmount:"0.10"}],operations:[{id:O,input:{projectId:P,shotRevisionId:S,lineId:L,lineInputRevisionId:I,displayText:"你好。",inputHash:"a".repeat(64)} as SpeechGenerationInput,quote,idempotencyKey:"permanent-line-key"}]},
    operations:[{id:O,lineId:L,lineInputRevisionId:I,displayText:"你好。",shotRevisionId:S,state:"pending",quote,maximumAmount:"0.10",
      authorizationId:null,jobId:null,workflowRunId:null,jobState:null,errorCode:null}]};
}
const inventory=():SpeechBatchInventory=>({projectId:P,episodeId:E,sourceHash:"c".repeat(64),operationLimit:100,blockers:[],lines:[
  {shotRevisionId:S,planRevisionId:id(12),lineId:L,lineInputRevisionId:I,displayText:"你好。",voiceName:"清朗",status:"missing",jobIds:[]},
  {shotRevisionId:S,planRevisionId:id(12),lineId:id(13),lineInputRevisionId:id(14),displayText:"我已有音频。",voiceName:"柔和",status:"awaiting_selection",jobIds:[]}]});
function setup(){const api={inventory:vi.fn(async()=>inventory()),recent:vi.fn(async()=>[] as SpeechBatchView[]),read:vi.fn(async()=>batch()),
  write:vi.fn(async(request:SpeechBatchPending)=>request.kind==="quote"?batch():{...batch(),state:"dispatched" as const})};
  return {api,props:{projectId:P,episodeId:E,client:api,onChanged:vi.fn()}};}
async function open(){fireEvent.click(screen.getByRole("button",{name:/本集配音补齐 展开/}));await screen.findByText(/我已有音频/);}
async function quote(){fireEvent.click(screen.getByLabelText(/你好。 · 清朗/));fireEvent.click(screen.getByRole("button",{name:"冻结所选句子的报价"}));await screen.findByRole("button",{name:"确认本批配音补齐"});}
function confirm(){fireEvent.click(screen.getByLabelText("我确认固定调用次数及每币种费用上限，本批可能产生费用。"));fireEvent.click(screen.getByRole("button",{name:"确认本批配音补齐"}));}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {resolve,promise};}
beforeEach(()=>sessionStorage.clear());afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe("episode speech batch browser controls",()=>{
  it("offers explicit same-operation recovery for an interrupted dispatching batch without sending on reads",async()=>{
    const h=setup();h.api.recent.mockResolvedValue([{...batch(),state:"dispatching"}]);
    render(<SpeechBatchPanel {...h.props}/>);await open();fireEvent.change(screen.getByLabelText("查看已有批次"),{target:{value:B}});
    const resume=screen.getByRole("button",{name:"用原请求继续核查本批"});expect(h.api.write).not.toHaveBeenCalled();
    fireEvent.click(resume);await screen.findByText(/批次已受理/);expect(h.api.write).toHaveBeenCalledOnce();expect(h.api.write.mock.calls[0]![0]).toMatchObject({kind:"resume",batchId:B,body:{}});
  });
  it("loads only on demand, excludes existing takes and requires the exact fixed budget confirmation",async()=>{
    const h=setup();h.api.write.mockImplementation(async request=>{expect(readSpeechBatchPending(P,E)).toEqual(request);return request.kind==="quote"?batch():{...batch(),state:"dispatched"};});
    render(<SpeechBatchPanel {...h.props}/>);expect(h.api.inventory).not.toHaveBeenCalled();await open();
    expect((screen.getByLabelText(/我已有音频/) as HTMLInputElement).disabled).toBe(true);await quote();expect(h.api.write).toHaveBeenCalledOnce();
    expect((screen.getByRole("button",{name:"确认本批配音补齐"}) as HTMLButtonElement).disabled).toBe(true);confirm();
    await screen.findByText(/批次已受理/);expect(h.api.write.mock.calls[1]![0]).toMatchObject({kind:"confirm",batchId:B,body:{maximumJobs:1,
      budgets:[{currency:"CNY",maximumAmount:"0.10"}],confirmPossibleCharges:true,confirmedUncertainJobIds:[]}});
  });
  it("restores an unconfirmed paid command after refresh and replays only its original identity explicitly",async()=>{
    const h=setup();h.api.write.mockImplementation(async request=>{if(request.kind==="confirm")throw new ApiError(503,"UNAVAILABLE","Original receipt unknown");return batch();});
    const view=render(<SpeechBatchPanel {...h.props}/>);await open();await quote();confirm();await screen.findByText("Original receipt unknown");
    const original=readSpeechBatchPending(P,E);view.unmount();render(<SpeechBatchPanel {...h.props}/>);await open();expect(h.api.write).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button",{name:"继续确认原批次请求"}));await waitFor(()=>expect(h.api.write).toHaveBeenCalledTimes(3));
    expect(h.api.write.mock.calls[2]![0]).toEqual(original);
  });
  it("can stop an in-flight confirmation without replacing it and does not regress on a late confirm receipt",async()=>{
    const h=setup(),late=deferred<SpeechBatchView>();h.api.write.mockImplementation(async request=>request.kind==="confirm"?late.promise
      :request.kind==="cancel"?{...batch(),cancelRequested:true,state:"canceled"}:batch());
    render(<SpeechBatchPanel {...h.props}/>);await open();await quote();confirm();await waitFor(()=>expect(h.api.write).toHaveBeenCalledTimes(2));
    const original=readSpeechBatchPending(P,E);const stop=screen.getByRole("button",{name:"停止本批后续提交"});expect((stop as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(stop);await screen.findByText(/已请求停止后续提交；已创建的原任务/);
    expect(readSpeechBatchPending(P,E)).toEqual(original);expect(readSpeechBatchStop(P,E)).toBeNull();
    await act(async()=>{late.resolve({...batch(),state:"dispatching"});});
    await waitFor(()=>expect(readSpeechBatchPending(P,E)).toBeNull());expect(screen.getByText(/批次 .*已停止后续提交/)).toBeTruthy();
    expect(screen.queryByRole("button",{name:"确认本批配音补齐"})).toBeNull();
  });
  it("retains a separately unknown stop command across refresh without automatically dispatching",async()=>{
    const h=setup();h.api.recent.mockResolvedValue([batch()]);h.api.write.mockImplementation(async request=>{if(request.kind==="cancel")throw new ApiError(503,"UNAVAILABLE","Stop receipt unknown");return batch();});
    const view=render(<SpeechBatchPanel {...h.props}/>);await open();fireEvent.change(screen.getByLabelText("查看已有批次"),{target:{value:B}});
    fireEvent.click(screen.getByRole("button",{name:"停止本批后续提交"}));await screen.findByText("Stop receipt unknown");const original=readSpeechBatchStop(P,E);
    view.unmount();render(<SpeechBatchPanel {...h.props}/>);await open();expect(h.api.write).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button",{name:"继续确认原停止请求"}));await waitFor(()=>expect(h.api.write).toHaveBeenCalledTimes(2));expect(h.api.write.mock.calls[1]![0]).toEqual(original);
  });
});
describe("speech batch client and independent command journals",()=>{
  it("checks public operations against frozen source, exact currency totals and complete Job receipts",()=>{
    expect(checkedSpeechBatch(batch(),P,E)).toEqual(batch());
    const wrongTotal=batch();wrongTotal.frozen.budgets[0]!.maximumAmount="0.20";
    const wrongLine=batch();wrongLine.operations[0]!.displayText="changed";
    const incompleteJob=batch();incompleteJob.operations[0]!.state="job_created";
    const wrongQuote=batch();wrongQuote.operations[0]!.quote={...wrongQuote.operations[0]!.quote,priceVersion:"changed"};
    for(const v of [wrongTotal,wrongLine,incompleteJob,wrongQuote])expect(()=>checkedSpeechBatch(v,P,E)).toThrow();
  });
  it("checks scope and rejects incomplete mutation receipts without retries",async()=>{
    const fetch=vi.fn(async()=>new Response(JSON.stringify({...batch(),projectId:OTHER}),{status:201,headers:{"content-type":"application/json"}}));
    const api=createSpeechBatchClient(new StudioClient(fetch));const command:SpeechBatchPending={schema:"ads.speech-batch.pending.v1",projectId:P,episodeId:E,key:K,kind:"quote",batchId:null,body:{sourceHash:"c".repeat(64),lineInputRevisionIds:[I]}};
    await expect(api.write(command)).rejects.toMatchObject({code:"INVALID_RESPONSE"});expect(fetch).toHaveBeenCalledOnce();
  });
  it("keeps the paid identity immutable while a stop command has its own original identity",()=>{
    const command:SpeechBatchPending={schema:"ads.speech-batch.pending.v1",projectId:P,episodeId:E,key:K,kind:"confirm",batchId:B,body:{frozenHash:"b".repeat(64),maximumJobs:1,
      budgets:[{currency:"CNY",maximumAmount:"0.10"}],confirmPossibleCharges:true,confirmedUncertainJobIds:[]}};
    rememberSpeechBatchPending(command);const stop={...command,key:OTHER,kind:"cancel" as const,body:{}};rememberSpeechBatchStop(stop);
    expect(readSpeechBatchPending(P,E)).toEqual(command);expect(readSpeechBatchStop(P,E)).toEqual(stop);
    expect(()=>rememberSpeechBatchPending({...command,key:OTHER})).toThrow();expect(()=>rememberSpeechBatchStop({...stop,key:K})).toThrow();
    expect(clearSpeechBatchPending({...command,key:OTHER})).toBe(false);expect(readSpeechBatchPending(P,E)).toEqual(command);
  });
});
