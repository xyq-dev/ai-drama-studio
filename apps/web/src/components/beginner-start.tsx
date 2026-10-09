"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, StudioClient } from "../lib/studio-client";
import { bindDirectionToProject, premiseBlock, readSelectedDirection, removeOnce, switchBlock } from "../lib/creative-direction-link";
import { CATEGORIES, DIRECTION_STORAGE_KEY, EMPTY_DIRECTION, type DirectionDraft } from "../lib/creative-taxonomy";
import { IDEA_TEMPLATES, START_SCOPE_NOTE, suggestTitle } from "../lib/beginner-start";
import { LIMITS, draftStorageKey, nextDraft, readDraft, releaseSubmittedDraft, writeDraft } from "../lib/studio-model";
import { BeginnerShell } from "./beginner-shell";
import { InspirationPicker, type DirectionState } from "./inspiration-picker";
import { TitleWritingStart } from "./title-writing-start";
import styles from "./creator-entry.module.css";

interface ProjectItem {
  id: string;
  title: string;
}

const client = new StudioClient();
/** Same draft slot as the earlier create dialog, so an unfinished create keeps its idempotency key. */
const CREATE_KEY = draftStorageKey("new", "project", null);

const EDITED_NOTE = "「故事想法」里找不到原样的方向文字（可能已被你修改），为避免误删你写的内容，正文保持不变。";

/** Keeps the chosen direction in the browser slot the inspiration centre used; failing only loses that memory. */
function storeDirection(direction: DirectionDraft | null): void {
  try {
    window.localStorage.setItem(DIRECTION_STORAGE_KEY, JSON.stringify(direction ?? EMPTY_DIRECTION));
  } catch {
    // The direction still applies to this page's draft.
  }
}

/**
 * "你的故事，从这里开始". Typing, choosing a template, or browsing and using a story direction never creates a
 * project: only "确认创建作品" posts { title, premise } with the draft's idempotency key, which survives a failed or
 * unsure reply. A direction is appended to the idea once; switching or removing it takes out only the exact block
 * this page added, and never guesses at text the user has edited.
 */
