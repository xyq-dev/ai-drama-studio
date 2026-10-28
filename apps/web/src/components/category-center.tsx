"use client";

import { useEffect, useRef, useState } from "react";
import { CATEGORIES, DIRECTION_STORAGE_KEY, EMPTY_DIRECTION, TAG_GROUPS, TAGS, formatCreativeDirection, matchesSearch, parseDirectionDraft, type Category, type DirectionDraft } from "../lib/creative-taxonomy";
import { useModalKeyboard } from "../lib/modal-keyboard";
import { CategoryArtwork, CategoryHeroArtwork } from "./category-artwork";
import styles from "./category-center.module.css";

const ICONS: Record<string, string> = {
  search: "m21 21-4.6-4.6 M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0",
  layers: "m3 8 9-5 9 5-9 5-9-5 M3 12l9 5 9-5 M3 16l9 5 9-5",
  tag: "M3 3h8l10 10-8 8L3 11V3z M7 7h.01",
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  globe: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c5 5 5 13 0 18-5-5-5-13 0-18",
  script: "M5 3h10l4 4v14H5z M14 3v5h5 M8 12h8 M8 16h6",
  person: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2",
  heart: "M12 21 4 13C-3 6 6-1 12 6c6-7 15 0 8 7l-8 8z",
  smile: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M8 9h.01 M16 9h.01 M7 14q5 6 10 0",
  arrow: "m9 5 7 7-7 7",
  check: "m5 12 4 4 10-10",
  copy: "M9 9h12v12H9z M15 9V3H3v12h6",
  close: "m6 6 12 12 M6 18 18 6",
};

