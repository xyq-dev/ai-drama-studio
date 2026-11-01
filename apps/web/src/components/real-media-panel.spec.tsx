// @vitest-environment happy-dom
// Parent-panel state-machine tests only: the child speech editor, media API and browser storage are offline doubles.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealMediaQuote, SpeechMixPreflight } from "@ai-drama/contracts";
import { ApiError } from "../lib/studio-client";
import { readRealMediaPending, realMediaPendingKey, rememberRealMediaPending, type RealMediaAsset, type RealMediaCapabilities, type RealMediaClient, type RealMediaPending } from "../lib/real-media-client";
import { RealMediaPanel } from "./real-media-panel";
const speech=vi.hoisted(()=>({props:[] as Array<Record<string,unknown>>,preflight:null as SpeechMixPreflight|null}));
vi.mock("./speech-panel",()=>({SpeechPanel:(props:Record<string,unknown>)=>{speech.props.push(props);return <section data-testid="speech-child">
  <p>Speech child video: {String(props.videoAssetId??"none")} music: {String(props.musicAssetId??"none")}</p>
  <button type="button" onClick={()=>{(props.onPreflight as (value:SpeechMixPreflight|null)=>void)(speech.preflight);}}>完成逐句合成预检替身</button>
</section>;}}));
const P="11111111-1111-4111-8111-111111111111",S="22222222-2222-4222-8222-222222222222",Q="33333333-3333-4333-8333-333333333333",A="44444444-4444-4444-8444-444444444444",K="55555555-5555-4555-8555-555555555555",J="66666666-6666-4666-8666-666666666666",W="77777777-7777-4777-8777-777777777777",OTHER="88888888-8888-4888-8888-888888888888",VIDEO="99999999-9999-4999-8999-999999999999",MUSIC="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",NEWKEY="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function quote():RealMediaQuote{return {quoteId:Q,inputHash:"a".repeat(64),capability:"image.generate",currency:"CNY",estimatedAmount:"0.50",maximumAmount:"1.00",expiresAt:"2099-01-01T00:00:00.000Z",providerConfigurationId:A,providerConfigurationVersion:"config-v1",priceVersion:"price-v1",actualCost:"unknown",singleOperation:true,uncertainJobIds:[]};}
function preflight():SpeechMixPreflight{return {inputHash:"c".repeat(64),manifest:{schema:"voice.shot.mix.v1",workspaceId:P,projectId:P,shotRevisionId:S,planRevisionId:Q,planHash:"d".repeat(64),selectionHash:"e".repeat(64),videoAssetId:VIDEO,videoChecksumSha256:"b".repeat(64),videoDurationMs:5000,totalSpeechMs:1000,lines:[],subtitles:{format:"vtt",alignmentVersion:"sentence-duration-v1",checksumSha256:"f".repeat(64),cues:[]},mix:{audioOverflow:"reject",audioUnderflow:"pad-silence",sampleRate:48000,channels:2,originalAudio:"mute",musicAssetId:MUSIC,musicChecksumSha256:"a".repeat(64),musicGain:0.25,ducking:true}},subtitleVtt:"WEBVTT\n\n",guards:{planRowVersion:1,assets:[]}};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {resolve,promise};}
function pending():RealMediaPending{return {schema:"ads.real-media.pending.v1",projectId:P,shotRevisionId:S,key:K,quote:quote(),maximumAmount:"0.75",authorizationId:A};}
function setup(){
  const asset=(id:string,kind:RealMediaAsset["kind"],status="ACTIVE"):RealMediaAsset=>({id,kind,status,sourceShotRevisionId:S,checksumSha256:"b".repeat(64),durationMs:kind==="IMAGE"?null:5000,storageProvider:"s3"});
  const items=[asset(A,"IMAGE"),asset(OTHER,"IMAGE","STALE"),asset(VIDEO,"VIDEO"),asset(MUSIC,"MUSIC")];
  const api={capabilities:vi.fn(async():Promise<RealMediaCapabilities>=>({available:true,reasonCode:null,capabilities:["image.generate","video.generate","audio.tts","audio.music"]})),
    assets:vi.fn(async(_shot:string,_cursor?:string,_signal?:AbortSignal)=>({items:structuredClone(items),nextCursor:null as string|null})),characters:vi.fn(async()=>[{id:OTHER,name:"林夏"}]),
    quote:vi.fn(async(_p:string,_s:string,_capability:Parameters<RealMediaClient["quote"]>[2],_source?:string)=>quote()),
    authorize:vi.fn(async(_p:string,_quote:RealMediaQuote,_maximum:string,_key:string)=>A),generate:vi.fn(async(_p:string,_s:string,_quote:string,_auth:string,_key:string)=>({jobId:J,workflowRunId:W})),
    job:vi.fn(async(id:string,_signal?:AbortSignal)=>({id,state:"WAITING_EXTERNAL",errorCode:"REAL_MEDIA_SUBMISSION_UNKNOWN" as string|null})),
    compose:vi.fn(async(_shot:string,_preflight:SpeechMixPreflight,_key:string)=>({jobId:J,workflowRunId:W})),
  };
  const changed=vi.fn(),props={projectId:P,shotRevisionId:S,dialogue:"林夏：这不是我。",usable:true,refreshEpoch:0,client:api,onChanged:changed};
  return {api,props,items,changed,storageKey:realMediaPendingKey(P,S)};
}
async function open(){fireEvent.click(screen.getByRole("button",{name:/图片、视频与角色配音/}));await screen.findByRole("button",{name:"查看本次费用"});await screen.findByTestId("speech-child");}
async function requestQuote(){fireEvent.click(screen.getByRole("button",{name:"查看本次费用"}));await screen.findByLabelText("本次费用上限（CNY）");}
const confirm=()=>fireEvent.click(screen.getByLabelText("我确认本次可能收费，只提交一次生成。"));
function storageFake(){const map=new Map<string,string>();const storage:Storage={get length(){return map.size;},clear:()=>map.clear(),key:index=>[...map.keys()][index]??null,getItem:key=>map.get(key)??null,removeItem:key=>{map.delete(key);},setItem:(key,value)=>{map.set(String(key),String(value));}};return storage;}
beforeEach(()=>{vi.stubGlobal("sessionStorage",storageFake());speech.props=[];speech.preflight=preflight();});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe("real media panel explicit paid send and scoped recovery",()=>{
  it("keeps the original compose request across refresh and a changed preflight",async()=>{
    const h=setup();h.api.compose.mockRejectedValueOnce(new ApiError(503,"UNAVAILABLE","Compose receipt unknown"));
    const view=render(<RealMediaPanel {...h.props}/>);await open();fireEvent.click(screen.getByRole("button",{name:"完成逐句合成预检替身"}));
    fireEvent.click(await screen.findByRole("button",{name:"合成本段画面、声音与字幕"}));await screen.findByText("Compose receipt unknown");
    const original=h.api.compose.mock.calls[0]!;view.unmount();speech.preflight={...preflight(),inputHash:"9".repeat(64)};
    render(<RealMediaPanel {...h.props}/>);await open();expect(h.api.compose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button",{name:"完成逐句合成预检替身"}));
    fireEvent.click(screen.getByRole("button",{name:"继续确认原合成请求"}));await screen.findByText(/合成任务已受理/);
    expect(h.api.compose.mock.calls[1]).toEqual(original);
  });
  it("blocks a new paid send when the current shot loses eligibility",async()=>{
    const h=setup(),view=render(<RealMediaPanel {...h.props}/>);await open();await requestQuote();confirm();
    view.rerender(<RealMediaPanel {...h.props} usable={false}/>);
    expect((screen.getByRole("button",{name:"确认生成图片"}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button",{name:"确认生成图片"}));expect(h.api.generate).not.toHaveBeenCalled();
  });
  it("starts collapsed and makes no request; disabled capability never exposes generation",async()=>{
    const h=setup();h.api.capabilities.mockResolvedValue({available:false,reasonCode:"REAL_MEDIA_NOT_READY",capabilities:[]});render(<RealMediaPanel {...h.props}/>);expect(h.api.capabilities).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button",{name:/图片、视频与角色配音/}));await screen.findByText(/媒体服务尚未配置完整/);expect(h.api.assets).not.toHaveBeenCalled();expect(h.api.quote).not.toHaveBeenCalled();expect(h.api.generate).not.toHaveBeenCalled();expect(screen.queryByRole("button",{name:"查看本次费用"})).toBeNull();
  });
  it("requires both budget bounds and explicit acknowledgement of the quoted unknown jobs",async()=>{
    const h=setup();h.api.quote.mockResolvedValue({...quote(),uncertainJobIds:[OTHER]});render(<RealMediaPanel {...h.props}/>);await open();await requestQuote();const send=screen.getByRole("button",{name:"确认生成图片"});
    expect((send as HTMLButtonElement).disabled).toBe(true);confirm();expect((send as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByLabelText(/先前有 1 个结果未知的请求/));
    fireEvent.change(screen.getByLabelText("本次费用上限（CNY）"),{target:{value:"1.01"}});confirm();expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("本次费用上限（CNY）"),{target:{value:"0.75"}});confirm();expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send);fireEvent.click(send);await screen.findByText(/任务已受理/);expect(h.api.authorize).toHaveBeenCalledOnce();expect(h.api.generate).toHaveBeenCalledOnce();expect(h.api.authorize.mock.calls[0]![1].uncertainJobIds).toEqual([OTHER]);
  });
  it.each([[503,"UNAVAILABLE","Delivery unknown"],[502,"INVALID_RESPONSE","Receipt incomplete"]] as const)("persists identity and retains an unconfirmed %s result",async(status,code,message)=>{
    const h=setup();h.api.authorize.mockImplementation(async(_p,q,maximum,key)=>{expect(readRealMediaPending(P,S)).toMatchObject({key,quote:q,maximumAmount:maximum,authorizationId:null});return A;});
    h.api.generate.mockImplementation(async(_p,_s,_q,auth,key)=>{expect(readRealMediaPending(P,S)).toMatchObject({key,authorizationId:auth});throw new ApiError(status,code,message);});
    render(<RealMediaPanel {...h.props}/>);await open();await requestQuote();confirm();fireEvent.click(screen.getByRole("button",{name:"确认生成图片"}));await screen.findByText(message);expect(readRealMediaPending(P,S)).toMatchObject({authorizationId:A});expect(h.api.generate).toHaveBeenCalledOnce();expect(screen.getByRole("button",{name:"继续确认原媒体请求"})).toBeTruthy();
  });
  it("keeps an unconfirmed authorization for explicit same-key recovery without generating",async()=>{
    const h=setup();h.api.authorize.mockRejectedValue(new ApiError(502,"INVALID_RESPONSE","Authorization incomplete"));render(<RealMediaPanel {...h.props}/>);await open();await requestQuote();confirm();fireEvent.click(screen.getByRole("button",{name:"确认生成图片"}));await screen.findByText("Authorization incomplete");
    expect(readRealMediaPending(P,S)).toMatchObject({authorizationId:null});expect(h.api.generate).not.toHaveBeenCalled();expect(h.api.authorize).toHaveBeenCalledOnce();
  });
  it("refresh restores the exact pending authorization and key without sending until explicit replay",async()=>{
    const h=setup(),old=pending();rememberRealMediaPending(old);const view=render(<RealMediaPanel {...h.props}/>);await open();expect(h.api.generate).not.toHaveBeenCalled();view.unmount();
    render(<RealMediaPanel {...h.props}/>);await open();expect(h.api.generate).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("button",{name:"继续确认原媒体请求"}));await screen.findByText(/任务已受理/);
    expect(h.api.authorize).not.toHaveBeenCalled();expect(h.api.generate).toHaveBeenCalledExactlyOnceWith(P,S,Q,A,K);expect(readRealMediaPending(P,S)).toBeNull();
  });
  it("never authorizes or generates when browser storage refuses the identity",async()=>{
    const h=setup();render(<RealMediaPanel {...h.props}/>);await open();await requestQuote();const storage=sessionStorage;vi.stubGlobal("sessionStorage",{...storage,getItem:storage.getItem.bind(storage),setItem:()=>{throw new Error("Storage denied");}});confirm();fireEvent.click(screen.getByRole("button",{name:"确认生成图片"}));await screen.findByText("Storage denied");expect(h.api.authorize).not.toHaveBeenCalled();expect(h.api.generate).not.toHaveBeenCalled();
  });
  it("keeps original identity after a definite refusal until the author explicitly ends it",async()=>{
    const h=setup();rememberRealMediaPending(pending());h.api.generate.mockRejectedValue(new ApiError(409,"REAL_MEDIA_INPUT_CHANGED","Saved source changed"));render(<RealMediaPanel {...h.props}/>);await open();fireEvent.click(screen.getByRole("button",{name:"继续确认原媒体请求"}));await screen.findByText("Saved source changed");expect(readRealMediaPending(P,S)?.key).toBe(K);fireEvent.click(screen.getByRole("button",{name:"结束这个已拒绝请求"}));expect(readRealMediaPending(P,S)).toBeNull();expect(h.api.generate).toHaveBeenCalledOnce();
  });
  it("requires an ACTIVE image for video and passes real assets and selected video/music into the mounted speech child",async()=>{
    const h=setup();render(<RealMediaPanel {...h.props}/>);await open();fireEvent.change(screen.getByLabelText("本次制作"),{target:{value:"video.generate"}});
    expect((screen.getByRole("button",{name:"查看本次费用"}) as HTMLButtonElement).disabled).toBe(true);const firstframe=screen.getByLabelText("视频首帧") as HTMLSelectElement;expect([...firstframe.options].map(o=>o.value)).toEqual(["",A]);
    fireEvent.change(firstframe,{target:{value:A}});fireEvent.click(screen.getByRole("button",{name:"查看本次费用"}));await waitFor(()=>expect(h.api.quote).toHaveBeenCalledWith(P,S,"video.generate",A));
    fireEvent.change(screen.getByLabelText("本段配音对应的视频"),{target:{value:VIDEO}});fireEvent.change(screen.getByLabelText("本段背景音乐"),{target:{value:MUSIC}});
    expect(speech.props.at(-1)).toMatchObject({projectId:P,shotRevisionId:S,characters:[{id:OTHER,name:"林夏"}],videoAssetId:VIDEO,musicAssetId:MUSIC});
    expect(screen.getAllByRole("img")).toHaveLength(2);expect(document.querySelector(`video[src='/api/v1/real-media/assets/${VIDEO}/content']`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"完成逐句合成预检替身"}));fireEvent.click(await screen.findByRole("button",{name:"合成本段画面、声音与字幕"}));await screen.findByText(/合成任务已受理/);expect(h.api.compose).toHaveBeenCalledOnce();expect(h.api.compose.mock.calls[0]![1]).toEqual(speech.preflight);expect(h.api.generate).not.toHaveBeenCalled();
  });
  it("does not let a late quote from the old shot appear in the new shot",async()=>{
    const h=setup(),late=deferred<RealMediaQuote>();h.api.quote.mockReturnValueOnce(late.promise);const view=render(<RealMediaPanel {...h.props}/>);await open();fireEvent.click(screen.getByRole("button",{name:"查看本次费用"}));
    view.rerender(<RealMediaPanel {...h.props} shotRevisionId={OTHER}/>);await open();late.resolve(quote());await new Promise<void>(resolve=>setTimeout(resolve,0));expect(screen.queryByLabelText("本次费用上限（CNY）")).toBeNull();expect(h.api.generate).not.toHaveBeenCalled();
  });
  it("ignores an old cursor page that returns after a fresh asset reload",async()=>{
    const h=setup(),late=deferred<Awaited<ReturnType<RealMediaClient["assets"]>>>();h.api.assets.mockResolvedValueOnce({items:[h.items[0]!],nextCursor:"old-cursor"}).mockReturnValueOnce(late.promise).mockResolvedValueOnce({items:[h.items[2]!],nextCursor:null});
    const view=render(<RealMediaPanel {...h.props}/>);await open();fireEvent.click(screen.getByRole("button",{name:"加载更多制作结果"}));view.rerender(<RealMediaPanel {...h.props} refreshEpoch={1}/>);await waitFor(()=>expect(h.api.assets).toHaveBeenCalledTimes(3));late.resolve({items:[h.items[1]!],nextCursor:null});await new Promise<void>(resolve=>setTimeout(resolve,0));expect(screen.queryByAltText("已生成图片 "+OTHER.slice(0,8))).toBeNull();
  });
  it("does not let a late manual read replace the newly accepted job",async()=>{
    const h=setup(),late=deferred<{id:string;state:string;errorCode:string|null}>();rememberRealMediaPending(pending());sessionStorage.setItem(h.storageKey+":job",JSON.stringify({projectId:P,shotRevisionId:S,jobId:OTHER}));h.api.job.mockReturnValueOnce(late.promise);
    render(<RealMediaPanel {...h.props}/>);await open();fireEvent.click(screen.getByRole("button",{name:"查询原任务"}));await waitFor(()=>expect(h.api.job).toHaveBeenCalledOnce());fireEvent.click(screen.getByRole("button",{name:"继续确认原媒体请求"}));await screen.findByText(/任务已受理/);
    late.resolve({id:OTHER,state:"SUCCEEDED",errorCode:null});await new Promise<void>(resolve=>setTimeout(resolve,0));fireEvent.click(screen.getByRole("button",{name:"查询原任务"}));await waitFor(()=>expect(h.api.job).toHaveBeenCalledTimes(2));expect(h.api.job.mock.calls[1]![0]).toBe(J);
  });
  it("loads a newer pending identity instead of leaving the old identity active after a late accepted receipt",async()=>{
    const h=setup(),late=deferred<{jobId:string;workflowRunId:string}>();rememberRealMediaPending(pending());h.api.generate.mockReturnValueOnce(late.promise);render(<RealMediaPanel {...h.props}/>);await open();fireEvent.click(screen.getByRole("button",{name:"继续确认原媒体请求"}));await waitFor(()=>expect(h.api.generate).toHaveBeenCalledOnce());
    const newer={...pending(),key:NEWKEY};sessionStorage.setItem(h.storageKey,JSON.stringify(newer));late.resolve({jobId:J,workflowRunId:W});await waitFor(()=>expect((screen.getByRole("button",{name:"继续确认原媒体请求"}) as HTMLButtonElement).disabled).toBe(false));expect(readRealMediaPending(P,S)).toEqual(newer);
    fireEvent.click(screen.getByRole("button",{name:"继续确认原媒体请求"}));await waitFor(()=>expect(h.api.generate).toHaveBeenCalledTimes(2));expect(h.api.generate.mock.calls[1]![4]).toBe(NEWKEY);
  });
});
