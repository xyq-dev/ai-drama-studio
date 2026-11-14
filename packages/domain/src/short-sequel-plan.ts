import type { AutoBible, AutoCreationConstraints, AutoDirectionsOutput, AutoOutline, ScriptWorkbenchPlan } from "@ai-drama/contracts";

export interface ShortSequelOriginalPlan {
  story: AutoBible | null;
  topic: AutoDirectionsOutput | null;
  outline: AutoOutline | null;
  constraints: AutoCreationConstraints;
}

export function completedShortSequelOutline(episode: ScriptWorkbenchPlan["outline"]["episodes"][number]): boolean {
  return [episode.title, episode.openingHook, episode.change, episode.endingHandoff].every(value => value.trim().length > 0);
}

/** Project a frozen Auto plan into the workbench's planning schema. The original records remain the source. */
export function inheritShortSequelPlan(original: ShortSequelOriginalPlan, episodeSeconds: number, episodeCount: number): ScriptWorkbenchPlan | null {
  const { story: bible, topic, outline, constraints } = original;
  if (!bible?.story || !bible.characters?.length || !bible.locations?.length) return null;
  const selected = topic?.candidates?.find(item => item.id === topic.selection?.chosenId);
  return {
    brief: {
      genre: constraints?.genre?.trim() || "沿用原作题材",
      audience: constraints?.audience?.trim() || selected?.audienceFit || "沿用原作受众",
      productionConstraints: bible.locations.map(place => [place.name, place.layout, place.productionNotes].filter(Boolean).join(" · ")).join("\n"),
      logline: bible.logline,
      targetEpisodeSeconds: episodeSeconds,
      dialogueQuota: 12,
    },
    bible: {
      ending: bible.story.ending,
      openThreads: "",
      characters: bible.characters.map(character => ({ id: character.id, name: character.name, appearance: character.identity,
        voice: character.voice, aliases: "", knownInformation: character.motivation })),
    },
    outline: {
      episodes: Array.from({ length: episodeCount }, (_, index) => {
        const episodeNo = index + 1;
        const old = outline?.episodes?.find(episode => episode.episodeNo === episodeNo);
        return old ? { episodeNo, title: old.title, openingHook: old.opening, change: old.turn, endingHandoff: old.handoff }
          : { episodeNo, title: `第${episodeNo}集`, openingHook: "", change: "", endingHandoff: "" };
      }),
    },
  };
}
