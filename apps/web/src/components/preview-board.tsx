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
    <CreatorShell>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <p className="rounded-lg border border-[#283140] bg-[#141A23] px-4 py-3 text-sm" role="status">
          界面预览 · 示例内容 · 不会真实生成
        </p>
        <h1 className="mt-6 text-3xl font-semibold">{STORY.title}</h1>
        <p className="mt-2 text-[#AAB3C5]">{STORY.logline}</p>
        <div className="mt-6 flex flex-wrap gap-2" role="tablist" aria-label="预览环节">
          {STAGES.map((item) => (
            <button
              key={item}
              className={`rounded border px-3 py-1 text-sm ${stage === item ? "border-[#9B8CFF] text-[#F4F6FA]" : "border-[#283140] text-[#AAB3C5]"}`}
              type="button"
              role="tab"
              aria-selected={stage === item}
              onClick={() => setStage(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <section className="rounded-lg border border-[#283140] bg-[#141A23] p-4" aria-live="polite">
            {stage === "故事" ? (
              <>
                <h2 className="font-medium">故事</h2>
                <p className="mt-3 text-sm">{STORY.scene}</p>
              </>
            ) : null}
            {stage === "角色" ? (
              <>
                <h2 className="font-medium">角色</h2>
                <ul className="mt-3 space-y-3">
                  {CHARACTERS.map((character) => (
                    <li key={character.name}>
                      <p className="font-medium">{character.name}</p>
                      <p className="text-sm text-[#AAB3C5]">{character.summary}</p>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {stage === "分镜" ? (
              <>
                <h2 className="font-medium">分镜</h2>
                <ol className="mt-3 space-y-3">
                  {SHOTS.map((shot) => (
                    <li key={shot.ordinal}>
                      <p className="font-medium">{shot.ordinal}. {shot.title}</p>
                      <p className="text-sm text-[#AAB3C5]">{shot.action}</p>
                    </li>
                  ))}
                </ol>
              </>
            ) : null}
            {stage === "成片" ? (
              <>
                <h2 className="font-medium">成片布局</h2>
                <p className="mt-3 text-sm text-[#AAB3C5]">这里只展示竖屏成片会放在哪里。没有生成结果，没有账户余额，也没有支付状态。</p>
                <p className="mt-3 text-sm">历史成片和当前可用成片会在正式工作台里分开列出。这个示例不提供其中任何一条。</p>
              </>
            ) : null}
          </section>
          <aside aria-label="9:16 预览">
            <p className="mb-2 text-sm text-[#AAB3C5]">9:16</p>
            <div className="flex aspect-[9/16] flex-col justify-end rounded-lg border border-[#283140] bg-[#141A23] p-4">
              <p className="text-xs text-[#AAB3C5]">示例画面</p>
              <p className="mt-2 font-medium">{stage === "成片" ? "成片位置" : stage}</p>
            </div>
          </aside>
        </div>
      </main>
    </CreatorShell>
  );
}
