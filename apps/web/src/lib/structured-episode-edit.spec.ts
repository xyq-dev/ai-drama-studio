import { describe, expect, it } from "vitest";
import type { ScriptWorkbenchScript } from "@ai-drama/contracts";
import { workbenchScriptText } from "@ai-drama/domain/script-workbench";
import { applyEpisodeEdit } from "@ai-drama/domain/writing-assistant";
import { emptyScript } from "./script-workbench-model";
import { adoptStructuredEpisodeEdit } from "./structured-episode-edit";

const characters = ["司机", "乘客"].map((name, i) => ({ id: `P${i}`, name, appearance: "", voice: "", aliases: "", knownInformation: "" }));
const story = { workbench: { schema: "script-workbench.v1", plan: {
  brief: { genre: "", audience: "", productionConstraints: "", logline: "", targetEpisodeSeconds: 60, dialogueQuota: 10 },
  bible: { ending: "", openThreads: "", characters }, outline: { episodes: [] },
} } };
function fixture(named = true) {
  const script: ScriptWorkbenchScript = { ...emptyScript("末班车"), endingHandoff: "留下车票", scenes: [{
    id: "station", heading: "车站", interiorExterior: "EXT", timeOfDay: "NIGHT", characterIds: characters.map(c => c.id),
    beats: characters.map(c => ({ id: `beat-${c.id}`, kind: "dialogue", characterId: c.id, text: "走吧。", seconds: 3 })),
  }] };
  const text = workbenchScriptText(script, named ? characters : undefined);
  return { text, workbench: { schema: "script-workbench.v1", script }, metadata: "保留" };
}
describe("precise changes to structured scripts", () => {
  it.each([true, false])("updates exactly the intended speaker and preserves metadata for named=%s", named => {
    const original = fixture(named);
    const speaker = named ? "司机" : "P0";
    const changes = { changes: [{ before: `${speaker}：走吧。`, after: `${speaker}：坐稳了。` }, { before: "车站", after: "公交站" }] };
    const expected = applyEpisodeEdit(original.text, changes);
    const next = adoptStructuredEpisodeEdit(original, story, expected, changes)!;
    expect(next.text).toBe(expected);
    expect(next).toMatchObject({ metadata: "保留" });
    const changed = next.workbench.script;
    expect(changed.scenes[0]).toMatchObject({ id: "station", heading: "公交站", beats: [{ id: "beat-P0", text: "坐稳了。", seconds: 3 }, { id: "beat-P1", text: "走吧。", seconds: 3 }] });
    expect(workbenchScriptText(changed, named ? characters : undefined)).toBe(expected);
    expect(original.workbench.script.scenes[0]!.beats[0]!.text).toBe("走吧。");
  });

  it("refuses an edit to a speaker identity, a cross-field replacement, or an already inconsistent projection", () => {
    const original = fixture();
    for (const change of [{ before: "司机：走吧。", after: "陌生人：走吧。" },
      { before: "司机：走吧。\n乘客：走吧。", after: "两人离开" }]) {
      const changes = { changes: [change] };
      expect(() => adoptStructuredEpisodeEdit(original, story, applyEpisodeEdit(original.text, changes), changes)).toThrow(/原稿已保留/);
    }
    const stale = { ...original, text: original.text + "旧稿" };
    const changes = { changes: [{ before: "留下车票", after: "收起车票" }] };
    expect(() => adoptStructuredEpisodeEdit(stale, story, applyEpisodeEdit(stale.text, changes), changes)).toThrow(/原稿已保留/);
    expect(original).toEqual(fixture());
    expect(adoptStructuredEpisodeEdit({ text: "普通文本" }, undefined, "候选")).toBeNull();
  });
});
