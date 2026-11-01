import { describe,expect,it,vi } from "vitest";
import type { DatabasePool } from "./job-service";
import { RuntimeStore } from "./runtime-store";
describe("Mock/real media discovery isolation",()=>{
  it("explicitly excludes real schemas while preserving legacy NULL schemas in all Mock and generic discovery",async()=>{
    const query=vi.fn(async(_sql:string)=>({rows:[]}));const store=new RuntimeStore({connect:async()=>({query,release:()=>undefined})} as unknown as DatabasePool);
    await store.listExpiredMockMedia(5);await store.loadMockMediaExecution("workspace","job");await store.listExpiredRunning(5);await store.listWaitingExternal(5);await store.loadCharacterReferenceExecution("workspace","job");await store.loadExecution("workspace","job");
    expect(query).toHaveBeenCalledTimes(6);
    for(const call of query.mock.calls)expect(String(call[0])).toContain("IS DISTINCT FROM 'real-media.v1'");
  });
});