export function BeginnerStart({ active }: { active: "/create" | undefined }) {
  const [idea, setIdea] = useState("");
  const [title, setTitle] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<ProjectItem | null>(null);
  const [direction, setDirection] = useState<DirectionDraft | null>(null);
  const [directionNote, setDirectionNote] = useState<string | null>(null);
  /** The exact block this page put into the idea for `direction`, or null when it has not been added. */
  const [appliedBlock, setAppliedBlock] = useState<string | null>(null);
  /** After an edited block blocked a switch: the direction the user may still add next to the old text. */
  const [keepAndAppend, setKeepAndAppend] = useState<DirectionDraft | null>(null);
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  const creatingRef = useRef(false);
  const ideaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let restored: string | null = null;
    try {
      const draft = readDraft(window.sessionStorage, CREATE_KEY);
      const payload = draft?.payload as { title?: unknown; premise?: unknown } | undefined;
      if (payload && typeof payload.premise === "string") {
        setIdea(payload.premise);
        restored = payload.premise;
      }
      if (payload && typeof payload.title === "string") setTitle(payload.title);
    } catch {
      // A broken draft slot only means nothing is restored.
    }
    if (restored !== null) setConfirming(true);
    try {
      // A stored direction is offered from the old "用这个方向新建作品" flag, or shown again after a reload when the
      // restored idea still carries its block verbatim.
      const selected = readSelectedDirection(window.localStorage);
      const inIdea = selected !== null && restored !== null && restored.includes(premiseBlock(selected));
      if (selected && (inIdea || new URLSearchParams(window.location.search).get("direction") === "1")) {
        setDirection(selected);
        if (inIdea) setAppliedBlock(premiseBlock(selected));
      }
    } catch {
      setDirection(null);
    }
    let alive = true;
    void client.get<{ items: ProjectItem[] }>("/projects").then((page) => {
      if (alive) setLatest(page.items[0] ?? null);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (confirming) confirmHeading.current?.focus();
  }, [confirming]);

  function remember(nextTitle: string, nextIdea: string) {
    // While a create is in flight the request content is frozen: nothing may change what was submitted.
    if (creatingRef.current) return;
    setTitle(nextTitle);
    setIdea(nextIdea);
    try {
      writeDraft(window.sessionStorage, CREATE_KEY,
        nextDraft(readDraft(window.sessionStorage, CREATE_KEY), { title: nextTitle, premise: nextIdea }, null, () => crypto.randomUUID()));
    } catch {
      // Without session storage the page still works; a retry then cannot reuse the key across a reload.
    }
  }

  function startConfirm() {
    if (idea.trim().length === 0) {
      setError("先写下一句你想拍的故事。");
      ideaRef.current?.focus();
      return;
    }
    setError(null);
    remember(title.trim().length > 0 ? title : suggestTitle(idea), idea);
    setConfirming(true);
  }

  /** "用这个方向": appends the direction once, or swaps it for the one this page added before. */
  function chooseDirection(next: DirectionDraft, keepOld = false) {
    if (creatingRef.current) return;
    const block = premiseBlock(next);
    const result = switchBlock(idea, keepOld ? null : appliedBlock, block, LIMITS.premise);
    setKeepAndAppend(null);
    if (!result.ok) {
      if (result.reason === "edited") {
        setDirectionNote(`${EDITED_NOTE}新方向没有加入；可以先手动删掉旧方向文字再选，或保留它另外加入新方向。`);
        setKeepAndAppend(next);
      } else {
        setDirectionNote("加入后会超过梗概长度上限，原内容没有改动。");
      }
      return;
    }
    const switched = !keepOld && appliedBlock !== null && appliedBlock !== block;
    if (result.changed) remember(title, result.text);
    setDirection(next);
    // The page owns the block only when it appended it now or already owned it; a copy the user wrote stays theirs.
    setAppliedBlock(result.changed || appliedBlock === block ? block : null);
    storeDirection(next);
    setDirectionNote(!result.changed ? "想法里已经有这段创作方向。"
      : switched ? "已换成新的方向，你写的其他内容没有改动。确认创建后才会保存。"
      : "已加入创作方向。确认创建后才会保存。");
  }

  /** "移除方向": takes out only the block this page added; edited text stays as written. */
  function removeDirection() {
    if (creatingRef.current) return;
    setKeepAndAppend(null);
    if (appliedBlock !== null) {
      const removed = removeOnce(idea, appliedBlock);
      if (removed.ok) {
        // An emptied idea cannot stay confirmed: 开始构思 is what checks that an idea was written.
        if (removed.text.trim().length === 0) setConfirming(false);
        remember(title, removed.text);
        setDirectionNote("已移除方向文字，你写的其他内容没有改动。");
      } else {
        setDirectionNote(`${EDITED_NOTE}方向已取消选择，需要的话可以手动删改这段文字。`);
      }
    } else if (direction && idea.includes(premiseBlock(direction))) {
      setDirectionNote("已取消选择。想法里这段方向文字不是本页加入的，没有删除。");
    } else {
      setDirectionNote("已取消选择这个方向。");
    }
    setDirection(null);
    setAppliedBlock(null);
    storeDirection(null);
  }

  async function create() {
    if (creatingRef.current) return;
    let draft;
    try {
      draft = nextDraft(readDraft(window.sessionStorage, CREATE_KEY), { title, premise: idea }, null, () => crypto.randomUUID());
      writeDraft(window.sessionStorage, CREATE_KEY, draft);
    } catch {
      draft = nextDraft(null, { title, premise: idea }, null, () => crypto.randomUUID());
    }
    creatingRef.current = true;
    setCreating(true);
    setError(null);
    try {
      const created = await client.write<ProjectItem>({ path: "/projects", body: { title, premise: idea }, idempotencyKey: draft.idempotencyKey });
      try {
        // Clear only the snapshot that was submitted; anything newer stays as this tab's draft.
        releaseSubmittedDraft(window.sessionStorage, CREATE_KEY, draft);
        if (direction && idea.includes(premiseBlock(direction))) bindDirectionToProject(window.localStorage, created.body.id, direction);
      } catch {
        // The project is saved; the browser-only extras are optional.
      }
      window.location.assign(`/projects/${created.body.id}/create`);
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status < 500 && caught.status !== 0
        ? `作品没有创建：${caught.detail}。你的内容还在，修改后可以再试。`
        : "没有确认作品是否已创建（网络或服务异常）。内容还在；再次点击会用同一个请求标识，服务器不会重复创建。");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  const directionState: DirectionState | null = !direction ? null
    : appliedBlock !== null ? (idea.includes(appliedBlock) ? "applied" : "edited")
    : idea.includes(premiseBlock(direction)) ? "present" : "pending";

  return (
    <BeginnerShell active={active}>
      <main className={`${styles.page} ${styles.startPage}`}>
        <header className={styles.headingRow}>
          <div>
            <p className={styles.eyebrow}>开始一部新作品</p>
            <h1 className={styles.heading}>你的故事，从这里开始</h1>
            <p className={styles.intro}>有想法直接写，没想法也可以先选一个方向。</p>
            {latest ? (
              <p>
                <a className={styles.continueLink} href={`/projects/${latest.id}/create`}>继续上次创作：{latest.title}<span aria-hidden="true">→</span></a>
              </p>
            ) : null}
          </div>
        </header>

        <div className={styles.startLayout}>
          <div className={styles.startContent}>
            <TitleWritingStart />
            <section id="manual-start" className={styles.formCard} aria-label="写下想法">
              <label id="idea-label" className={styles.fieldLabel} htmlFor="idea">你想拍一个什么样的故事？</label>
              <textarea
                ref={ideaRef}
                id="idea"
                className={styles.ideaInput}
                rows={4}
                maxLength={LIMITS.premise}
                placeholder="例如：一个外卖员发现自己每天送餐的那户人家，其实是他失散多年的哥哥。"
                value={idea}
                aria-describedby={error ? "start-error scope-note" : "scope-note"}
                disabled={creating}
                onChange={(event) => { setConfirming(false); remember(title, event.target.value); }}
              />
              <p id="scope-note" className={styles.scopeNote}>{START_SCOPE_NOTE}</p>
              <div className={styles.formActions}>
                <button className={confirming ? styles.secondary : styles.primary} type="button" disabled={creating} onClick={startConfirm}>开始构思<span aria-hidden="true">→</span></button>
                <a className={styles.textLink} href="#inspiration">还没想法？选一个故事方向</a>
              </div>
              <div className={styles.templateGroup}>
                <p className={styles.helper}>示例模板（静态示例，点选只会填入输入框，不会创建作品）</p>
                <ul className={styles.templateList}>
                  {IDEA_TEMPLATES.map((template) => (
                    <li key={template.id}>
                      <button className={styles.templateButton} type="button"
                        disabled={creating} onClick={() => { setConfirming(false); remember(title, template.idea); }}>
                        示例 · {template.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              {direction ? (
                <p className={styles.directionChip}>
                  已选方向：{CATEGORIES.find((item) => item.id === direction.categoryId)?.name}
                  <a className={styles.textLink} href="#inspiration">查看、更换或移除</a>
                </p>
              ) : null}
            </section>

            <InspirationPicker selected={direction} state={directionState} frozen={creating} note={directionNote}
              keepAndAppend={keepAndAppend} onUse={chooseDirection} onRemove={removeDirection} />

            {confirming ? (
              <section className={`${styles.formCard} ${styles.confirmCard}`} aria-labelledby="confirm-title">
                <h2 id="confirm-title" ref={confirmHeading} tabIndex={-1} className={styles.confirmHeading}>确认创建作品</h2>
                <p className="mt-1 text-[15px] text-[#5F5D66]">点「确认创建作品」后才会保存到服务器。之后在「定故事」一步把想法写成完整故事。</p>
                <label className="mt-4 block font-medium" htmlFor="work-title">作品名称</label>
                <input id="work-title" className={styles.titleInput} maxLength={LIMITS.title} value={title}
                  aria-describedby="title-hint" disabled={creating} onChange={(event) => remember(event.target.value, idea)} />
                <p id="title-hint" className="mt-1 text-sm text-[#5F5D66]">
                  建议名称按规则截取自你的想法开头，不是 AI 生成，可以直接修改。
                  <button className="ml-2 underline" type="button" disabled={creating} onClick={() => remember(suggestTitle(idea), idea)}>重新按想法截取</button>
                </p>
                <p className="mt-3 font-medium">故事想法</p>
                <p className={styles.premise}>{idea}</p>
                <div className={`${styles.confirmActions} fixed inset-x-0 bottom-0 sm:static`}>
                  <button className={styles.primary} type="button"
                    disabled={creating || title.trim().length === 0} onClick={() => void create()}>
                    {creating ? "正在创建…" : "确认创建作品"}
                  </button>
                  {creating ? <p className="mt-2 text-sm text-[#5F5D66]" role="status">正在创建，内容已锁定，完成前不能修改。</p> : null}
                </div>
              </section>
            ) : null}
            {error ? <p id="start-error" className={styles.notice} role="alert">{error}</p> : null}
          </div>
          <aside className={styles.journey} aria-label="创作流程说明">
            <h2 className={styles.journeyHeading}>接下来，只需做好五件事</h2>
            <p className={styles.journeyIntro}>每一步都可以回来修改，不用一次想完。</p>
            <ol className={styles.journeySteps}>
              {[
                ["定故事", "把想法写成完整故事，保存后检查确认。"],
                ["看剧本", "编辑或导入本集剧本，保存后提交审核。"],
                ["定人物", "设定主要角色的性格、关系和故事场地。"],
                ["试一段", "先做一个镜头。当前使用演示素材，合成后看看效果。"],
                ["出成片", "编排已批准的片段，合成、审核并下载本集。"],
              ].map(([step, description], index) => (
                <li key={step} className={styles.journeyStep}>
                  <span className={styles.journeyNumber} aria-hidden="true">{index + 1}</span>
                  <div>
                    <p className={styles.journeyTitle}>{step}</p>
                    <p className={styles.journeyDescription}>{description}</p>
                  </div>
                </li>
              ))}
            </ol>
          </aside>
        </div>
      </main>
    </BeginnerShell>
  );
}
