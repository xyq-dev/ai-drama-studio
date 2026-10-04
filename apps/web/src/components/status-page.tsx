import type { StatusView } from "../lib/load-status";

export function StatusPage({ view }: { view: StatusView }) {
  return (
    <main className="mx-auto max-w-xl bg-[#0B0E14] px-6 py-10 text-[#F4F6FA]">
      <h1 className="text-2xl font-semibold">服务状态</h1>
      <p className="mt-2 text-sm text-[#AAB3C5]">
        <a className="underline" href="/">返回首页</a>
        <span> · </span>
        <a className="underline" href="/studio">创作中心</a>
      </p>
      <dl className="mt-6 space-y-3">
        <div>
          <dt className="text-sm text-neutral-500">当前环境</dt>
          <dd>{view.environment}</dd>
        </div>
        <div>
          <dt className="text-sm text-neutral-500">Web</dt>
          <dd>{view.webStatus}</dd>
        </div>
        <div>
          <dt className="text-sm text-neutral-500">Core API</dt>
          <dd>{view.apiStatus}</dd>
        </div>
        <div>
          <dt className="text-sm text-neutral-500">PostgreSQL</dt>
          <dd>{view.postgres}</dd>
        </div>
        <div>
          <dt className="text-sm text-neutral-500">Redis</dt>
          <dd>{view.redis}</dd>
        </div>
        <div>
          <dt className="text-sm text-neutral-500">MinIO</dt>
          <dd>{view.objectStorage}</dd>
        </div>
        <div>
          <dt className="text-sm text-neutral-500">最后检查时间</dt>
          <dd>{view.checkedAt}</dd>
        </div>
      </dl>
    </main>
  );
}
