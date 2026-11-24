"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useModalKeyboard } from "../lib/modal-keyboard";
import { useOperatorGate, type AdminGate } from "./admin-access";
import { withSession } from "../lib/site-session";
import { AdminWorkManagement, type WorkItem } from "./admin-work-management";
import { formatShanghai } from "../lib/admin-directory-date";
import styles from "./admin-directory.module.css";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Kind = "works" | "assets" | "jobs" | "users" | "logs";
type Phase = "loading" | "ready" | "empty" | "failed";

interface AssetItem {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  projectTitle: string;
  updatedAt: string;
  sourceTask: string;
  contentHref: string;
}
interface JobItem {
  id: string;
  code: string;
  typeLabel: string;
  subject: string;
  updatedAt: string;
  status: string;
  statusLabel: string;
  action: "retry" | "view";
}
interface UserItem {
  id: string;
  displayName: string;
  username: string;
  role: string;
  roleLabel: string;
  status: string;
  statusLabel: string;
  activityAt: string | null;
  activitySource: string;
  mutable: boolean;
}
interface LogItem {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  result: "success" | "failed";
  secretStatus: string | null;
  secretMask: string | null;
  source: string;
  detail: string;
}

const COPY: Record<Kind, {
  title: string;
  summary: string;
  emptyTitle: string;
  emptyBody: string;
  loadingTitle: string;
  loadingBody: string;
  deniedTitle: string;
  deniedBody: string;
  failedTitle: string;
  failedBody: string;
  footnote: string;
  search: string;
  count: (total: number) => string;
  time: "full" | "short";
}> = {
  works: {
    title: "作品管理",
    summary: "",
    emptyTitle: "还没有作品",
    emptyBody: "当前没有可供运营核对的作品。创作者在工作台创建后，会显示在此列表。运营不会在此创建或发布作品。",
    loadingTitle: "正在加载作品列表",
    loadingBody: "正在读取全部创作者的作品与制作状态，请稍候。本次不会改动任何作品。",
    deniedTitle: "没有作品管理权限",
    deniedBody: "作品总览仅平台管理员可查看。普通创作者请返回创作工作台，只能看到自己的作品。",
    failedTitle: "作品列表加载失败",
    failedBody: "暂时无法读取作品数据，请重试。本次不会改动任何作品。",
    footnote: "",
    search: "搜索作品或创作者",
    count: (total) => `${total} 部作品`,
    time: "full",
  },
  assets: {
    title: "素材库",
    summary: "按类型和作品查看生产过程中的分镜图、音频和视频，便于运营核对预览。上传原始素材不是后台的主要工作。",
    emptyTitle: "还没有可预览素材",
    emptyBody: "当前没有可供核对的分镜图、配音或成片。素材来自制作任务产出，运营不会在此上传原始文件。",
    loadingTitle: "正在加载素材库",
    loadingBody: "正在读取制作任务产出的分镜图、音频和视频，请稍候。本次不会上传或发布。",
    deniedTitle: "没有素材库权限",
    deniedBody: "素材预览仅平台管理员可查看。普通创作者请返回创作工作台。",
    failedTitle: "素材库加载失败",
    failedBody: "暂时无法读取素材数据，请重试。本次不会上传或发布素材。",
    footnote: "素材来自制作任务产出，不在此页上传原始文件。",
    search: "搜索素材名称",
    count: (total) => `${total} 项素材`,
    time: "short",
  },
  jobs: {
    title: "生成任务",
    summary: "查看编剧、分镜、配音和视频生成队列，定位所属作品与分集。失败或结果未知的任务不会自动重试计费调用。",
    emptyTitle: "还没有生成任务",
    emptyBody: "当前没有编剧、分镜、配音或视频任务。失败或结果未知的任务不会自动重试。",
    loadingTitle: "正在加载生成任务",
    loadingBody: "正在读取任务队列，请稍候。本次不会向服务商发起调用。",
    deniedTitle: "没有生成任务权限",
    deniedBody: "任务队列仅平台管理员可查看。普通创作者请返回创作工作台。",
    failedTitle: "生成任务加载失败",
    failedBody: "暂时无法读取任务数据，请重试。本次不会向服务商发起调用。",
    footnote: "重试需管理员明确确认，可能产生费用。失败或结果未知的任务不会自动重新发起调用。",
    search: "搜索任务 ID",
    count: (total) => `${total} 条任务`,
    time: "short",
  },
  users: {
    title: "用户与权限",
    summary: "管理平台管理员与创作者账号。公开注册保持关闭；管理员可为验收或制作需要创建创作者账号。创作者不能进入 /admin。",
    emptyTitle: "还没有账号",
    emptyBody: "公开注册保持关闭。管理员可以创建创作者账号，对方只能进入 /studio。",
    loadingTitle: "正在加载用户与权限",
    loadingBody: "正在读取平台管理员与创作者账号，请稍候。本次不会创建账号。",
    deniedTitle: "没有用户管理权限",
    deniedBody: "账号管理仅平台管理员可查看。普通创作者请返回创作工作台，不能进入 /admin。",
    failedTitle: "用户列表加载失败",
    failedBody: "暂时无法读取账号数据，请重试。本次不会创建或停用账号。",
    footnote: "角色仅区分平台管理员与创作者，不设多租户工作空间。公开注册保持关闭。",
    search: "搜索用户",
    count: (total) => `${total} 个账号`,
    time: "full",
  },
  logs: {
    title: "操作日志",
    summary: "追踪管理员登录、配置变更、密钥保存或清除（仅显示掩码状态）以及角色变更。日志中不展示密钥明文。",
    emptyTitle: "还没有操作记录",
    emptyBody: "当前没有可展示的审计记录。新的登录、配置和确认操作会记在这里，不会补写历史。",
    loadingTitle: "正在加载操作日志",
    loadingBody: "正在读取审计记录，请稍候。日志中不会出现密钥明文。",
    deniedTitle: "没有操作日志权限",
    deniedBody: "审计记录仅平台管理员可查看。普通创作者请返回创作工作台。",
    failedTitle: "操作日志加载失败",
    failedBody: "暂时无法读取审计记录，请重试。完整密钥不会出现在列表或详情中。",
    footnote: "密钥仅显示已保存或已清除，以及掩码后缀。完整密钥不会出现在列表或详情中。",
    search: "搜索操作或对象",
    count: (total) => `${total} 条记录`,
    time: "full",
  },
};

