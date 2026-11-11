import type { ScriptWorkbenchScript } from "@ai-drama/contracts";

/** Canonical text projection of script-workbench.v1. Keep saved text and production readers on the same format. */
export function workbenchScriptText(script: ScriptWorkbenchScript): string {
  return [script.title, `开场3秒：${script.openingHook}`, `当集改变：${script.change}`,
    ...script.scenes.map((scene, index) => `${String(index + 1).padStart(2, "0")} ${scene.heading} ${scene.interiorExterior === "INT" ? "内景" : "外景"}·${scene.timeOfDay === "DAY" ? "日" : "夜"}\n出场：${scene.characterIds.join("、")}\n${scene.beats.map(b => b.kind === "dialogue" ? `${b.characterId}：${b.text}` : `${({ action: "动作", sound: "声音", pause: "停顿" } as const)[b.kind]}：${b.text}（${b.seconds}秒）`).join("\n")}`),
    `集尾交接：${script.endingHandoff}`].join("\n\n");
}
