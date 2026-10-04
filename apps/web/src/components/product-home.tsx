import { CreatorShell } from "./creator-shell";

const STEPS = [
  { title: "剧本", text: "先写下故事和分集台词，确认这一集在讲什么。" },
  { title: "分镜", text: "把剧本拆成场景和镜头，看清每个画面的动作。" },
  { title: "素材", text: "为镜头准备画面、声音和字幕。当前素材仍是演示输出。" },
  { title: "成片", text: "把镜头合成为 9:16 竖屏成片，并区分历史版本和当前可用版本。" },
] as const;

export function ProductHome() {
  return (
    <CreatorShell>
      <main className="mx-auto grid max-w-6xl gap-8 px-4 py-10 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div>
          <p className="text-sm text-[#AAB3C5]">开发预览 · 还不能公开商业运营</p>
          <h1 className="mt-3 text-4xl font-semibold">把故事，做成短剧</h1>
          <p className="mt-4 max-w-2xl text-[#AAB3C5]">
            AI Drama Studio 给独立创作者一条看得见的路径：知道自己正在写什么，下一步该打开哪一集，以及任务结果和失败原因放在哪里。
          </p>
          <ol className="mt-8 grid gap-3 sm:grid-cols-2">
            {STEPS.map((step, index) => (
              <li key={step.title} className="rounded-lg border border-[#283140] bg-[#141A23] p-4">
                <p className="text-sm text-[#9B8CFF]">0{index + 1}</p>
                <h2 className="mt-1 font-medium">{step.title}</h2>
                <p className="mt-2 text-sm text-[#AAB3C5]">{step.text}</p>
              </li>
            ))}
          </ol>
          <div className="mt-8 flex flex-wrap gap-3">
            <a className="rounded bg-[#9B8CFF] px-4 py-2 text-[#0B0E14]" href="/studio">进入创作中心</a>
            <a className="rounded border border-[#283140] px-4 py-2" href="/preview">查看界面示例</a>
          </div>
        </div>
        <aside className="justify-self-center" aria-label="竖屏示例">
          <p className="mb-2 text-center text-sm text-[#AAB3C5]">9:16 成片位置</p>
          <div className="flex aspect-[9/16] w-56 flex-col justify-end rounded-lg border border-[#283140] bg-[#141A23] p-4">
            <p className="text-xs text-[#AAB3C5]">示例画面 · 不会生成</p>
            <p className="mt-2 text-lg font-medium">夜班便利店</p>
            <p className="text-sm text-[#AAB3C5]">最后一盒饭团</p>
          </div>
        </aside>
      </main>
    </CreatorShell>
  );
}
