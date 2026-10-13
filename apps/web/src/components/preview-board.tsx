"use client";

import { useState } from "react";
import { CreatorShell } from "./creator-shell";

const STAGES = ["故事", "角色", "分镜", "成片"] as const;
type Stage = (typeof STAGES)[number];

const STORY = {
  title: "夜班便利店",
  logline: "实习店员把最后一盒临期饭团让给了赶末班车的人。",
  scene: "雨夜，柜台只剩下一盏灯。小林把饭团推过去，没有问名字。",
};

const CHARACTERS = [
  { name: "小林", summary: "夜班店员，话少，记得每个常客的热饮。" },
  { name: "乘客", summary: "赶末班车的人，外套还在滴水。" },
];

const SHOTS = [
  { ordinal: 1, title: "柜台", action: "小林把饭团推过柜台。" },
  { ordinal: 2, title: "门外", action: "乘客停了一下，转身跑向车站。" },
];

export function PreviewBoard() {
  const [stage, setStage] = useState<Stage>("故事");
  return (
    <CreatorShell activePath="/preview">
      <main className="creator-page secondary-page">
        <header className="creator-page-heading secondary-page-heading">
          <div>
            <p className="secondary-eyebrow">先熟悉，再创作</p>
            <h1>界面示例</h1>
            <p className="secondary-description">跟着一个小故事，看看人物、分镜和成片如何连接起来。</p>
          </div>
          <a className="ui-button ui-button-primary" href="/create">开始自己的作品</a>
        </header>
        <p className="ui-notice secondary-preview-note" role="status">
          界面预览 · 示例内容 · 不会真实生成
        </p>
        <section className="secondary-preview-intro">
          <div className="secondary-preview-intro-mark" aria-hidden="true">夜</div>
          <div>
            <span className="secondary-kicker">示例作品 · 生活片段</span>
            <h2>{STORY.title}</h2>
            <p>{STORY.logline}</p>
          </div>
        </section>
        <div className="secondary-tabs" role="tablist" aria-label="预览环节">
          {STAGES.map((item, index) => (
            <button
              key={item}
              id={`preview-tab-${index}`}
              aria-controls="preview-content"
              className="secondary-tab"
              type="button"
              role="tab"
              aria-selected={stage === item}
              tabIndex={stage === item ? 0 : -1}
              onClick={() => setStage(item)}
              onKeyDown={(event) => {
                const next = event.key === "ArrowRight" ? (index + 1) % STAGES.length
                  : event.key === "ArrowLeft" ? (index + STAGES.length - 1) % STAGES.length
                    : event.key === "Home" ? 0
                      : event.key === "End" ? STAGES.length - 1 : null;
                if (next === null) return;
                const nextStage = STAGES[next];
                if (!nextStage) return;
                event.preventDefault();
                setStage(nextStage);
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
              }}
            >
              <span aria-hidden="true">0{index + 1}</span>{item}
            </button>
          ))}
        </div>
        <div className="secondary-preview-grid">
          <section
            id="preview-content"
            className="ui-card secondary-preview-content"
            role="tabpanel"
            aria-labelledby={`preview-tab-${STAGES.indexOf(stage)}`}
            aria-live="polite"
          >
            <div className="secondary-preview-panel-heading"><span>创作内容</span><span>示例 / 0{STAGES.indexOf(stage) + 1}</span></div>
            {stage === "故事" ? (
              <>
                <p className="secondary-kicker">从一个有温度的瞬间开始</p>
                <h2>故事</h2>
                <p className="secondary-story-text">{STORY.scene}</p>
                <div className="secondary-detail-note">先写清人物想做什么、遇到了什么，再把故事拆成画面。</div>
              </>
            ) : null}
            {stage === "角色" ? (
              <>
                <p className="secondary-kicker">让每个人物都有自己的特点</p>
                <h2>角色</h2>
                <ul className="secondary-example-list">
                  {CHARACTERS.map((character, index) => (
                    <li key={character.name}>
                      <span className="secondary-item-number" aria-hidden="true">0{index + 1}</span>
                      <div><h3>{character.name}</h3><p>{character.summary}</p></div>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {stage === "分镜" ? (
              <>
                <p className="secondary-kicker">把情节变成能看见的画面</p>
                <h2>分镜</h2>
                <ol className="secondary-example-list">
                  {SHOTS.map((shot) => (
                    <li key={shot.ordinal}>
                      <span className="secondary-item-number" aria-hidden="true">0{shot.ordinal}</span>
                      <div><h3>{shot.title}</h3><p>{shot.action}</p></div>
                    </li>
                  ))}
                </ol>
              </>
            ) : null}
            {stage === "成片" ? (
              <>
                <p className="secondary-kicker">确认画面后，查看成片</p>
                <h2>成片布局</h2>
                <p className="secondary-body-text">这里只展示竖屏成片会放在哪里。没有生成结果，没有账户余额，也没有支付状态。</p>
                <p className="secondary-detail-note">历史成片和当前可用成片会在正式工作台里分开列出。这个示例不提供其中任何一条。</p>
              </>
            ) : null}
          </section>
          <aside className="ui-card secondary-preview-aside" aria-label="9:16 预览">
            <div className="secondary-aside-heading"><h2>画面位置</h2><span>9:16</span></div>
            <div className="secondary-poster">
              <span className="secondary-poster-mark" aria-hidden="true">夜</span>
              <div className="secondary-poster-copy"><p>示例画面</p><h3>{stage === "成片" ? "成片位置" : stage}</h3><span>夜班便利店</span></div>
            </div>
            <p className="secondary-caption">示意布局，无生成媒体</p>
          </aside>
        </div>
      </main>
    </CreatorShell>
  );
}
