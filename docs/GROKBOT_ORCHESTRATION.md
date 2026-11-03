# GrokBot 统一制作入口（草案）

更新：2026-11-03（Asia/Shanghai）。基线：`main@a5fb8fe637a3f98c9a2c6ad07c7de0cd7e9ce13f`（含 PR #100/#101）。

本文把自然语言制作口令映射到**现有** `/api/v1` HTTP 与仓库 CLI。它不是第二套任务库、不是独立管理后台、也不是自动审核器。PostgreSQL 中的 `GenerationJob` / `JobAttempt` / `WorkflowRun` / `Outbox` / `Asset` / 成本记录仍是唯一业务真相。

配套只读封装：`scripts/grokbot-orchestration/dry-run.mjs`（默认 dry-run，不发付费请求）。

## 不变量

- 不把聊天消息、Bot 本地文件或队列副本当作业务任务真相。
- 不自动批准剧本、分镜、成片；不自动选用新声音候选。
- 外部结果未知时保留 `UNKNOWN`：无远端 ID 不自动重发；有 ID 只查询原任务。
- 不把 Mock / 静音 / 正弦波 / 固定技术样片标为真实 AI 质量通过。
- 不用 usage 推算并伪造 `ACTUAL` 费用；未知金额保持未知。
- 系列 1–60 集仍是文本模式；媒体入口继续拒绝系列作品。
- 密钥、连接串、签名 URL、私有收据不进入聊天或本文件示例。

## 调用前置（所有写操作）

| 项 | 要求 |
| --- | --- |
| Base | `https://drama.playhubs.cn/api/v1`（或其他已授权同源 API） |
| 登录 | `POST /auth/login` → 会话 cookie + `csrfToken`；读 `GET /auth/session` |
| 写请求头 | `Origin` 与 `SITE_AUTH_PUBLIC_ORIGIN` 完全一致；`X-CSRF-Token`；JSON |
| 幂等 | 标注「需要 Idempotency-Key」的写入必须带永久键（≤200 字符）；同键同规范化 body 回放原响应，不同 hash → `IDEMPOTENCY_KEY_REUSED` |
| 版本 | 标注 `If-Match` / `expectedReviewVersion` / `expectedInputHash` / `contentHash` 的步骤必须带当前值 |
| 开关 | 真实媒体默认关闭；drafts 未装、未 provision、未付费授权时，付费路径应拒绝或不可用 |

健康探针（匿名）：`GET /health/live`、`GET /health/ready`。

CLI（已有，默认 plan / 不写库）：

```sh
corepack pnpm --filter @ai-drama/api real-media:provision
# 仅另获目标库写入授权后才允许：
# corepack pnpm --filter @ai-drama/api exec tsx src/admin/real-media-provision-cli.ts --execute
```

## 付费边界速查

| 类别 | 是否触发供应商/模型付费 | 说明 |
| --- | --- | --- |
| 健康、项目/剧集/场景/镜头/任务 GET | 否 | 只读 |
| `POST /projects`、人工文本修订、审核 decision | 否（平台侧） | 无外部模型费；仍写库 |
| 标题/自动创作/剧本拆解/系列写作/ViMax 规划发送 | **是（文本模型）** | 计入写作日额/并发；需生效的 admin 模型配置 |
| `.../real-media/quote`、speech `.../quote`、speech-batch preflight | 否 | 冻结报价；不调用供应商 |
| `.../real-media/authorize`、speech-batch `confirm` | 否（记账授权） | 显式预算确认；本身不发模型 |
| `.../real-media/generate`、speech `.../generate`、batch 确认后创建的 Job | **是** | 真实图片/视频/TTS/音乐 |
| Mock `generate-*` / `workflows/mock*` | 否（零成本 Mock） | production 另有禁用校验；不能冒充真实质量 |
| `compose-preflight` / `mix-preflight` | 否 | 只读预检 |
| `voice-compose` / `compose` / 整集 `compose` | 否（本地 FFmpeg） | 消耗已选资产；需 compose 开关与字体；不计云模型费 |
| 导出/下载已审核成片与来源清单 | 否 | 读取已有 Asset |
| `cancel` Job / workflow / batch / run | 否 | 只停后续；不撤销已发外部费用 |
| `real-media:provision`（无 `--execute`） | 否 | plan；0 写库 0 调用 |
| `real-media:provision --execute` | 否（模型） | **写 ProviderConfiguration**；需库写入授权 |

---

## 命令映射

下列「用户说法」可按 GrokBot 实际能力调整措辞；执行必须落到表内真实 API/CLI。

### 1. 创建短剧

**用户说法**：`创建短剧：题材……受众……故事方向……`

