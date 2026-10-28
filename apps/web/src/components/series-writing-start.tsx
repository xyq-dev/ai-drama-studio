"use client";

import { useEffect, useRef, useState } from "react";
import { SERIES_MAX_EPISODES, SERIES_MIN_EPISODES, seriesNormalCalls, seriesPlanCalls, seriesBatchCalls } from "@ai-drama/contracts";
import { TitleWritingError, tokenRequired } from "../lib/title-writing-client";
import {
  SeriesWritingClient,
  clearPendingSeries,
  readPendingSeries,
  savePendingSeries,
  seriesRefused,
  type PendingSeriesRequest,
  type SeriesCreateBody,
  type SeriesOptionsView,
} from "../lib/series-writing-client";
import styles from "./title-writing.module.css";
import series from "./series-writing.module.css";

const client = new SeriesWritingClient();
const SCOPE = "create";

function optionsProblem(options: SeriesOptionsView | null): string | null {
  if (!options) return "没能读取系列编剧的服务端配置。";
  if (options.code === "SERIES_WRITING_READY") return null;
  if (options.code === "SERIES_WRITING_DISABLED") return "系列编剧没有在服务端开启（需要 TITLE_WRITING_ENABLED 和 SERIES_WRITING_ENABLED）。原有创作方式不受影响。";
  if (options.code === "SERIES_WRITING_FORBIDDEN") return "服务端还没有可用的调用授权（未启用站点登录，也没有设置操作者令牌）。";
  if (options.code === "SERIES_WRITING_STORAGE_UNAVAILABLE") return "系列编剧的数据库迁移 20261023000100_series_writing 尚未执行（需由服务器部署流程单独授权执行）。";
  if (options.code === "SERIES_PROVIDER_UNCONFIGURED") return "还没有可用的模型服务（DeepSeek、Claude 或 OpenAI 都未配置完整）。";
  return "系列编剧暂不可用。";
}

/** A stored limit as its field shows it: unset is an empty field, never a default. */
function limitText(value: number | null): string {
  return value === null ? "" : String(value);
}

function whole(value: string, min: number, max: number): number | null | "invalid" {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/u.test(trimmed)) return "invalid";
  const parsed = Number(trimmed);
  return parsed >= min && parsed <= max ? parsed : "invalid";
}

/**
 * "系列编剧": a work of 1–60 episodes. Creating it writes the work and its frozen settings only: no model is called until
 * a person confirms a grant on the work's series page, which shows the scope, the calls and the provider first.
 */
