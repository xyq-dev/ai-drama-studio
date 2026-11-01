import { describe, expect, it } from "vitest";
import { vimaxPlanningFixture } from "./vimax-planning-test-fixtures";
import { buildPlanningSourceDraft, planningSceneBoundaries, planningSceneDialogue } from "./vimax-planning-source";
describe("planning source admission without an imported candidate",()=>{
  it("uses exact UTF-16 spans and preserves source whitespace and CRLF dialogue",()=>{
    const text="【场景】内景\r\n【动作】窗外有雨。\r\n甲：  原文😀  \r\n【场景】外景\r\n【动作】空镜。\r\n";
    const scenes=planningSceneBoundaries(text);expect(scenes).toHaveLength(2);expect(scenes[0]!.start).toBe(0);expect(scenes[1]!.start).toBe(scenes[0]!.end);expect(scenes[1]!.end).toBe(text.length);
    const lines=planningSceneDialogue(text,scenes[0]!);expect(lines[0]!.line).toBe("  原文😀  ");expect(text.slice(lines[0]!.start,lines[0]!.end)).toBe("甲：  原文😀  ");
  });
  it("builds a first-call draft from source and an existing target, with no candidate fields",()=>{
    const f=vimaxPlanningFixture();const r=buildPlanningSourceDraft(f.source,f.target,{},"写实",13);
    expect(r.target).toEqual(f.body.target);expect(r.sourceDialogue).toEqual(f.body.sourceDialogue);expect(r).not.toHaveProperty("candidate");expect(r).not.toHaveProperty("supplements");
  });
  it("requires explicit identity for same-name characters and rejects mismatched target ranges",()=>{
    const f=vimaxPlanningFixture(),character=f.source.characters[0]!;f.source.characters.push({...character,key:"C3",characterId:"e0000000-0000-4000-8000-000000000001",revisionId:"e0000000-0000-4000-8000-000000000002"});
    expect(()=>buildPlanningSourceDraft(f.source,f.target,{},"写实",13)).toThrow(/明确选择/);
    const mappings=Object.fromEntries(f.body.sourceDialogue.map(l=>[l.id,l.characterKey!]));expect(buildPlanningSourceDraft(f.source,f.target,mappings,"写实",13).sourceDialogue).toEqual(f.body.sourceDialogue);
    expect(()=>buildPlanningSourceDraft(f.source,{...f.target,ordinal:2},mappings,"写实",13)).toThrow(/不一致/);
  });
  it("refuses unmarked source lines and unknown speakers without guessing or rewriting",()=>{
    expect(()=>planningSceneBoundaries("普通段落，未标场景")).toThrow(/不会猜测/);
    const text="【场景】内景\n这一行没有说话人标注。\n";expect(()=>planningSceneDialogue(text,planningSceneBoundaries(text)[0]!)).toThrow(/不会猜测/);
    const f=vimaxPlanningFixture();f.source.characters=[];expect(()=>buildPlanningSourceDraft(f.source,f.target,{},"写实",13)).toThrow(/未登记/);
  });
});