| 步骤 | HTTP / CLI | 付费 |
| --- | --- | --- |
| A. 建项目 | `POST /projects` body `{title,premise}` + `Idempotency-Key` | 否 |
| B. （可选）自动创作包 | `GET /writing/auto-runs/options` → `POST /projects/:projectId/auto-runs` + key | **文本模型** |
| B′. （可选）写作候选 | `GET /writing/candidates/options` → `POST /projects/:projectId/writing/candidates` + key | **文本模型** |
| C. 人工故事/剧本 | `POST /projects/:projectId/stories`；`POST /projects/:projectId/episodes/:episodeId/scripts`（或 `POST /episodes/:episodeId/scripts`）+ key / `If-Match` | 否 |
| D. 审核文本 | `POST .../stories/:revisionId/review`；`POST .../scripts/:revisionId/review`（及角色/场景/镜头同类 review）+ key | 否 |

**前置条件**：站点会话；自动创作还需标题写作配置生效、额度未满。首个真实短片优先：原创双角色、4–8 句中文对白、单一场景；系列媒体勿开。

**幂等 / 审核点**：项目与修订创建用永久 `Idempotency-Key`；审核必须人工 `APPROVE`/`REJECT`，Bot 不得伪造。

**失败恢复**：同 key 重放创建；冲突换新 key 前先 `GET` 确认是否已存在。文本模型失败读 `auto-runs/:runId` / candidate，用 `cancel`/`resume` 按原规则，不另起第二套 run 库。

---

### 2. 查看进度和阻塞 / 继续上次项目

**用户说法**：`查看这个项目的进度和阻塞`；`继续上次项目`

| 读取 | HTTP | 付费 |
| --- | --- | --- |
| 项目列表/详情 | `GET /projects`；`GET /projects/:projectId` | 否 |
| 集/场景/镜头/角色 | `GET .../episodes`；`.../scenes`；`.../shots`；`.../characters` | 否 |
| 工作流与任务 | `GET /projects/:projectId/workflow-runs`；`GET /workflow-runs/:runId`；`GET /generation-jobs/:jobId` | 否 |
| 费用摘要 | `GET /projects/:projectId/cost-summary`（schema `m4.project.cost-summary.v1`） | 否 |
| 真实媒体暴露 | `GET /projects/:projectId/real-media/capabilities`；`GET .../real-media/cost-exposure` | 否 |
| 声音能力/批次 | `GET .../speech-capabilities`；`GET .../speech-batch-plan`；`GET .../speech-batches`；`GET /speech-batches/:batchId` | 否 |
| 自动创作进度 | `GET .../auto-runs/latest`；`GET .../auto-runs/:runId` | 否 |

**阻塞判定（只读汇总，不改状态）**：

1. 文本未 `APPROVED` / 存在 `STALE` → 先审或修来源。
2. `cost-exposure.unknownSubmissionCount > 0` 或 job 停在 `UNKNOWN` → 有远端 ID 只查询；无 ID 停，待用户授权。
3. real-media / speech capabilities `available=false` → 开关、drafts、provision、字体或配置缺口。
4. speech-batch-plan blockers（缺计划/选声/批准）→ 先补声音链。
5. compose 预检失败 → 缺已审素材、字体、时长溢出等。

**继续上次**：用最近 `GET /projects` 项或用户给出的 `projectId`；恢复只 `GET` 原 `jobId`/`batchId`/`runId`。显式恢复：`POST /speech-batches/:batchId/resume`、`POST .../auto-runs/:runId/resume`、`POST /generation-jobs/:jobId/retry`（仅可重试终态；新媒体规则见 API 合约）——均需 key，且**不得**用来重发无 ID 的 UNKNOWN。

---

### 3. 查看待审核剧本和分镜

**用户说法**：`查看待审核剧本和分镜`

| 读取 | 说明 |
| --- | --- |
| `GET .../stories`；`GET .../episodes/:episodeId/scripts` | 找 `DRAFT` / `IN_REVIEW` |
| `GET .../scenes/:sceneId/revisions`；`GET .../shots/:shotId/revisions` | 分镜文本 |
| `GET /shot-revisions/:revisionId/assets`；`GET .../composites` | 待审素材/成片 |
| `GET /characters/:characterId/reference-images` | 参考图待审 |

**审核写入（需人工决策）**：

- 剧本/故事/角色/场地/场景/镜头：`POST .../revisions/:revisionId/review` + key + 版本字段
- 素材/成片：`POST /assets/:assetId/review`，body `{decision, note, contentHash}` + key + `If-Match`（`contentHash` 必须等于预览 checksum）
- 参考图：`POST /character-reference-images/:assetId/review`