const ASSET_TYPES = [["all", "全部类型"], ["image", "分镜图"], ["voice", "角色配音"], ["video", "成片视频"]];
const JOB_TYPES = [
  ["all", "全部类型"], ["writing", "剧本编写"], ["scene", "场景生成"], ["shot", "镜头生成"],
  ["image", "分镜生图"], ["video", "视频生成"], ["voice", "角色配音"], ["subtitle", "字幕生成"],
  ["music", "音乐生成"], ["shot_compose", "单镜合成"], ["episode_compose", "集级合成"],
];
const JOB_STATUS = [["all", "全部状态"], ["succeeded", "成功"], ["running", "进行中"], ["failed", "失败"], ["unknown", "结果未知"], ["canceled", "已取消"], ["queued", "排队中"]];

export function AdminDirectory({ kind, fetchImpl }: { kind: Kind; fetchImpl?: FetchLike }) {
  const copy = COPY[kind];
  const fetchRef = useRef(fetchImpl);
  fetchRef.current = fetchImpl;
  const impl = useCallback((input: string, init?: RequestInit) => {
    const next = fetchRef.current ?? globalThis.fetch.bind(globalThis);
    return next(input, init);
  }, []);
  const { gate, reload } = useOperatorGate(impl);
  const [wide, setWide] = useState(true);
  const [phase, setPhase] = useState<Phase>("loading");
  const [items, setItems] = useState<Array<AssetItem | JobItem | UserItem | LogItem>>([]);
  const [total, setTotal] = useState(0);
  const [projects, setProjects] = useState<Array<{ id: string; title: string }>>([]);
  const [actors, setActors] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [owner, setOwner] = useState("all");
  const [type, setType] = useState("all");
  const [role, setRole] = useState("all");
  const [range, setRange] = useState("7d");
  const [listEpoch, setListEpoch] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ filters: string; value: string | null }>({ filters: "", value: null });
  const [notice, setNotice] = useState("");
  const [work, setWork] = useState<WorkItem | null>(null);
  const [asset, setAsset] = useState<AssetItem | null>(null);
  const [jobView, setJobView] = useState<JobItem | null>(null);
  const [retryJob, setRetryJob] = useState<JobItem | null>(null);
  const [retryKey, setRetryKey] = useState("");
  const [retryError, setRetryError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [user, setUser] = useState<UserItem | null>(null);
  const [log, setLog] = useState<LogItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [statusTarget, setStatusTarget] = useState<UserItem | null>(null);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(min-width: 1024px)");
    const sync = () => setWide(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const filters = [kind, q, status, owner, type, role, range].join("\0");
  const requestCursor = cursor.filters === filters ? cursor.value : null;

  useEffect(() => {
    if (gate !== "ready" || kind === "works") return;
    let live = true;
    setPhase("loading");
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (kind === "assets" && type !== "all") params.set("type", type);
    if (kind === "assets" && owner !== "all") params.set("project", owner);
    if (kind === "jobs" && type !== "all") params.set("type", type);
    if (kind === "jobs" && status !== "all") params.set("status", status);
    if (kind === "users" && role !== "all") params.set("role", role);
    if (kind === "users" && status !== "all") params.set("status", status);
    if (kind === "logs" && owner !== "all") params.set("actor", owner);
    if (kind === "logs") params.set("range", range);
    const appending = Boolean(requestCursor);
    if (appending && requestCursor) params.set("cursor", requestCursor);
    const query = params.toString();
    impl(`/api/v1/admin/${kind}${query ? `?${query}` : ""}`, { headers: { Accept: "application/json" }, credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!live) return;
        if (!response.ok) {
          setPhase("failed");
          return;
        }
        const body = await response.json() as {
          items?: Array<AssetItem | JobItem | UserItem | LogItem>;
          total?: number;
          nextCursor?: string | null;
          projects?: Array<{ id: string; title: string }>;
          actors?: string[];
          storage?: string;
        };
        if (kind === "logs" && body.storage === "unconfigured") {
          setPhase("failed");
          return;
        }
        const next = body.items ?? [];
        setNextCursor(typeof body.nextCursor === "string" && body.nextCursor ? body.nextCursor : null);
        setTotal(body.total ?? next.length);
        if (appending) {
          setItems((current) => [...current, ...next]);
          setPhase("ready");
          return;
        }
        setItems(next);
        setProjects(body.projects ?? []);
        setActors(body.actors ?? []);
        setPhase(next.length === 0 ? "empty" : "ready");
      })
      .catch(() => { if (live) setPhase("failed"); });
    return () => { live = false; };
  }, [filters, gate, impl, kind, listEpoch, owner, q, range, requestCursor, role, status, type]);

  function openRetry(item: JobItem) {
    setRetryError("");
    setRetryKey(globalThis.crypto?.randomUUID?.() ?? `retry-${item.id}`);
    setRetryJob(item);
  }

  async function confirmRetry() {
    if (!retryJob || retrying) return;
    setRetrying(true);
    setRetryError("");
    try {
      const response = await withSession(impl)(`/api/v1/admin/jobs/${retryJob.id}/retry`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": retryKey,
        },
        body: JSON.stringify({ confirmed: true }),
      });
      const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
      if (!response.ok) {
        setRetryError(body.error?.message ?? "这次没有向服务商发起调用。");
        return;
      }
      setRetryJob(null);
      setNotice("已确认重试。只有这次确认会再次向服务商发起调用。");
      setListEpoch((value) => value + 1);
    } catch {
      setRetryError("这次没有向服务商发起调用。");
    } finally {
      setRetrying(false);
    }
  }

  if (kind === "works") {
    return <div className={styles.page} data-page="works" data-layout={wide ? "table" : "cards"}>
      <header className={styles.intro}><h1>作品管理</h1></header>
      {gate === "ready" ? <AdminWorkManagement wide={wide} fetchImpl={impl} onWork={setWork} />
        : <StateCard gate={gate} copy={copy} onRetry={reload} />}
      {work && gate === "ready" ? <WorkDrawer item={work} onClose={() => setWork(null)} /> : null}
    </div>;
  }

  const filtering = Boolean(q.trim() || status !== "all" || owner !== "all" || type !== "all" || role !== "all" || (kind === "logs" && range !== "7d"));
  const showToolbar = gate === "ready";
  const showList = gate === "ready" && (phase === "ready" || (phase === "loading" && items.length > 0) || (phase === "empty" && filtering));
  const showEmpty = gate === "ready" && phase === "empty" && !filtering;

  return (
    <div className={styles.page} data-page={kind} data-layout={wide ? "table" : "cards"}>
      <header className={styles.intro}>
        <div>
          <h1>{copy.title}</h1>
          <p>{copy.summary}</p>
        </div>
        {kind === "users" && gate === "ready" ? (
          <button type="button" className={styles.primary} onClick={() => setCreating(true)}>创建创作者账号</button>
        ) : null}
      </header>
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
      {gate !== "ready" ? <StateCard gate={gate} copy={copy} onRetry={reload} /> : null}
      {showToolbar ? (
        <form className={styles.toolbar} role="search" onSubmit={(event) => event.preventDefault()}>
          <label className={styles.search}>
            <img src="/design/tailadmin-v2/icon-search.svg" width={18} height={18} alt="" />
            <input value={q} placeholder={copy.search} aria-label={copy.search} onChange={(event) => setQ(event.target.value)} />
          </label>
          <div className={styles.filters}>
            <Filters kind={kind} status={status} setStatus={setStatus} owner={owner} setOwner={setOwner} type={type} setType={setType} role={role} setRole={setRole} range={range} setRange={setRange} projects={projects} actors={actors} />
          </div>
        </form>
      ) : null}
      {gate === "ready" && phase === "loading" && items.length === 0 ? <StateCard gate="loading" copy={copy} /> : null}
      {gate === "ready" && phase === "failed" ? <StateCard gate="failed" copy={copy} onRetry={() => setListEpoch((value) => value + 1)} /> : null}
      {showEmpty ? <StateCard gate="empty" copy={copy} /> : null}
      {showList ? (
        <>
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2>{kind === "assets" ? "可预览素材" : kind === "jobs" ? "任务队列" : kind === "users" ? "账号列表" : "审计记录"}</h2>
              <span>{copy.count(total)}</span>
            </div>
            {phase === "empty" ? <p className={styles.footnote}>没有符合当前筛选的记录。</p> : wide ? (
              <Table kind={kind} items={items} time={copy.time} onAsset={setAsset} onJob={setJobView} onRetry={openRetry} onUser={setUser} onLog={setLog} />
            ) : (
              <Cards kind={kind} items={items} time={copy.time} onAsset={setAsset} onJob={setJobView} onRetry={openRetry} onUser={setUser} onLog={setLog} />
            )}
            {nextCursor ? (
              <div className={styles.pager}>
                <button type="button" className={styles.secondary} disabled={phase === "loading"} onClick={() => setCursor({ filters, value: nextCursor })}>加载更多</button>
              </div>
            ) : null}
            <p className={styles.footnote}>{copy.footnote}</p>
          </section>
        </>
      ) : null}
      {asset ? <AssetDrawer item={asset} fetchImpl={impl} onClose={() => setAsset(null)} /> : null}
      {jobView ? <JobDrawer item={jobView} onClose={() => setJobView(null)} /> : null}
      {retryJob ? (
        <RetryDialog
          item={retryJob}
          busy={retrying}
          error={retryError}
          onCancel={() => { if (!retrying) setRetryJob(null); }}
          onConfirm={() => void confirmRetry()}
        />
      ) : null}
      {user ? <UserDrawer item={user} onClose={() => setUser(null)} onStatus={setStatusTarget} /> : null}
      {statusTarget ? (
        <StatusDialog
          item={statusTarget}
          fetchImpl={impl}
          onClose={() => setStatusTarget(null)}
          onDone={(message) => { setStatusTarget(null); setUser(null); setNotice(message); setListEpoch((value) => value + 1); }}
        />
      ) : null}
      {log ? <LogDrawer item={log} onClose={() => setLog(null)} /> : null}
      {creating ? (
        <CreateCreator
          fetchImpl={impl}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); setNotice("已创建创作者账号。密码已提交，不会显示在列表或日志中。"); setListEpoch((value) => value + 1); }}
        />
      ) : null}
    </div>
  );
}

