import { SCRIPT_BREAKDOWN_OUTPUT_SCHEMA, type ScriptBreakdownOutput } from "@ai-drama/contracts";

/**
 * A deterministic stand-in for a model answering a breakdown prompt, for tests and the stubbed acceptances only. It
 * reads the script copy and the character table out of the prompt, so the answer really follows the script it was
 * given: one scene per "场 N …" heading, one shot per action or dialogue line (at most eight per scene), dialogue taken
 * word for word. Nothing here is ever used to save a breakdown when a real model fails.
 */
export function breakdownPromptParts(userPrompt: string): { episodeNo: number; script: string; characters: Array<{ key: string; name: string }> } {
  const episode = /把第 ([1-6]) 集剧本拆成场景和镜头/.exec(userPrompt);
  const start = userPrompt.indexOf("剧本正文（开始）\n");
  const end = userPrompt.indexOf("\n剧本正文（结束）");
  if (!episode?.[1] || start < 0 || end < start) throw new Error("not a breakdown prompt");
  const tableStart = userPrompt.indexOf("角色表：\n");
  const table = tableStart >= 0 ? userPrompt.slice(tableStart + "角色表：\n".length, start).split("\n") : [];
  const characters = table.map((line) => /^(C\d{1,2})：(.+)$/.exec(line.trim())).filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ key: match[1]!, name: match[2]!.trim() }));
  return { episodeNo: Number(episode[1]), script: userPrompt.slice(start + "剧本正文（开始）\n".length, end), characters };
}

export function isBreakdownPrompt(userPrompt: string): boolean {
  return /把第 [1-6] 集剧本拆成场景和镜头/.test(userPrompt);
}

export function fixtureBreakdownFromPrompt(userPrompt: string): ScriptBreakdownOutput {
  const { episodeNo, script, characters } = breakdownPromptParts(userPrompt);
  return fixtureBreakdown(episodeNo, script, characters);
}

export function fixtureBreakdown(episodeNo: number, script: string, characters: Array<{ key: string; name: string }> = []): ScriptBreakdownOutput {
  const blocks: Array<{ heading: string; lines: string[] }> = [];
  // Lines before the first heading (the episode title) belong to no scene; a script without headings is one scene.
  const preamble: string[] = [];
  for (const raw of script.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const heading = /^场\s*\d+\s*(.*)$/.exec(line);
    if (heading) {
      blocks.push({ heading: (heading[1] ?? "").trim() || `场景 ${String(blocks.length + 1)}`, lines: [] });
      continue;
    }
    if (blocks.length === 0) preamble.push(line);
    else blocks.at(-1)!.lines.push(line);
  }
  if (blocks.length === 0) blocks.push({ heading: "开场", lines: preamble });
  const scenes = blocks.slice(0, 8).map((block, index) => ({
    key: `S${String(index + 1)}`,
    heading: block.heading.slice(0, 40),
    timeOfDay: /夜/.test(block.heading) ? "夜" : "",
    description: (block.lines[0] ?? block.heading).slice(0, 200),
  }));
  const shots: ScriptBreakdownOutput["shots"] = [];
  blocks.slice(0, 8).forEach((block, index) => {
    const sceneKey = `S${String(index + 1)}`;
    const lines = block.lines.length > 0 ? block.lines : [block.heading];
    lines.slice(0, 8).forEach((line, shotIndex) => {
      if (shots.length >= 20) return;
      const spoken = /^([^：:]{1,20})[：:](.+)$/.exec(line);
      const speaker = spoken?.[1]?.trim();
      const known = speaker ? characters.find((item) => item.name === speaker) : undefined;
      shots.push({
        key: `${sceneKey}-${String(shotIndex + 1)}`,
        sceneKey,
        shotType: spoken ? "近景" : "中景",
        camera: spoken ? "固定机位，人物胸像" : "缓慢推近",
        action: (spoken ? `${speaker ?? ""}说话` : line).slice(0, 120),
        dialogue: spoken && speaker ? [{ speaker, line: spoken[2]!.trim().slice(0, 120) }] : [],
        characterKeys: known ? [known.key] : [],
        plannedSeconds: spoken ? 4 : 3,
      });
    });
  });
  return { schema: SCRIPT_BREAKDOWN_OUTPUT_SCHEMA, episodeNo, scenes, shots };
}
