import { autoStageRound, type AutoBible, type AutoCreationRunView, type AutoEpisode, type AutoOutline } from "@ai-drama/contracts";
import { stageOf } from "../lib/auto-creation-client";
import type { ReactNode } from "react";
import styles from "./auto-creation.module.css";
import writingStyles from "./title-writing.module.css";

function scenePlace(scene: AutoEpisode["scenes"][number], location: AutoBible["locations"][number] | undefined): string {
  return [location?.name ?? scene.locationId, location ? (location.intExt === "EXT" ? "外景" : "内景") : null, scene.timeOfDay]
    .filter(Boolean).join(" · ");
}

function EpisodeDetails({ episode, bible, outline }: {
  episode: AutoEpisode;
  bible: AutoBible | undefined;
  outline: AutoOutline["episodes"][number] | undefined;
}) {
  const characters = new Map(bible?.characters.map((character) => [character.id, character]));
  const locations = new Map(bible?.locations.map((location) => [location.id, location]));
  const appearances = new Map<string, number[]>();
  for (const scene of episode.scenes) {
    for (const id of new Set(scene.characterIds)) {
      const scenes = appearances.get(id) ?? [];
      scenes.push(scene.sceneNo);
      appearances.set(id, scenes);
    }
  }

  return (
    <div className={styles.episodeDetails}>
      {outline ? (
        <div>
          <h3>本集简介 <small>来自分集大纲</small></h3>
          <dl className={styles.episodeGrid}>
            <div><dt>开场</dt><dd>{outline.opening}</dd></div>
            <div><dt>本集目标</dt><dd>{outline.goal}</dd></div>
            <div><dt>转折</dt><dd>{outline.turn}</dd></div>
            <div><dt>本集结果</dt><dd>{outline.result}</dd></div>
          </dl>
        </div>
      ) : null}

      <div className={styles.episodeGrid}>
        <div className={styles.episodePanel}>
          <h3>出场人物</h3>
          <ul className={styles.episodeFacts}>
            {[...appearances].map(([id, scenes]) => {
              const character = characters.get(id);
              return (
                <li key={id}>
                  <strong>{character?.name ?? id}</strong>
                  {character ? <p>{character.identity}</p> : null}
                  <small>{scenes.map((number) => `第 ${number} 场`).join("、")}出场</small>
                </li>
              );
            })}
          </ul>
        </div>
        <div className={styles.episodePanel}>
          <h3>本集场景</h3>
          <ol className={styles.episodeFacts}>
            {episode.scenes.map((scene) => {
              const location = locations.get(scene.locationId);
              return (
                <li key={scene.sceneNo}>
                  <strong>第 {scene.sceneNo} 场 · {scenePlace(scene, location)}</strong>
                  {location ? <p>{location.layout}</p> : null}
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      <div>
        <h3>剧本正文</h3>
        <div className={styles.episodeScenes}>
          {episode.scenes.map((scene) => (
            <div key={scene.sceneNo} className={writingStyles.scriptText}>
              <h4>第 {scene.sceneNo} 场 · {scenePlace(scene, locations.get(scene.locationId))}</h4>
              <p>出场：{scene.characterIds.map((id) => characters.get(id)?.name ?? id).join("、")}</p>
              <p>△ {scene.action}</p>
              {scene.dialogue.map((line, index) => <p key={index}>{characters.get(line.characterId)?.name ?? line.characterId}{line.delivery ? `（${line.delivery}）` : ""}：{line.line}</p>)}
              {scene.sound ? <p>【声音】{scene.sound}</p> : null}
              <p className={writingStyles.helper}>镜头设计：{scene.shots.map((shot) => `${shot.shotNo}. ${shot.framing}·${shot.description}（约 ${shot.seconds} 秒）`).join("；")}</p>
              {scene.assetNeeds.length > 0 ? <p className={writingStyles.helper}>素材需求：{scene.assetNeeds.join("、")}</p> : null}
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3>集尾交接</h3>
        <ul className={styles.list}>{episode.handoffFacts.map((fact, index) => <li key={index}>{fact}</li>)}</ul>
      </div>
    </div>
  );
}

export function AutoEpisodeList({ run, bible, outline, continuation }: {
  run: AutoCreationRunView;
  bible: AutoBible | undefined;
  outline: AutoOutline | null | undefined;
  continuation?: ReactNode;
}) {
  const episodes = Object.entries(run.currentEpisodes).flatMap(([episodeKey, versionKey]) => {
    const stage = stageOf(run, versionKey);
    if (!stage?.output || (stage.kind !== "episode" && stage.kind !== "revise")) return [];
    return [{ episodeKey, versionKey, episode: stage.output as AutoEpisode }];
  }).sort((a, b) => a.episode.episodeNo - b.episode.episodeNo);

  if (episodes.length === 0) return null;

  return (
    <section className={styles.section} aria-labelledby="auto-episodes-title" data-testid="auto-episodes">
      <div className={styles.episodeHeading}>
        <h2 id="auto-episodes-title" className={writingStyles.sectionTitle}>分集剧本</h2>
        <span>已写好 {episodes.length} / {run.episodeCount} 集</span>
      </div>
      <ol className={styles.episodes}>
        {episodes.map(({ episodeKey, versionKey, episode }) => {
          const round = autoStageRound(versionKey);
          return (
            <li key={episodeKey}>
              <details className={styles.episode}>
                <summary>
                  <span className={styles.episodeLabel}>
                    <strong>第 {episode.episodeNo} 集 · {episode.title}</strong>
                    <small>{episode.scenes.length} 场 · {round === null ? "初稿" : `第 ${round} 轮修改稿`}</small>
                  </span>
                  <span className={styles.episodeChevron} aria-hidden="true" />
                </summary>
                <EpisodeDetails episode={episode} bible={bible} outline={outline?.episodes.find((item) => item.episodeNo === episode.episodeNo)} />
              </details>
            </li>
          );
        })}
      </ol>
      {continuation}
    </section>
  );
}