**付费**：审核本身否。  
**失败恢复**：`REVIEW_CONFLICT` / `REVISION_CONFLICT` → 重新 GET 再提交；不得跳过 `contentHash`。

---

### 4. 查看下一阶段报价

**用户说法**：`查看下一阶段报价`

| 场景 | HTTP | 付费 |
| --- | --- | --- |
| 真实镜头（图/视/乐等） | `POST /projects/:projectId/shot-revisions/:shotRevisionId/real-media/quote` | 否（报价） |
| 单句 TTS | `POST /speech-plans/:revisionId/lines/:lineId/quote` | 否 |
| 整集声音补齐冻结 | `POST .../speech-batches`（preflight，写回执不调模型）+ key | 否 |
| 累计账本 | `GET /projects/:projectId/cost-summary`；`GET .../real-media/cost-exposure` | 否 |
| 文本写作选项/额度 | `GET /writing/auto-runs/options` 等 | 否 |

**前置**：镜头/对白来源已批准；真实媒体能力可用；报价含 `quoteId`、`maximumAmount`、币种、`uncertainJobIds`、过期时间。

**授权（仍非发送）**：

- `POST /projects/:projectId/real-media/authorize`，需 `confirmSinglePaidOperation:true` 且金额与 quote 一致
- `POST /speech-batches/:batchId/confirm`，需 `confirmPossibleCharges:true`，`maximumJobs` 与币种总额精确等于冻结值

**失败恢复**：过期或来源变化 → 重新 quote；金额不符 → 409，禁止改低总额硬闯。

---

### 5. 只重做指定镜头或指定台词

**用户说法**：`只重做指定镜头或指定台词`

#### 5a 重做真实镜头素材

1. 如需改分镜：`POST .../shots/:shotId/revisions`（新版本，旧下游 STALE）→ 人工审核  
2. `quote` → 用户确认预算 → `authorize` → `POST .../real-media/generate` + **新** `Idempotency-Key`  
3. 轮询 `GET /generation-jobs/:jobId`；成功后人工 `POST /assets/:assetId/review`

**付费**：`generate` **是**。

#### 5b 重做指定台词（TTS）

1. 确认 `voice-bindings` 与 `speech-plan`（`PUT` 会版本化，需 `If-Match`）  
2. `POST .../lines/:lineId/quote` → 用户确认 → `POST .../lines/:lineId/generate` + key  
3. 试听 takes → `PUT .../selections/:lineId`（人工选用，不自动选）  
4. 需要整段补齐时用 speech-batch；已有有效 take 不应再付费

**付费**：`generate` / batch 确认后创建的 Job **是**。

**失败恢复**：UNKNOWN 无 ID → 停；有 ID → 只查原任务。存储失败只恢复原输出。取消 batch 不取消已创建 Job。

**禁止**：关闭严格角色参考门；用 Mock 图冒充真实参考；删改已批准对白原文凑时长。

---

### 6. 合成并预览

**用户说法**：`合成并预览`

| 步骤 | HTTP | 付费 |
| --- | --- | --- |
| 声音混音预检 | `POST /speech-plans/:revisionId/mix-preflight` | 否 |
| 单镜预检 | `POST /shot-revisions/:revisionId/compose-preflight` | 否 |
| 新声音合成 | `POST /shot-revisions/:revisionId/voice-compose` + key | 否（本地） |
| 单镜合成 | `POST /shot-revisions/:revisionId/compose`（含 `expectedInputHash`）+ key | 否（本地） |
| 整集预检 | `POST .../episodes/:episodeId/compose-preflight` | 否 |
| 整集合成 | `POST .../episodes/:episodeId/compose` + key | 否（本地） |
| 预览字节 | `GET /assets/:assetId/content` 或 `GET /real-media/assets/:assetId/content` | 否 |

**前置**：已选逐句音频 / 已批准视频等；`M4_LOCAL_COMPOSE_*`、工作目录、Python、Noto Sans CJK SC；voice profile `local-ffmpeg-voice-v1` 不裁句尾。

**审核点**：合成出 `DRAFT` 成片后必须人工预览再 `POST /assets/:assetId/review`。

**失败恢复**：`COMPOSE_INPUT_CHANGED` → 重新 preflight；`COMPOSE_FONT_UNAVAILABLE` → 配字体后重试同输入；Job 失败按原 attempt 查，不换输入偷跑。

---

### 7. 导出已审核成片和来源清单

**用户说法**：`导出已审核成片和来源清单`