export function SeriesWritingStart() {
  const [options, setOptions] = useState<SeriesOptionsView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [title, setTitle] = useState("");
  const [episodes, setEpisodes] = useState("60");
  const [seconds, setSeconds] = useState(60);
  const [idea, setIdea] = useState("");
  const [genre, setGenre] = useState("");
  const [audience, setAudience] = useState("");
  const [maxCharacters, setMaxCharacters] = useState("");
  const [maxLocations, setMaxLocations] = useState("");
  const [forbidden, setForbidden] = useState("");
  const [ending, setEnding] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingSeriesRequest<SeriesCreateBody> | null>(null);
  // Collapsed until asked for: the start page reads nothing about series writing before a person opens it.
  const [open, setOpen] = useState(false);
  const acting = useRef(false);

  // A request without a confirmed answer is restored after mount (the server render never sees this tab's storage), and
  // opens the card on it.
  useEffect(() => {
    const stored = readPendingSeries<SeriesCreateBody>(SCOPE);
    if (!stored) return;
    setPending(stored);
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    void client.options().then((value) => { if (alive) setOptions(value); }).catch(() => { if (alive) setOptions(null); })
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [open]);

  const problem = loaded ? optionsProblem(options) : null;
  const count = whole(episodes, SERIES_MIN_EPISODES, SERIES_MAX_EPISODES);
  // The call counts follow what will be sent: a pending request's own episode count, else the form's.
  const n = pending ? pending.body.episodeCount : typeof count === "number" ? count : 60;

  async function create() {
    if (acting.current) return;
    setError(null);
    let request = pending;
    if (!request) {
      const characters = whole(maxCharacters, 1, 12);
      const locations = whole(maxLocations, 1, 10);
      const themes = forbidden.split(/[,，、]/u).map((item) => item.trim()).filter(Boolean);
      if (title.trim().length === 0) return setError("请填写作品名称。");
      if (typeof count !== "number") return setError(`总集数必须是 ${String(SERIES_MIN_EPISODES)}–${String(SERIES_MAX_EPISODES)} 的整数。`);
      if (characters === "invalid") return setError("人物上限必须是 1–12 的整数，或留空。");
      if (locations === "invalid") return setError("地点上限必须是 1–10 的整数，或留空。");
      if (themes.length > 5 || themes.some((item) => item.length > 20)) return setError("禁止的题材或元素最多 5 项，每项最多 20 字。");
      request = { version: 1, scope: SCOPE, key: crypto.randomUUID(), body: {
        title: title.trim(), episodeCount: count, episodeSeconds: seconds, idea: idea.trim(),
        constraints: { genre: genre.trim(), audience: audience.trim(), maxCharacters: characters, maxLocations: locations, forbiddenThemes: themes, endingRequirement: ending.trim() },
      } };
      if (!savePendingSeries(request)) return setError("浏览器没能保存这次请求的标识，为避免重复创建，没有继续。");
      setPending(request);
    }
    acting.current = true;
    setBusy(true);
    try {
      const created = await client.create(request.body, { token: tokenRequired(options) ? token.trim() : "", idempotencyKey: request.key });
      clearPendingSeries(SCOPE, request.key);
      window.location.assign(`/projects/${created.projectId}/series`);
    } catch (caught) {
      if (seriesRefused(caught)) {
        clearPendingSeries(SCOPE, request.key);
        setPending(null);
        setError(caught instanceof TitleWritingError ? caught.detail : "没有创建。");
      } else {
        setError("没有确认是否已创建（网络或服务异常）。设置已保留，重试会使用同一个请求标识，不会重复创建。");
      }
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  const shown = pending?.body;
  // A pending request shows its own frozen constraints (display only: the retry sends the stored body unchanged).
  const frozen = shown?.constraints;
  if (!open) {
    return (
      <section className={styles.startCard} aria-labelledby="series-start-title" data-testid="series-start">
        <h2 id="series-start-title" className={styles.cardTitle}>系列编剧（1–{SERIES_MAX_EPISODES} 集）</h2>
        <p className={styles.cardIntro}>写多集连续剧：先做全剧规划，再每 3 集一批写正文。创建作品不会调用模型。</p>
        <div className={styles.actions}>
          <button className={styles.secondary} type="button" onClick={() => setOpen(true)} data-testid="series-start-open">开始系列编剧</button>
        </div>
      </section>
    );
  }
  return (
    <section className={styles.startCard} aria-labelledby="series-start-title" data-testid="series-start">
      <h2 id="series-start-title" className={styles.cardTitle}>系列编剧（1–{SERIES_MAX_EPISODES} 集）</h2>
      <p className={styles.cardIntro}>
        先做全剧规划，再每 3 集一批写正文并逐批全文审阅，最后做全剧结构与连续性总检。创建作品不会调用模型；每一步都要在作品的系列页面确认授权后才会开始。
      </p>
      {problem ? <p className={styles.warning} role="status">{problem}</p> : null}
      {shown ? <p className={styles.notice} role="status">上次的创建请求没有确认结果：重试会原样发送同一个请求（《{shown.title}》，{shown.episodeCount} 集）。</p> : null}
      <div className={series.formGrid}>
        <label className={styles.label} htmlFor="series-title">系列作品名称
          <input id="series-title" className={styles.input} maxLength={60} value={shown?.title ?? title} disabled={busy || shown !== undefined} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className={styles.label} htmlFor="series-episodes">总集数（1–{SERIES_MAX_EPISODES}）
          <input id="series-episodes" className={styles.input} inputMode="numeric" value={shown ? String(shown.episodeCount) : episodes} disabled={busy || shown !== undefined}
            onChange={(event) => setEpisodes(event.target.value)} />
        </label>
        <label className={styles.label} htmlFor="series-seconds">每集计划篇幅
          <select id="series-seconds" className={styles.input} value={shown?.episodeSeconds ?? seconds} disabled={busy || shown !== undefined} onChange={(event) => setSeconds(Number(event.target.value))}>
            <option value={60}>约 60 秒</option>
            <option value={90}>约 90 秒</option>
          </select>
        </label>
      </div>
      <label className={styles.label} htmlFor="series-idea">系列想法（可只填题材，或留空由 AI 策划）
        <textarea id="series-idea" className={styles.input} rows={2} maxLength={300} value={shown?.idea ?? idea} disabled={busy || shown !== undefined} onChange={(event) => setIdea(event.target.value)} />
      </label>
      <details className={styles.more} open={frozen !== undefined || undefined}>
        <summary>题材、目标观众、人物与地点上限、禁用题材、结局要求（可选）</summary>
        <div className={series.formGrid}>
          <label className={styles.label}>题材<input className={styles.input} maxLength={20} value={frozen ? frozen.genre : genre} disabled={busy || shown !== undefined} onChange={(event) => setGenre(event.target.value)} /></label>
          <label className={styles.label}>目标观众<input className={styles.input} maxLength={40} value={frozen ? frozen.audience : audience} disabled={busy || shown !== undefined} onChange={(event) => setAudience(event.target.value)} /></label>
          <label className={styles.label}>人物上限（1–12）<input className={styles.input} inputMode="numeric" value={frozen ? limitText(frozen.maxCharacters) : maxCharacters} disabled={busy || shown !== undefined} onChange={(event) => setMaxCharacters(event.target.value)} /></label>
          <label className={styles.label}>地点上限（1–10）<input className={styles.input} inputMode="numeric" value={frozen ? limitText(frozen.maxLocations) : maxLocations} disabled={busy || shown !== undefined} onChange={(event) => setMaxLocations(event.target.value)} /></label>
          <label className={styles.label}>禁止的题材或元素（逗号分隔）<input className={styles.input} value={frozen ? frozen.forbiddenThemes.join("，") : forbidden} disabled={busy || shown !== undefined} onChange={(event) => setForbidden(event.target.value)} /></label>
          <label className={styles.label}>结局要求<input className={styles.input} maxLength={100} value={frozen ? frozen.endingRequirement : ending} disabled={busy || shown !== undefined} onChange={(event) => setEnding(event.target.value)} /></label>
        </div>
      </details>
      <ul className={series.facts} data-testid="series-start-calls">
        <li>{n} 集的正常调用：只做全剧规划 {seriesPlanCalls(n)} 次；规划加前 3 集正文及该批审阅 {seriesPlanCalls(n) + seriesBatchCalls(n, 1)} 次；全部正文及检查 {seriesNormalCalls(n)} 次（公式 6 + ⌈N/6⌉ + N + ⌈N/3⌉）。</li>
        <li>这些是每步首次成功、零修改、零重发的次数，不是付费授权；授权在系列页面逐次确认。费用未知。</li>
      </ul>
      {tokenRequired(options) ? (
        <label className={styles.label} htmlFor="series-token">系列编剧操作者令牌
          <input id="series-token" className={styles.input} type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />
        </label>
      ) : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <button className={styles.primary} type="button" disabled={busy || !loaded || problem !== null} onClick={() => { void create(); }}>
          {shown ? "重试创建" : "创建系列作品"}
        </button>
        {shown ? <button className={styles.secondary} type="button" disabled={busy} onClick={() => { clearPendingSeries(SCOPE, shown ? pending!.key : ""); setPending(null); }}>放弃这次请求</button> : null}
      </div>
    </section>
  );
}
