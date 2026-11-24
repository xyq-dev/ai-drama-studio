import { scriptWorkbenchPlanSchema, scriptWorkbenchScriptSchema, type EpisodeEdit, type ScriptWorkbenchScript } from "@ai-drama/contracts";
import { workbenchScriptText } from "@ai-drama/domain/script-workbench";
import { applyEpisodeEdit } from "@ai-drama/domain/writing-assistant";

const mappingError = "修改无法对应到本集的结构化剧本字段。原稿已保留，请在剧本工作台按候选对照修改。";
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const fieldMarker = (index: number) => `\u0000${index}\u0000`;

type Field = { value: string; set: (value: string) => void; start: number; length: number };

/** Mark editable strings in a copy, then locate them using the same text projection as the production reader. */
function markScriptFields(script: ScriptWorkbenchScript): Field[] {
  const fields: Field[] = [];
  function mark<T extends string>(owner: Record<T, string>, property: T) {
    const index = fields.length;
    fields.push({ value: owner[property], length: owner[property].length, set: value => { owner[property] = value; }, start: -1 });
    owner[property] = fieldMarker(index);
  }
  mark(script, "title");
  mark(script, "openingHook");
  mark(script, "change");
  for (const scene of script.scenes) {
    mark(scene, "heading");
    for (const beat of scene.beats) mark(beat, "text");
  }
  mark(script, "endingHandoff");
  return fields;
}

/** A null result means ordinary text; malformed or unrepresentable structured edits are refused. */
export function adoptStructuredEpisodeEdit(content: unknown, storyContent: unknown, formatted: string, edit?: EpisodeEdit) {
  const draft = record(content);
  const envelope = record(draft?.workbench);
  if (envelope?.schema !== "script-workbench.v1") return null;
  const source = draft?.text;
  const parsed = scriptWorkbenchScriptSchema.safeParse(envelope.script);
  if (!parsed.success || typeof source !== "string" || source.includes("\u0000") || !edit || applyEpisodeEdit(source, edit) !== formatted) throw new Error(mappingError);
  const script = parsed.data;
  const story = record(record(storyContent)?.workbench);
  const plan = story?.schema === "script-workbench.v1" ? scriptWorkbenchPlanSchema.safeParse(story.plan) : null;
  const names = plan?.success ? plan.data.bible.characters : undefined;
  const characters = names && workbenchScriptText(script, names) === source ? names : undefined;
  if (workbenchScriptText(script, characters) !== source) throw new Error(mappingError);
  const fields = markScriptFields(script);
  const template = workbenchScriptText(script, characters);
  let offset = 0, cursor = 0;
  for (const [index, field] of fields.entries()) {
    const marker = fieldMarker(index);
    const position = template.indexOf(marker, cursor);
    if (position < 0) throw new Error(mappingError);
    field.start = position + offset;
    cursor = position + marker.length;
    offset += field.value.length - marker.length;
    field.set(field.value);
  }
  // Remove unchanged labels and speaker names included as context by the model.
  const changes = edit.changes.map(({ before, after }) => {
    let prefix = 0, oldEnd = before.length, newEnd = after.length;
    while (prefix < oldEnd && prefix < newEnd && before[prefix] === after[prefix]) prefix++;
    while (prefix < oldEnd && prefix < newEnd && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
    const at = source.indexOf(before);
    return { start: at + prefix, end: at + oldEnd, insert: after.slice(prefix, newEnd) };
  }).sort((a, b) => b.start - a.start);
  // Work backwards so offsets in the frozen original remain valid for every replacement.
  for (const change of changes) {
    const match = fields.filter(field => field.start >= 0 && field.start <= change.start && field.start + field.length >= change.end);
    if (match.length !== 1) throw new Error(mappingError);
    const field = match[0]!;
    field.value = field.value.slice(0, change.start - field.start) + change.insert + field.value.slice(change.end - field.start);
    field.set(field.value);
  }
  if (!scriptWorkbenchScriptSchema.safeParse(script).success || workbenchScriptText(script, characters) !== formatted) throw new Error(mappingError);
  return { ...draft, text: formatted, workbench: { ...envelope, script } };
}