function StateCard({ gate, copy, onRetry }: { gate: AdminGate | "empty"; copy: (typeof COPY)[Kind]; onRetry?: () => void }) {
  if (gate === "forbidden") {
    return (
      <section className={styles.state} data-state="forbidden">
        <img src="/design/tailadmin-v2/icon-lock.svg" width={28} height={28} alt="" />
        <h2>{copy.deniedTitle}</h2>
        <p>{copy.deniedBody}</p>
        <a className={styles.primary} href="/studio">返回创作中心</a>
      </section>
    );
  }
  if (gate === "loading") {
    return (
      <section className={styles.state} data-state="loading">
        <img src="/design/tailadmin-v2/icon-refresh.svg" width={28} height={28} alt="" />
        <h2>{copy.loadingTitle}</h2>
        <p>{copy.loadingBody}</p>
      </section>
    );
  }
  if (gate === "empty") {
    const icon = copy.title === "作品管理" ? "icon-clapperboard.svg" : copy.title === "素材库" ? "icon-images.svg" : copy.title === "生成任务" ? "icon-list-video.svg" : copy.title === "用户与权限" ? "icon-users-round.svg" : "icon-clipboard-list.svg";
    return (
      <section className={styles.state} data-state="empty">
        <img src={`/design/tailadmin-v2/${icon}`} width={28} height={28} alt="" />
        <h2>{copy.emptyTitle}</h2>
        <p>{copy.emptyBody}</p>
      </section>
    );
  }
  return (
    <section className={styles.state} data-state="failed">
      <img src="/design/tailadmin-v2/icon-circle-alert.svg" width={28} height={28} alt="" />
      <h2>{copy.failedTitle}</h2>
      <p>{copy.failedBody}</p>
      {onRetry ? <button type="button" className={styles.primary} onClick={onRetry}>重新加载</button> : null}
    </section>
  );
}

