// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VimaxPlanningStart, VimaxPlatformPreviewRequest, VimaxCandidateCreate } from "@ai-drama/contracts";
import { vimaxPlanningFixture } from "../lib/vimax-planning-test-fixtures";
import { VimaxPreviewPanel } from "./vimax-preview-panel";
afterEach(()=>{cleanup();sessionStorage.clear();vi.restoreAllMocks();});
function setup(){
  const f=vimaxPlanningFixture();
  const previewClient={source:vi.fn(async()=>f.source),preview:vi.fn(async(_p:string,_e:string,r:VimaxPlatformPreviewRequest)=>{
    const response=structuredClone(f.previewResponse);if(response.report.status!=="ready_for_review")throw new Error("fixture");
    response.report.review.scene=r.sceneSpans.find(s=>s.key===r.selectedSceneKeys[0])!;response.report.review.requirements=r.requirements;response.report.review.targetSceneSeconds=r.requirements.targetSceneSeconds;
    response.report.review.shots=r.supplements.shots;response.report.review.candidate=r.candidate;return response;
  })};
  const candidates={targets:vi.fn(async()=>f.targets),list:vi.fn(async()=>({...f.page,items:[]})),get:vi.fn(async()=>f.stored),create:vi.fn(),saveScene:vi.fn(),placeShots:vi.fn()};
  const planning={options:vi.fn(async()=>f.options),list:vi.fn(async()=>({schema:"ads.vimax-planning.page.v1" as const,items:[]})),get:vi.fn(),cancel:vi.fn(),
    start:vi.fn(async(_p:string,_e:string,r:VimaxPlanningStart,key:string)=>{
      const output:VimaxCandidateCreate={schema:"ads.vimax-candidate.create.v1",target:r.target,request:{schema:"ads.vimax-platform-preview.request.v1",source:r.source,sceneSpans:r.sceneSpans,selectedSceneKeys:r.selectedSceneKeys,sourceDialogue:r.sourceDialogue,requirements:r.requirements,candidate:f.request.candidate,supplements:f.request.supplements}};
      return {schema:"ads.vimax-planning.response.v1" as const,replayed:false,request:{...f.completed,requestKey:key,input:{...f.completed.input,request:r},output}};
    })};
  const props={projectId:f.source.projectId,episodeId:f.source.episodeId,scriptReady:true,client:previewClient,candidateClient:candidates,planningClient:planning};
  return {...f,props,planning,candidates,previewClient};
}
async function prepare(target:string){
  fireEvent.click(screen.getByRole("button",{name:"单场景分镜预览"}));await screen.findByText(/当前来源：第 1 集/);
  fireEvent.click(screen.getByRole("button",{name:"准备在线单场景规划"}));await screen.findByRole("option",{name:/1\. 内景/});
  fireEvent.change(screen.getByLabelText("选择空场景及原文范围"),{target:{value:target}});
}
describe("mounted first-time ViMax planning in the existing workbench preview",()=>{
  it("plans directly from approved source and hands an explicitly imported answer into E2-B review without saving",async()=>{
    const h=setup();render(<VimaxPreviewPanel {...h.props}/>);await prepare(h.target.sceneId);
    expect(h.previewClient.preview).not.toHaveBeenCalled();expect((screen.getByLabelText("或粘贴分镜方案 JSON") as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(screen.getByLabelText("我已核对选中原文范围、每句对白与具体角色身份"));
    fireEvent.click(screen.getByRole("button",{name:"在线单场景规划"}));await screen.findByText(/最近 24 小时共享额度/);
    const send=screen.getByRole("button",{name:"预约并生成分镜规划"});expect((send as HTMLButtonElement).disabled).toBe(true);expect(h.planning.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("我确认发送当前单场景文本，接受一次规划费用未知"));fireEvent.click(send);
    await screen.findByRole("button",{name:"导入候选供人工核对"});expect(h.planning.start).toHaveBeenCalledOnce();
    const draft=h.planning.start.mock.calls[0]![2];expect(draft.sourceDialogue).toEqual(h.body.sourceDialogue);expect(draft.target).toEqual(h.body.target);expect(draft).not.toHaveProperty("candidate");
    expect(h.candidates.create).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("button",{name:"导入候选供人工核对"}));
    await screen.findByText("结构校验通过，可以人工对照");expect(h.previewClient.preview).toHaveBeenCalledOnce();expect(h.candidates.create).not.toHaveBeenCalled();expect(h.candidates.saveScene).not.toHaveBeenCalled();expect(h.candidates.placeShots).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button",{name:"保存与审核分镜候选"}));await screen.findByRole("button",{name:"保存候选"});
    expect(h.candidates.targets.mock.calls.length).toBeGreaterThanOrEqual(2);expect(h.candidates.create).not.toHaveBeenCalled();
  });
  it("never starts a send for an ineligible target or an invalidated approved source",async()=>{
    const h=setup();h.candidates.targets.mockResolvedValue({...h.targets,targets:[{...h.targets.targets[0]!,eligible:false,reasons:["target_has_shots"],activeShotCount:1}]});
    const view=render(<VimaxPreviewPanel {...h.props}/>);await prepare(h.target.sceneId);expect((screen.getByLabelText("我已核对选中原文范围、每句对白与具体角色身份") as HTMLInputElement).disabled).toBe(true);
    expect(h.planning.start).not.toHaveBeenCalled();view.rerender(<VimaxPreviewPanel {...h.props} scriptReady={false}/>);
    await waitFor(()=>expect(screen.queryByRole("button",{name:"准备在线单场景规划"})).toBeNull());expect(h.planning.start).not.toHaveBeenCalled();
  });
});