function Icon({ name, className }: { name: string; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={ICONS[name] ?? ICONS.grid} /></svg>;
}

export function CategoryCenter() {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const [draft, setDraft] = useState<DirectionDraft>(EMPTY_DIRECTION);
  const [ready, setReady] = useState(false);
  const [storageMessage, setStorageMessage] = useState("创作方向仅保存在当前浏览器，不会自动写入作品。");
  const [detail, setDetail] = useState<Category | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "manual">("idle");
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const detailOpened = useRef(false);
  const copyEpoch = useRef(0);
  const mounted = useRef(true);
  const manualCopyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    mounted.current = true;
    try {
      const raw = window.localStorage.getItem(DIRECTION_STORAGE_KEY);
      if (raw) {
        const restored = parseDirectionDraft(raw);
        if (restored) setDraft(restored);
        else setStorageMessage("旧的创作方向无法恢复，请重新选择。原存储会在下次选择时更新。");
      }
    } catch { setStorageMessage("浏览器存储不可用，当前选择仅在本页保留，可复制后自行保存。"); }
    setReady(true);
    return () => { mounted.current = false; copyEpoch.current += 1; };
  }, []);

  function remember(next: DirectionDraft) {
    copyEpoch.current += 1;
    setCopyState("idle");
    setDraft(next);
    try {
      window.localStorage.setItem(DIRECTION_STORAGE_KEY, JSON.stringify(next));
      setStorageMessage("已保存在当前浏览器，不会自动写入作品。");
    } catch { setStorageMessage("保存失败，当前选择仅在本页保留，请复制后自行保存。"); }
  }

  function toggleTag(id: string) {
    remember({ ...draft, tagIds: draft.tagIds.includes(id) ? draft.tagIds.filter((tag) => tag !== id) : [...draft.tagIds, id] });
  }

  function closeDetail() { setDetail(null); }
  useModalKeyboard(detail !== null, dialogRef, closeDetail);
  useEffect(() => {
    if (detail) { detailOpened.current = true; closeRef.current?.focus(); }
    else if (detailOpened.current) { detailOpened.current = false; openerRef.current?.focus(); }
  }, [detail]);
  useEffect(() => { if (copyState === "manual") { manualCopyRef.current?.focus(); manualCopyRef.current?.select(); } }, [copyState]);

  async function copyDirection() {
    const epoch = ++copyEpoch.current;
    setCopyState("copying");
    try {
      await navigator.clipboard.writeText(formatCreativeDirection(draft));
      if (mounted.current && epoch === copyEpoch.current) setCopyState("copied");
    } catch { if (mounted.current && epoch === copyEpoch.current) setCopyState("manual"); }
  }

  const categories = CATEGORIES.filter((item) => matchesSearch(query, item.name, item.id, item.description));
  const tags = TAGS.filter((item) => (group === "all" || item.groupId === group) && matchesSearch(query, item.name, item.groupName));
  const selectedCategory = CATEGORIES.find((item) => item.id === draft.categoryId);
  const selectedTags = TAGS.filter((item) => draft.tagIds.includes(item.id));
  const filtered = query.trim().length > 0;

  return (
    <div className={styles.page}>
      <main className={`creator-page ${styles.main}`}>
        <div className={styles.content}>
          <header className={`creator-page-heading ${styles.heading}`}>
            <div><div className={styles.titleLine}><h1>灵感中心</h1><span className={styles.badge}>创作灵感库</span></div><p>找到故事的方向，让每一个灵感都有清晰的表达。</p></div>
            <a className={`ui-button ui-button-primary ${styles.primaryButton}`} href="/create"><span aria-hidden="true">＋</span>开始创作</a>
          </header>
          <div className={styles.topbar}>
            <div className={styles.search}>
              <Icon name="search" />
              <input aria-label="搜索分类、标签或关键词" type="search" maxLength={100} placeholder="搜索分类、标签或关键词…" value={query} onChange={(event) => setQuery(event.target.value)} />
              {query ? <button type="button" aria-label="清空搜索" onClick={() => setQuery("")}><Icon name="close" /></button> : <span className={styles.searchHint}>寻找灵感</span>}
            </div>
            <a className={styles.workspaceLink} href="/studio">返回我的作品<Icon name="arrow" /></a>
          </div>
          <div className={styles.columns}>
            <div className={styles.primaryColumn}>
              <section className={styles.stats} aria-label="分类库概览">
                {[{ icon: "layers", title: "一级分类", count: CATEGORIES.length, label: "固定题材", note: "为故事确定一个主方向" }, { icon: "tag", title: "二级标签", count: TAGS.length, label: "多选组合", note: "用标签丰富内容的表达" }, { icon: "grid", title: "标签组", count: TAG_GROUPS.length, label: "结构化管理", note: "从不同维度描绘故事" }].map((stat) => <article className={styles.statCard} key={stat.title}><div className={styles.statIcon}><Icon name={stat.icon} /></div><div><h2>{stat.title}</h2><div className={styles.statValue}><strong>{stat.count}</strong><span>{stat.label}</span></div><p>{stat.note}</p></div></article>)}
              </section>

              <section className={styles.panel} aria-labelledby="category-heading">
                <div className={styles.sectionHeading}><h2 id="category-heading">一级分类 <span>（固定 {CATEGORIES.length} 个）</span></h2><p>选择最能代表故事主线的一个题材</p></div>
                {filtered ? <p className={styles.results} role="status">找到 {categories.length} 个分类、{tags.length} 个标签{group !== "all" ? "（当前标签组内）" : ""}</p> : null}
                <div className={styles.categoryGrid}>
                  {categories.map((category) => <button type="button" key={category.id} className={`${styles.categoryCard} ${draft.categoryId === category.id ? styles.categorySelected : ""}`} aria-haspopup="dialog" aria-label={`查看${category.name}分类`} onClick={(event) => { openerRef.current = event.currentTarget; setDetail(category); }}><span className={styles.artwork}><CategoryArtwork id={category.id} /></span><span className={styles.categoryName}><strong>{category.name}</strong><small>查看题材灵感</small></span><Icon name={draft.categoryId === category.id ? "check" : "arrow"} /></button>)}
                </div>
                {!categories.length ? <div className={styles.empty}><Icon name="search" /><strong>没有找到对应分类</strong><p>试试更简短的关键词，或查看下方标签。</p><button type="button" onClick={() => setQuery("")}>显示全部分类</button></div> : null}
              </section>

              <section className={styles.panel} aria-labelledby="group-heading">
                <div className={styles.sectionHeading}><h2 id="group-heading">标签组结构</h2><p>从不同维度描述短剧，支持多选组合</p></div>
                <div className={styles.groupGrid}>{TAG_GROUPS.map((item) => <a key={item.id} className={`${styles.groupCard} ${styles[item.color]}`} href="#tag-library" onClick={() => { setGroup(item.id); setQuery(""); }}><span className={styles.groupIcon}><Icon name={item.icon} /></span><h3>{item.name}</h3><strong>{item.tags.length}</strong><p>{item.description}</p></a>)}</div>
              </section>

              <section id="tag-library" className={styles.panel} aria-labelledby="tag-heading">
                <div className={styles.sectionHeading}><h2 id="tag-heading">发现故事标签</h2><span className={styles.selectedCount}>已选择 {draft.tagIds.length} 个</span></div>
                <p className={styles.sectionIntro}>一个主分类，加上几个好标签，让创作方向更具体。</p>
                <div className={styles.filters} role="group" aria-label="筛选标签组"><button type="button" aria-pressed={group === "all"} onClick={() => setGroup("all")}>全部标签</button>{TAG_GROUPS.map((item) => <button type="button" key={item.id} aria-pressed={group === item.id} onClick={() => setGroup(item.id)}>{item.name}</button>)}</div>
                <div className={styles.tags}>{tags.map((tag) => <button disabled={!ready} key={tag.id} type="button" aria-pressed={draft.tagIds.includes(tag.id)} onClick={() => toggleTag(tag.id)} title={tag.groupName}>{draft.tagIds.includes(tag.id) ? <Icon name="check" /> : <span aria-hidden="true">＋</span>}{tag.name}</button>)}</div>
                {!tags.length ? <div className={styles.empty}><p>当前条件下没有标签</p><button type="button" onClick={() => { setQuery(""); setGroup("all"); }}>清除筛选</button></div> : null}
              </section>

              <section className={`${styles.panel} ${styles.direction}`} aria-labelledby="direction-heading">
                <div className={styles.sectionHeading}><h2 id="direction-heading">我的创作方向</h2>{(draft.categoryId || draft.tagIds.length > 0) ? <button type="button" className={styles.textButton} onClick={() => remember({ ...EMPTY_DIRECTION, tagIds: [] })}>清空选择</button> : null}</div>
                <div className={styles.directionCategory}>{selectedCategory ? <><span className={styles.directionMiniArt}><CategoryArtwork id={selectedCategory.id} /></span><div><small>主分类</small><strong>{selectedCategory.name}</strong></div></> : <p>还没有选择主分类。点击上方题材卡片，找到你的故事方向。</p>}</div>
                <div className={styles.chosenTags}>{selectedTags.map((tag) => <button key={tag.id} type="button" aria-label={`移除${tag.name}`} onClick={() => toggleTag(tag.id)}>{tag.name}<Icon name="close" /></button>)}</div>
                <div className={styles.directionFooter}><div><p>建议从不同标签组选择 4–6 个标签，可按故事需要调整。</p><small role="status">{storageMessage}</small></div><button disabled={!selectedCategory || copyState === "copying"} className={`ui-button ui-button-primary ${styles.primaryButton}`} type="button" onClick={() => void copyDirection()}><Icon name={copyState === "copied" ? "check" : "copy"} />{copyState === "copied" ? "已复制创作方向" : copyState === "copying" ? "正在复制…" : "复制创作方向"}</button></div>
                <p className={styles.useHint}>复制后可粘贴到作品梗概或编剧助手的本次要求中，由你确认并保存。</p>
                {selectedCategory ? <p className={styles.useHint}><a className={styles.textButton} href="/create?direction=1">用这个方向新建作品</a>：在新建作品里由你决定是否加入梗概，方向只在本浏览器保存。</p> : null}
                {copyState === "manual" ? <label className={styles.manualCopy}>自动复制不可用，请手动复制以下内容<textarea ref={manualCopyRef} aria-label="手动复制创作方向" readOnly rows={7} value={formatCreativeDirection(draft)} /></label> : null}
              </section>
              <p className={styles.catalogNote}>以上为本产品的创作参考分类，不代表其他平台的官方分类或审核标准。</p>
            </div>

            <aside className={styles.rail} aria-label="创作提示">
              <div className={styles.hero}><div className={styles.heroCopy}><span>让创作从一个灵感开始</span><h2>好故事<br />点亮更多生活</h2><p>让灵感有方向，让表达被看见</p></div><div className={styles.heroArt}><CategoryHeroArtwork /></div><p className={styles.heroSign}>每一个故事<br />都有发光的可能</p></div>
              <section className={styles.rules}><h2><Icon name="script" />分类使用指南</h2><ol>{[
                ["一级分类只选择 1 个", "按故事的核心冲突选择主题，主分类不会因为场景变化而改变。"],
                ["二级标签支持多选", "根据内容特点选择相关标签，组合出属于你的故事表达。"],
                ["推荐选择 4–6 个标签", "优先覆盖背景、人物与情绪，不必把每一个细节都变成标签。"],
                ["区分题材与故事背景", "题材回答“故事讲什么”，背景回答“故事发生在哪里、何时”。"],
              ].map(([title, body], index) => <li key={title}><span>{index + 1}</span><div><h3>{title}</h3><p>{body}</p></div></li>)}</ol><blockquote><span aria-hidden="true">“</span>分类是秩序的开始，<br />也是好故事被发现的起点。<footer>— 红果创作</footer></blockquote></section>
              <div className={styles.tip}><span aria-hidden="true">✦</span><p><strong>先确定主线，再丰富细节</strong>不必一次选得完美。创作过程中，你随时可以回来调整方向。</p></div>
            </aside>
          </div>
        </div>
      </main>
      {detail ? <div className={styles.modalBackdrop}><div className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="category-detail-title"><button ref={closeRef} type="button" className={styles.closeButton} aria-label="关闭分类详情" onClick={closeDetail}><Icon name="close" /></button><div className={styles.modalArt}><CategoryArtwork id={detail.id} /></div><span className={styles.eyebrow}>探索一种故事可能</span><h2 id="category-detail-title">{detail.name}</h2><p className={styles.modalDescription}>{detail.description}</p><div className={styles.inspiration}><strong>从这个问题开始</strong><p>{detail.prompt}</p></div><h3>可以搭配的标签</h3><div className={styles.recommendations}>{detail.recommended.map((id) => <span key={id}>{TAGS.find((tag) => tag.id === id)?.name}</span>)}</div><p className={styles.modalNote}>选为题材会替换当前主分类，已有标签保持不变。</p><button disabled={!ready} type="button" className={`ui-button ui-button-primary ${styles.primaryButton}`} onClick={() => { remember({ ...draft, categoryId: detail.id }); closeDetail(); }}>选为我的题材<Icon name="arrow" /></button></div></div> : null}
    </div>
  );
}