function Filters(props: {
  kind: Kind;
  status: string;
  setStatus: (value: string) => void;
  owner: string;
  setOwner: (value: string) => void;
  type: string;
  setType: (value: string) => void;
  role: string;
  setRole: (value: string) => void;
  range: string;
  setRange: (value: string) => void;
  projects: Array<{ id: string; title: string }>;
  actors: string[];
}) {
  if (props.kind === "assets") {
    return (
      <>
        <select className={styles.select} aria-label="素材类型" value={props.type} onChange={(event) => props.setType(event.target.value)}>
          {ASSET_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select className={styles.select} aria-label="所属作品" value={props.owner} onChange={(event) => props.setOwner(event.target.value)}>
          <option value="all">全部作品</option>
          {props.projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
        </select>
      </>
    );
  }
  if (props.kind === "jobs") {
    return (
      <>
        <select className={styles.select} aria-label="任务类型" value={props.type} onChange={(event) => props.setType(event.target.value)}>
          {JOB_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select className={styles.select} aria-label="任务状态" value={props.status} onChange={(event) => props.setStatus(event.target.value)}>
          {JOB_STATUS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </>
    );
  }
  if (props.kind === "users") {
    return (
      <>
        <select className={styles.select} aria-label="角色" value={props.role} onChange={(event) => props.setRole(event.target.value)}>
          <option value="all">全部角色</option>
          <option value="operator">平台管理员</option>
          <option value="creator">创作者</option>
        </select>
        <select className={styles.select} aria-label="账号状态" value={props.status} onChange={(event) => props.setStatus(event.target.value)}>
          <option value="all">全部状态</option>
          <option value="ACTIVE">已启用</option>
          <option value="DISABLED">已停用</option>
        </select>
      </>
    );
  }
  return (
    <>
      <select className={styles.select} aria-label="操作人" value={props.owner} onChange={(event) => props.setOwner(event.target.value)}>
        <option value="all">全部操作人</option>
        {props.actors.map((actor) => <option key={actor} value={actor}>{actor}</option>)}
      </select>
      <select className={styles.select} aria-label="时间范围" value={props.range} onChange={(event) => props.setRange(event.target.value)}>
        <option value="7d">最近 7 天</option>
        <option value="30d">最近 30 天</option>
        <option value="all">全部时间</option>
      </select>
    </>
  );
}

function tone(label: string): string {
  if (label === "已完结" || label === "成功" || label === "已启用" || label === "成片视频") return styles.green ?? "";
  if (label === "失败" || label === "结果未知") return styles.amber ?? "";
  if (label === "制作中" || label === "分镜中" || label === "进行中" || label === "分镜图" || label === "角色配音") return styles.blue ?? "";
  return styles.gray ?? "";
}

function Pill({ label }: { label: string }) {
  return <span className={`${styles.pill} ${tone(label)}`}>{label}</span>;
}

function Table({ kind, items, time, onAsset, onJob, onRetry, onUser, onLog }: RowHandlers & { kind: Kind; items: Array<AssetItem | JobItem | UserItem | LogItem>; time: "full" | "short" }) {
  if (kind === "assets") {
    const rows = items as AssetItem[];
    return (
      <table className={styles.table}>
        <thead><tr><th>素材名称</th><th>类型</th><th>所属作品</th><th>更新时间</th><th>类型标签</th><th>操作</th></tr></thead>
        <tbody>
          {rows.map((item) => (
            <tr key={item.id}>
              <td>{item.name}</td>
              <td>{item.typeLabel}</td>
              <td>{item.projectTitle}</td>
              <td>{formatShanghai(item.updatedAt, time)}</td>
              <td><Pill label={item.typeLabel} /></td>
              <td><button type="button" className={styles.linkish} onClick={() => onAsset(item)}>预览</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (kind === "jobs") {
    const rows = items as JobItem[];
    return (
      <table className={styles.table}>
        <thead><tr><th>任务</th><th>类型</th><th>作品 / 分集</th><th>更新时间</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          {rows.map((item) => (
            <tr key={item.id}>
              <td>{item.code}</td>
              <td>{item.typeLabel}</td>
              <td>{item.subject}</td>
              <td>{formatShanghai(item.updatedAt, time)}</td>
              <td><Pill label={item.statusLabel} /></td>
              <td>
                {item.action === "retry"
                  ? <button type="button" className={styles.linkish} onClick={() => onRetry(item)}>重试</button>
                  : <button type="button" className={styles.linkish} onClick={() => onJob(item)}>查看</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (kind === "users") {
    const rows = items as UserItem[];
    return (
      <table className={styles.table}>
        <thead><tr><th>用户</th><th>登录账号</th><th>角色</th><th>最近访问</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          {rows.map((item) => (
            <tr key={item.id}>
              <td>{item.displayName}</td>
              <td>{item.username}</td>
              <td>{item.roleLabel}</td>
              <td>{formatShanghai(item.activityAt, time)}</td>
              <td><Pill label={item.statusLabel} /></td>
              <td><button type="button" className={styles.linkish} onClick={() => onUser(item)}>查看</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  const rows = items as LogItem[];
  return (
    <table className={styles.table}>
      <thead><tr><th>时间</th><th>操作人</th><th>操作</th><th>对象</th><th>结果</th><th>操作</th></tr></thead>
      <tbody>
        {rows.map((item) => (
          <tr key={item.id}>
            <td>{formatShanghai(item.at, time)}</td>
            <td>{item.actor}</td>
            <td>{item.action}</td>
            <td>{item.target}</td>
            <td><Pill label={item.result === "success" ? "成功" : "失败"} /></td>
            <td><button type="button" className={styles.linkish} onClick={() => onLog(item)}>详情</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface RowHandlers {
  onAsset: (item: AssetItem) => void;
  onJob: (item: JobItem) => void;
  onRetry: (item: JobItem) => void;
  onUser: (item: UserItem) => void;
  onLog: (item: LogItem) => void;
}

function Cards({ kind, items, time, onAsset, onJob, onRetry, onUser, onLog }: RowHandlers & { kind: Kind; items: Array<AssetItem | JobItem | UserItem | LogItem>; time: "full" | "short" }) {
  if (kind === "assets") {
    return <div className={styles.cards}>{(items as AssetItem[]).map((item) => (
      <article className={styles.card} key={item.id}>
        <div className={styles.cardHead}><strong>{item.name}</strong><Pill label={item.typeLabel} /></div>
        <small>{item.projectTitle} · {formatShanghai(item.updatedAt, time)}</small>
        <button type="button" className={styles.linkish} onClick={() => onAsset(item)}>预览</button>
      </article>
    ))}</div>;
  }
  if (kind === "jobs") {
    return <div className={styles.cards}>{(items as JobItem[]).map((item) => (
      <article className={styles.card} key={item.id}>
        <div className={styles.cardHead}><strong>{item.code}</strong><Pill label={item.statusLabel} /></div>
        <small>{item.typeLabel} · {item.subject}</small>
        {item.action === "retry"
          ? <button type="button" className={styles.linkish} onClick={() => onRetry(item)}>重试</button>
          : <button type="button" className={styles.linkish} onClick={() => onJob(item)}>查看</button>}
      </article>
    ))}</div>;
  }
  if (kind === "users") {
    return <div className={styles.cards}>{(items as UserItem[]).map((item) => (
      <article className={styles.card} key={item.id}>
        <div className={styles.cardHead}><strong>{item.displayName}</strong><Pill label={item.statusLabel} /></div>
        <small>{item.username} · {item.roleLabel}</small>
        <button type="button" className={styles.linkish} onClick={() => onUser(item)}>查看</button>
      </article>
    ))}</div>;
  }
  return <div className={styles.cards}>{(items as LogItem[]).map((item) => (
    <article className={styles.card} key={item.id}>
      <div className={styles.cardHead}><strong>{item.action}</strong><Pill label={item.result === "success" ? "成功" : "失败"} /></div>
      <small>{item.actor} · {formatShanghai(item.at, time)}</small>
      <button type="button" className={styles.linkish} onClick={() => onLog(item)}>详情</button>
    </article>
  ))}</div>;
}

function DrawerFrame({ title, label, onClose, children }: { title: string; label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  useModalKeyboard(true, ref, onClose);
  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <aside ref={ref} className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-label={label}>
        <div className={styles.drawerHead}>
          <div>
            <p>{label}</p>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button type="button" className={styles.close} aria-label="关闭" onClick={onClose}>
            <img src="/design/tailadmin-v2/icon-x.svg" width={18} height={18} alt="" />
          </button>
        </div>
        {children}
      </aside>
    </>
  );
}

function WorkDrawer({ item, onClose }: { item: WorkItem; onClose: () => void }) {
  return (
    <DrawerFrame title={item.title} label="作品详情" onClose={onClose}>
      <Pill label={item.productionLabel} />
      <dl className={styles.meta}>
        <div><dt>所属创作者</dt><dd>{item.ownerLegacy ? "历史作品" : item.ownerName}</dd></div>
        <div><dt>更新时间</dt><dd>{formatShanghai(item.updatedAt, "full")}</dd></div>
        <div><dt>分集进度</dt><dd>{item.episodeProgress}</dd></div>
        <div><dt>最近任务</dt><dd>{item.recentTask}</dd></div>
      </dl>
      <p>打开后仅供运营核对制作进度与产出，不会发布到抖音或红果平台，也不会进入创作者工作台编辑。</p>
      <div className={styles.drawerActions}>
        <button type="button" className={styles.secondary} onClick={onClose}>关闭</button>
        <a className={styles.primary} href={item.reviewHref}>打开核对</a>
      </div>
    </DrawerFrame>
  );
}

const PREVIEW_ERROR = "暂时无法预览这份素材。";

async function previewFailureMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: unknown } };
    const message = body.error?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    // A non-JSON failure still gets the same preview sentence.
  }
  return PREVIEW_ERROR;
}

function revokePreviewUrl(url: string) {
  if (url.startsWith("blob:") && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}

function AssetDrawer({ item, fetchImpl, onClose }: { item: AssetItem; fetchImpl: FetchLike; onClose: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "placeholder">(item.type === "other" ? "placeholder" : "loading");
  const [src, setSrc] = useState("");
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    if (item.type === "other") return;
    let live = true;
    let objectUrl = "";
    setPhase("loading");
    setSrc("");
    setErrorText("");
    fetchImpl(item.contentHref, { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          const message = await previewFailureMessage(response);
          if (!live) return;
          setErrorText(message);
          setPhase("error");
          return;
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        if (!live) {
          revokePreviewUrl(url);
          return;
        }
        objectUrl = url;
        setSrc(url);
        setPhase("ready");
      })
      .catch(() => {
        if (!live) return;
        setErrorText(PREVIEW_ERROR);
        setPhase("error");
      });
    return () => {
      live = false;
      revokePreviewUrl(objectUrl);
    };
  }, [attempt, fetchImpl, item.contentHref, item.type]);

  function playbackFailed() {
    setErrorText(PREVIEW_ERROR);
    setPhase("error");
  }

  return (
    <DrawerFrame title={item.name} label="素材预览" onClose={onClose}>
      <div className={styles.preview} data-state={phase}>
        {phase === "loading" ? <span>正在加载预览</span> : null}
        {phase === "ready" && item.type === "image" ? <img src={src} alt="" onError={playbackFailed} /> : null}
        {phase === "ready" && item.type === "voice" ? <audio controls src={src} onError={playbackFailed} /> : null}
        {phase === "ready" && item.type === "video" ? <video controls src={src} onError={playbackFailed} /> : null}
        {phase === "error" ? (
          <div className={styles.previewError}>
            <p role="alert">{errorText}</p>
            <button type="button" className={styles.secondary} onClick={() => setAttempt((value) => value + 1)}>重新加载</button>
          </div>
        ) : null}
        {phase === "placeholder" ? <span>{item.typeLabel}预览</span> : null}
      </div>
      <dl className={styles.meta}>
        <div><dt>类型</dt><dd>{item.typeLabel}</dd></div>
        <div><dt>所属作品</dt><dd>{item.projectTitle}</dd></div>
        <div><dt>来源任务</dt><dd>{item.sourceTask}</dd></div>
        <div><dt>更新时间</dt><dd>{formatShanghai(item.updatedAt, "short")}</dd></div>
      </dl>
      <p>此页仅预览制作任务产出，不提供原始素材上传，也不支持对外发布。</p>
      <div className={styles.drawerActions}>
        <button type="button" className={styles.secondary} onClick={onClose}>关闭</button>
      </div>
    </DrawerFrame>
  );
}

function JobDrawer({ item, onClose }: { item: JobItem; onClose: () => void }) {
  return (
    <DrawerFrame title={item.code} label="任务详情" onClose={onClose}>
      <Pill label={item.statusLabel} />
      <dl className={styles.meta}>
        <div><dt>类型</dt><dd>{item.typeLabel}</dd></div>
        <div><dt>作品 / 分集</dt><dd>{item.subject}</dd></div>
        <div><dt>更新时间</dt><dd>{formatShanghai(item.updatedAt, "short")}</dd></div>
      </dl>
      <p>结果未知和未确认的失败任务不会自动向服务商重新发起调用。</p>
      <div className={styles.drawerActions}>
        <button type="button" className={styles.secondary} onClick={onClose}>关闭</button>
      </div>
    </DrawerFrame>
  );
}

function RetryDialog({ item, busy, error, onCancel, onConfirm }: { item: JobItem; busy: boolean; error: string; onCancel: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useModalKeyboard(true, ref, onCancel);
  return (
    <>
      <div className={styles.backdrop} onClick={onCancel} />
      <section ref={ref} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="retry-title">
        <div className={styles.dialogHead}>
          <h2 id="retry-title">确认重试该任务？</h2>
          <button type="button" className={styles.close} aria-label="关闭" onClick={onCancel}>
            <img src="/design/tailadmin-v2/icon-x.svg" width={18} height={18} alt="" />
          </button>
        </div>
        <p>任务 {item.code}（{item.typeLabel} · {item.subject}）上次结果为失败。确认后将再次向服务商发起调用，可能产生费用。失败或结果未知不会被自动重试。</p>
        {error ? <p role="alert">{error}</p> : null}
        <div className={styles.dialogActions}>
          <button type="button" className={styles.secondary} onClick={onCancel} disabled={busy}>取消</button>
          <button type="button" className={styles.danger} onClick={onConfirm} disabled={busy}>{busy ? "正在确认…" : "确认重试"}</button>
        </div>
      </section>
    </>
  );
}

function UserDrawer({ item, onClose, onStatus }: { item: UserItem; onClose: () => void; onStatus: (item: UserItem) => void }) {
  return (
    <DrawerFrame title={item.displayName} label="账号详情" onClose={onClose}>
      <dl className={styles.meta}>
        <div><dt>登录账号</dt><dd>{item.username}</dd></div>
        <div><dt>角色</dt><dd>{item.roleLabel}</dd></div>
        <div><dt>状态</dt><dd>{item.statusLabel}</dd></div>
        <div><dt>最近访问</dt><dd>{item.activityAt ? formatShanghai(item.activityAt, "full") : "—"}</dd></div>
      </dl>
      <p>{item.activitySource === "updated_at" ? "最近访问取自账号更新时间，不是精确的上次登录时间。" : "平台管理员来自站点登录配置，不能在此降级。"}创作者不能进入 /admin。</p>
      <div className={styles.drawerActions}>
        <button type="button" className={styles.secondary} onClick={onClose}>关闭</button>
        {item.mutable ? (
          <button type="button" className={styles.secondary} onClick={() => onStatus(item)}>{item.status === "DISABLED" ? "启用账号" : "停用账号"}</button>
        ) : null}
      </div>
    </DrawerFrame>
  );
}

function StatusDialog({ item, fetchImpl, onClose, onDone }: { item: UserItem; fetchImpl: FetchLike; onClose: () => void; onDone: (message: string) => void }) {
  const ref = useRef<HTMLElement>(null);
  const [error, setError] = useState("");
  const next = item.status === "DISABLED" ? "ACTIVE" : "DISABLED";
  useModalKeyboard(true, ref, onClose);
  async function confirm() {
    const response = await withSession(fetchImpl)(`/api/v1/admin/users/${item.id}/status`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true, status: next }),
    });
    if (!response.ok) {
      setError("没有调整账号状态。");
      return;
    }
    onDone(next === "DISABLED" ? "已停用该创作者。对方不能登录。" : "已启用该创作者。对方只能进入 /studio。");
  }
  return (
    <>
      <div className={styles.backdrop} />
      <section ref={ref} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="status-title">
        <h2 id="status-title">{next === "DISABLED" ? "确认停用该创作者？" : "确认启用该创作者？"}</h2>
        <p>账号 {item.username} 只会切换现有的启用或停用状态。不会新增角色、工作区或套餐。取消不会改动账号。</p>
        {error ? <p role="alert">{error}</p> : null}
        <div className={styles.dialogActions}>
          <button type="button" className={styles.secondary} onClick={onClose}>取消</button>
          <button type="button" className={styles.danger} onClick={() => void confirm()}>确认</button>
        </div>
      </section>
    </>
  );
}

function LogDrawer({ item, onClose }: { item: LogItem; onClose: () => void }) {
  return (
    <DrawerFrame title={item.action} label="日志详情" onClose={onClose}>
      <Pill label={item.result === "success" ? "成功" : "失败"} />
      <dl className={styles.meta}>
        <div><dt>时间</dt><dd>{formatShanghai(item.at, "full")}</dd></div>
        <div><dt>操作人</dt><dd>{item.actor}</dd></div>
        <div><dt>对象</dt><dd>{item.target}</dd></div>
        <div><dt>密钥状态</dt><dd>{item.secretStatus ? `${item.secretStatus}${item.secretMask ? ` (${item.secretMask})` : ""}` : "不涉及密钥"}</dd></div>
        <div><dt>来源</dt><dd>{item.source}</dd></div>
      </dl>
      <p>{item.detail || "日志只记录掩码状态和操作结果，完整密钥未写入，也不会在详情中展示。"}</p>
      <div className={styles.drawerActions}>
        <button type="button" className={styles.secondary} onClick={onClose}>关闭</button>
      </div>
    </DrawerFrame>
  );
}

function CreateCreator({ fetchImpl, onClose, onCreated }: { fetchImpl: FetchLike; onClose: () => void; onCreated: () => void }) {
  const ref = useRef<HTMLFormElement>(null);
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useModalKeyboard(true, ref, onClose);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(username)) {
      setError("登录账号只能使用字母、数字、点、下划线和短横线。");
      return;
    }
    if (password.length < 8 || password.length > 1024 || password !== confirm) {
      setError("请填写 8 位以上的密码，并再输入一次相同密码。不会使用空密码或默认密码。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await withSession(fetchImpl)("/api/v1/admin/creators", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await response.json().catch(() => ({})) as { error?: { code?: string }; password?: string };
      if (!response.ok || body.password) {
        setError("没有创建账号。");
        return;
      }
      setPassword("");
      setConfirm("");
      onCreated();
    } catch {
      setError("没有创建账号。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <form ref={ref} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="create-title" onSubmit={(event) => void submit(event)}>
        <div className={styles.dialogHead}>
          <h2 id="create-title">创建创作者账号</h2>
          <button type="button" className={styles.close} aria-label="关闭" onClick={onClose}>
            <img src="/design/tailadmin-v2/icon-x.svg" width={18} height={18} alt="" />
          </button>
        </div>
        <p>公开注册仍关闭。此操作由验收或制作开通创作者账号，对方只能进入 /studio，不能访问 /admin。</p>
        <label className={styles.field}>
          <span>显示名</span>
          <input value={displayName} placeholder="例如：林夏" aria-label="显示名" onChange={(event) => setDisplayName(event.target.value)} />
          <small>显示名只在这个对话框里填写。账号表没有这一列，不会被保存。</small>
        </label>
        <label className={styles.field}>
          <span>登录账号</span>
          <input value={username} placeholder="例如：linxia" aria-label="登录账号" autoComplete="off" onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label className={styles.field}>
          <span>密码</span>
          <input type="password" value={password} aria-label="密码" autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} />
        </label>
        <label className={styles.field}>
          <span>确认密码</span>
          <input type="password" value={confirm} aria-label="确认密码" autoComplete="new-password" onChange={(event) => setConfirm(event.target.value)} />
        </label>
        <label className={styles.field}>
          <span>角色</span>
          <input readOnly aria-label="角色" value="创作者（不可改为工作空间或其他租户角色）" />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <div className={styles.dialogActions}>
          <button type="button" className={styles.secondary} onClick={onClose}>取消</button>
          <button type="submit" className={styles.primary} disabled={busy}>{busy ? "正在创建…" : "创建账号"}</button>
        </div>
      </form>
    </>
  );
}
