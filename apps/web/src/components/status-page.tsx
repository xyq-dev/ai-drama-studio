import type { StatusView } from "../lib/load-status";

export function StatusPage({ view }: { view: StatusView }) {
  const services = [
    { name: "Web", description: "创作页面", value: view.webStatus },
    { name: "Core API", description: "作品与创作操作", value: view.apiStatus },
    { name: "PostgreSQL", description: "作品数据", value: view.postgres },
    { name: "Redis", description: "任务队列连接", value: view.redis },
    { name: "MinIO", description: "对象存储连接", value: view.objectStorage },
  ];
  return (
    <main className="creator-page secondary-page">
      <header className="creator-page-heading secondary-page-heading">
        <div>
          <p className="secondary-eyebrow">帮助与支持</p>
          <h1>服务状态</h1>
          <p className="secondary-description">查看当前连接状态。生成任务的进度请回到作品中查看。</p>
        </div>
        <a className="ui-button ui-button-secondary" href="/studio">我的作品</a>
      </header>
      <section className="ui-card secondary-status-card" aria-label="服务检查结果">
        <div className="secondary-section-heading"><h2>连接检查</h2><a href="/">返回首页</a></div>
        <dl className="secondary-status-list">
          <div><dt><span>当前环境</span></dt><dd>{view.environment}</dd></div>
          {services.map((service) => (
            <div key={service.name}>
              <dt><span>{service.name}</span><small>{service.description}</small></dt>
              <dd>{service.value}</dd>
            </div>
          ))}
          <div><dt><span>最后检查时间</span></dt><dd>{view.checkedAt}</dd></div>
        </dl>
      </section>
      <p className="ui-notice secondary-status-note">这里只显示服务检查结果，不表示素材已生成或作品已完成。</p>
    </main>
  );
}