| HTTP | 说明 | 付费 |
| --- | --- | --- |
| `GET .../episodes/:episodeId/compose-candidates` | 已批准单镜成片候选 | 否 |
| `GET .../episodes/:episodeId/composites` | 集合成片列表 | 否 |
| `GET .../composites/:assetId/download` | MP4 | 否 |
| `GET .../composites/:assetId/export-manifest` | 来源清单 | 否 |

**前置**：目标 Asset 已 `APPROVED`；会话有效。  
**失败恢复**：404/未批准 → 回到审核；下载失败重试同一 `assetId`，不重新合成。

---

### 8. 暂停后续任务，查看已有任务

**用户说法**：`暂停后续任务，查看已有任务`

| 动作 | HTTP | 付费 |
| --- | --- | --- |
| 取消未完成 Job | `POST /generation-jobs/:jobId/cancel` + key | 否 |
| 取消 Workflow | `POST /workflow-runs/:runId/cancel` + key | 否 |
| 停止 batch 后续建 Job | `POST /speech-batches/:batchId/cancel` + key | 否 |
| 取消文本 run | `POST .../auto-runs/:runId/cancel`；`.../title-runs/:runId/cancel`；ViMax `.../requests/:requestId/cancel` | 否 |
| 查看残留 | `GET` jobs / workflow-runs / speech-batches / cost-exposure | 否 |

**边界**：cancel **不撤销**已发供应商处理或费用；已 `queued`/运行中 Job 须逐个处理；`dispatched` ≠ 已向供应商收费。只关 `REAL_MEDIA_ENABLED` 可停新发送，但须保留恢复所需 key/S3。

---

## 推荐首个真实短片路径（只读规划）

1. 会话 + `GET /health/ready`  
2. `POST /projects`（原创双角色 premise）  
3. 人工或受控文本链 → 剧本/角色/场景/镜头全部人工批准  
4. 固定两角色 `voice-bindings` → speech-plan → 逐句 quote（展示报价，**停**）  
5. 取得金额/次数上限授权后：generate → 试听选用 → mix-preflight  
6. 镜头 real-media quote/authorize/generate（同样先报价后授权）  
7. voice-compose / compose → 人工审成片 → export download + manifest  
8. 全程记录：运行 SHA、输入版本、Job/Attempt/Asset、实测时长、已知/未知费用  

在未获业务库 draft 安装、provision `--execute`、真实付费上限授权前，GrokBot **只执行到报价与只读进度**，不调用 generate/confirm 后的付费 Job。

---

## 极薄封装脚本

```sh
# 默认 dry-run：只打印将调用的只读 HTTP/CLI，零网络付费
node scripts/grokbot-orchestration/dry-run.mjs help
node scripts/grokbot-orchestration/dry-run.mjs progress --project-id <uuid>
node scripts/grokbot-orchestration/dry-run.mjs quote-plan --project-id <uuid> --shot-revision-id <uuid>
node scripts/grokbot-orchestration/dry-run.mjs pause-plan --job-id <uuid> --batch-id <uuid>

# 显式只读探测（仍拒绝任何付费路径）；需要可达 API
ADS_API_BASE=https://drama.playhubs.cn/api/v1 \
  node scripts/grokbot-orchestration/dry-run.mjs health --live
```

脚本**永不**自动带 cookie 发 `generate` / `authorize` / speech `generate` / batch `confirm` / provision `--execute`。付费步骤只打印「需用户授权后由主 Bot 逐步执行」的检查清单。

---

## 仍需用户授权（本草案不代为执行）

1. 测试站点服务器 SSH/运行入口：核实运行 SHA、已装 migration/drafts、字体、S3、开关。  
2. 业务库：draft SQL 审查与执行；`real-media:provision --execute`。  
3. 真实模型：账号/地域/现价；本次 4–8 句试验的请求数、币种、费用上限。  
4. 每一次 `authorize` / batch `confirm` / 文本付费 run 的人工确认。  
5. 剧本、分镜、选声、成片的主观审核结论。  
6. Draft PR 合入 main、以及合入后的站点部署（部署另按 `ENGINEERING_WORKFLOW.md` 持续授权，但仍须记录 SHA）。

## 参考

- [ENGINEERING_WORKFLOW.md](ENGINEERING_WORKFLOW.md)  
- [API_CONTRACT.md](API_CONTRACT.md)  
- [REAL_MEDIA_RUNBOOK.md](REAL_MEDIA_RUNBOOK.md)  
- [V1_AUTHORIZATION_CHECKLIST.md](V1_AUTHORIZATION_CHECKLIST.md)  
- [REAL_PRODUCTION_COMPLETION_PROGRESS.md](REAL_PRODUCTION_COMPLETION_PROGRESS.md)  
