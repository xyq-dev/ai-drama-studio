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
      <main className="creator-page secondary-page secondary-home-grid">
        <div>
          <header className="creator-page-heading">
            <p className="secondary-eyebrow">开发预览 · 还不能公开商业运营</p>
            <h1>把故事，做成短剧</h1>
            <p className="secondary-description">红果创作给独立创作者一条看得见的路径：知道自己正在写什么，下一步该打开哪一集，以及任务结果和失败原因放在哪里。</p>
          </header>
          <ol className="secondary-home-steps">
            {STEPS.map((step, index) => (
              <li key={step.title} className="ui-card">
                <span className="secondary-item-number" aria-hidden="true">0{index + 1}</span>
                <h2>{step.title}</h2>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
          <div className="secondary-actions">
            <a className="ui-button ui-button-primary" href="/studio">进入创作中心</a>
            <a className="ui-button ui-button-secondary" href="/preview">查看界面示例</a>
          </div>
        </div>
        <aside className="ui-card secondary-preview-aside" aria-label="竖屏示例">
          <div className="secondary-aside-heading"><h2>成片位置</h2><span>9:16</span></div>
          <div className="secondary-poster">
            <span className="secondary-poster-mark" aria-hidden="true">夜</span>
            <div className="secondary-poster-copy"><p>示例画面 · 不会生成</p><h3>夜班便利店</h3><span>最后一盒饭团</span></div>
          </div>
        </aside>
      </main>
    </CreatorShell>
  );
}
