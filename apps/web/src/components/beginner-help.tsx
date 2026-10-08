import { BeginnerShell } from "./beginner-shell";

const ITEMS: ReadonlyArray<{ q: string; a: string }> = [
  { q: "我不会写剧本，能用吗？", a: "可以。先在「开始创作」写一句你想拍的故事。之后每一步都会说明在做什么、要你决定什么。故事和剧本可以自己写，也可以用编剧助手准备要求，把 AI 给出的候选导入、比较后再采纳。" },
  { q: "现在能做多长的作品？", a: "试制范围固定为三集、竖屏 9:16。集数和时长目前不能选择。" },
  { q: "画面是 AI 拍的吗？", a: "不是。当前图片、视频、配音、字幕和音乐都是演示素材，演示视频约 1 秒，用来走通流程，不代表真实 AI 拍摄效果。" },
  { q: "「已保存」和「草稿」有什么区别？", a: "「服务器已保存」表示内容已经成为一个新版本。「本标签页草稿」只保存在当前浏览器标签页，关闭浏览器或换设备后不保证能恢复。" },
  { q: "为什么要我确认每一步？", a: "确认（审核）只针对你当前看到的那一个版本。上游内容改了以后，下游已确认的内容会标为「来源已更新」，需要重新检查。历史审核记录会保留。" },
  { q: "站内千问为什么不能用？", a: "站内调用默认关闭，需要服务端配置和操作者令牌。没开启时，可以复制创作指令到外部 AI，再把结果导入编剧助手。" },
  { q: "要花多少钱？", a: "页面只显示已经记录的费用，实际、估算和未知分开列出。当前没有报价、余额或预算限额功能。" },
];

export function BeginnerHelp() {
  return (
    <BeginnerShell active="/help">
      <main className="creator-page secondary-page">
        <header className="creator-page-heading secondary-page-heading">
          <div>
            <p className="secondary-eyebrow">陪你完成第一部作品</p>
            <h1>帮助</h1>
            <p className="secondary-description">第一次做短剧？从一句想法开始，每一步都有清楚的下一步。</p>
          </div>
          <a className="ui-button ui-button-primary" href="/create">开始创作</a>
        </header>
        <div className="secondary-help-grid">
          <section aria-labelledby="help-questions-title">
            <h2 id="help-questions-title" className="secondary-section-title">常见问题</h2>
            <div className="secondary-faq-list">
              {ITEMS.map((item) => (
                <details key={item.q} className="ui-card secondary-faq">
                  <summary>{item.q}</summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </section>
          <aside className="ui-card secondary-help-aside">
            <span className="secondary-item-number" aria-hidden="true">?</span>
            <h2>不知道下一步做什么？</h2>
            <p>回到「我的作品」，继续上次的进度。需要先熟悉流程，可以打开界面示例。</p>
            <a className="ui-button ui-button-secondary" href="/studio">我的作品</a>
            <a className="secondary-text-link" href="/preview">先看看界面示例 →</a>
            <div className="secondary-help-service">
              <h3>页面没有正常加载？</h3>
              <p>先检查网络，再查看服务是否在线。</p>
              <a className="secondary-text-link" href="/status">服务状态 →</a>
            </div>
          </aside>
        </div>
      </main>
    </BeginnerShell>
  );
}
