# 首支真实短片启动授权包（可审阅）

更新：2026-11-03（Asia/Shanghai）。基线分支 `feat/grokbot-drama-orchestration` / Draft PR [#102](https://github.com/xyq-dev/ai-drama-studio/pull/102)；文档对照 `main@a5fb8fe` + 本分支编排草案。

**本文件用途**：把「服务器只读核验 → 业务库 draft → provision → 首支双角色 4–8 句付费上限 → 人工审核门」整理成可勾选、可签字的授权包。  
**本文件不授权、不执行**：不部署、不跑 SQL、不 `provision --execute`、不发 `generate` / batch `confirm` 后的付费 Job。执行前须由用户在下方对应栏填写并确认。

配套阅读：

- [GROKBOT_ORCHESTRATION.md](GROKBOT_ORCHESTRATION.md) — NL → API/CLI 与付费边界  
- [V1_AUTHORIZATION_CHECKLIST.md](V1_AUTHORIZATION_CHECKLIST.md) — 启用与验收总清单  
- [REAL_MEDIA_RUNBOOK.md](REAL_MEDIA_RUNBOOK.md) — 配置变量与 provision 规则  
- [ENGINEERING_WORKFLOW.md](ENGINEERING_WORKFLOW.md) — Git / 指定测试站部署流程  

目标站点（只读核对对象）：`https://drama.playhubs.cn`  
目标样片：同场景、双角色、4–8 句中文对白 → 逐句 TTS →（可选）镜头真实图/视 → 本地 voice-compose / compose → 人工审核 → MP4 + 来源清单导出。系列媒体入口保持关闭。

---

## 0. 授权总表（用户填写）

| 授权项 | 用户勾选 | 填写 / 签字栏 | 状态（执行前） |
| --- | --- | --- | --- |
| A. 服务器只读核验（§1） | [ ] 允许 Bot/运维只读 SSH 或等价只读入口 | 入口方式：________；操作者：________ | 未执行 |
| B. 业务库 draft 安装（§2） | [ ] 授权对下方**精确目标库**执行所列 draft | 目标库占位见 §2.2 | 未执行 |
| C. `real-media:provision --execute`（§2.4） | [ ] 授权写入 ProviderConfiguration | 是否允许 `--enable-existing`：[ ] 是 [ ] 否（默认否） | 未执行 |
| D. 首支样片付费上限（§3） | [ ] 授权在上限内的真实模型调用 | 币种：____；总上限：____；请求数上限见 §3 | 未执行 |
| E. 人工审核由用户本人完成（§4） | [ ] 确认 Bot **不得**代批 | — | 持续有效 |
| F. 部署（本包默认不含） | [ ] 另开部署授权（若代码未上站） | 部署前/后 SHA：________ | 本包不执行 |

> 未勾选的项：GrokBot **只做到报价与只读进度**（见 GROKBOT_ORCHESTRATION.md）。

---

## 1. 服务器只读清单（就绪与否，不输出密钥）

核对对象：指定测试站 API + Worker + Web（同源 `SITE_AUTH_PUBLIC_ORIGIN`）。  
报告格式：每项只填 `就绪 / 未就绪 / 未知`，可附非敏感版本标识（如 credential version 名、price version 字符串、字体 face 名、运行 SHA）。**禁止**输出 API key、密码哈希明文、连接串、签名 URL、收据密文。

### 1.1 运行与进程

| # | 核项 | 如何核（只读） | 就绪？ |
| --- | --- | --- | --- |
| 1.1.1 | 运行代码 SHA | 进程/镜像/发布标注中的 git SHA；与期望部署 SHA 比对 | [ ] 就绪 [ ] 未就绪 [ ] 未知；记录 SHA：________ |
| 1.1.2 | API `GET /api/v1/health/live` | HTTP 200 | [ ] |
| 1.1.3 | API `GET /api/v1/health/ready` | 200；`postgres` / `redis` / `objectStorage` 等依赖 ok（只报布尔） | [ ] |
| 1.1.4 | Worker 进程在跑且与 API **同** workspace / 配置版本 | 进程列表或编排状态；配置版本号一致 | [ ] |
| 1.1.5 | Web 可打开且同源 Origin 与 `SITE_AUTH_PUBLIC_ORIGIN` 一致 | 浏览器只读；不记录 cookie | [ ] |

### 1.2 数据库结构（只读探测，不执行 SQL 草案）

| # | 核项 | 如何核 | 就绪？ |
| --- | --- | --- | --- |
| 1.2.1 | 普通 migration 已应用到目标库 | `_prisma_migrations` 或等价只读查询；记录最新 migration 名 | [ ]；最新：________ |
| 1.2.2 | character-voice draft **是否已装** | 表是否存在：`speech_voice_binding` / `speech_plan` / `speech_line_*` 等（只查存在性） | [ ] 已装 [ ] 未装 [ ] 未知 |
| 1.2.3 | real-media draft **是否已装** | 表是否存在：`real_media_authorization` / `real_media_submission` 等 | [ ] 已装 [ ] 未装 [ ] 未知 |
| 1.2.4 | speech-batch draft **是否已装**（可选，见 §2） | 表是否存在：`speech_batch_command` / `speech_batch_operation` | [ ] 已装 [ ] 未装 [ ] 未知 / [ ] 本轮不启用 |

### 1.3 合成与字体

| # | 核项 | 如何核 | 就绪？ |
| --- | --- | --- | --- |
| 1.3.1 | FFmpeg 可用（Worker 主机） | `ffmpeg -version` 出口码 0；记录 major 版本即可 | [ ]；版本：________ |
| 1.3.2 | Noto Sans CJK SC 可用 | `M4_VOICE_COMPOSE_FONT_PATH` 已设且文件存在，或系统受信候选可找到 SC face；记录 face 名 / 文件 SHA（非路径密钥） | [ ]；face/SHA：________ |
| 1.3.3 | 本地合成开关意图 | 记录 `M4_LOCAL_COMPOSE_ENABLED` / `M4_LOCAL_EPISODE_COMPOSE_ENABLED` 是否为 true（布尔）；工作目录是否已配置（只报是否） | compose：[ ] episode：[ ] dirs：[ ] |

### 1.4 真实媒体与供应商配置（存在性 / 版本，不泄密）

| # | 核项 | 就绪判据（布尔） | 就绪？ |
| --- | --- | --- | --- |
| 1.4.1 | `REAL_MEDIA_ENABLED` | 进程可见；记录 true/false | [ ]；值：________ |
| 1.4.2 | `REAL_MEDIA_ALLOW_PRODUCTION` | 生产进程若需要则为 true；记录 true/false | [ ]；值：________ |
| 1.4.3 | `REAL_MEDIA_RECEIPT_KEY` + `_VERSION` | **已注入**（不读值）；API/Worker 版本字符串一致 | [ ]；version：________ |
| 1.4.4 | `DASHSCOPE_MEDIA_API_KEY` + `DASHSCOPE_MEDIA_CREDENTIAL_VERSION` | 已注入；credential version 一致 | [ ]；credVer：________ |
| 1.4.5 | 价格快照 | `REAL_MEDIA_PRICE_VERSION` 已填；`DASHSCOPE_MEDIA_PRICE_IMAGE` / `_VIDEO_SECOND` / `_TTS_CHARACTER` 正数已配（只报是否） | [ ]；priceVer：________ |
| 1.4.6 | 单次应用门槛 | `REAL_MEDIA_MAX_SINGLE_CNY` / `_USD` 已设（记录数值即可，非密钥） | [ ]；CNY：____ USD：____ |
| 1.4.7 | 音乐（若本轮需要） | `ELEVENLABS_MEDIA_API_KEY` + price 已注入 | [ ] 需要且就绪 [ ] 本轮不用 |
| 1.4.8 | Previous key 槽位 | 若已轮换：previous version 名存在；否则 N/A | [ ] / N/A |

### 1.5 对象存储与站点认证

| # | 核项 | 就绪判据 | 就绪？ |
| --- | --- | --- | --- |
| 1.5.1 | `APP_WORKSPACE_ID` | API/Worker 相同；只报是否一致与非敏感 id 形态（可打码） | [ ] |
| 1.5.2 | `S3_*`（endpoint/bucket/region/凭证注入） | health/ready 中 objectStorage ok；真实前缀应为 `real-media/...`（不写 Mock 目录） | [ ] |
| 1.5.3 | 站点认证 | `SITE_AUTH_ENABLED`；可 `POST /auth/login` 成功拿 session（不记录密码）；CSRF 可用 | [ ] |
| 1.5.4 | `SITE_AUTH_PUBLIC_ORIGIN` | 与浏览器 Origin 完全一致 | [ ]；origin 形态：________ |

### 1.6 能力探针（登录后只读，零付费）

在会话建立后：

| # | 探针 | 期望 | 结果 |
| --- | --- | --- | --- |
| 1.6.1 | `GET .../real-media/capabilities` | 记录 `available` 与不可用原因码（无密钥） | [ ] |
| 1.6.2 | `GET .../speech-capabilities` | 同上 | [ ] |
| 1.6.3 | `GET .../speech-batch-plan`（若启用 batch） | blockers 列表可解释 | [ ] / N/A |
| 1.6.4 | dry-run helper | `node scripts/grokbot-orchestration/dry-run.mjs health --live` → `paidCalls:0` | [ ] |

**§1 完成标准**：1.1–1.5 无「阻塞未知」；若 draft 未装或开关关闭，记入 §2/§3 阻塞，不得假装可付费。

---

## 2. 业务库：精确 draft、目标库占位、备份/回退、provision

> 普通 `migrate`、启动和 GET **不会**安装 drafts。本包**默认不执行**下列 SQL；仅供审查与专项授权。

### 2.1 精确文件路径（仓库内）

| 顺序 | 能力 | 精确路径 | 对本轮首支短片 | 前置 |
| --- | --- | --- | --- | --- |
| 1 | 角色声音 / 逐句计划与选用 | `packages/database/prisma/drafts/20261101000100_character_voice.sql` | **必需** | 现有文本链、媒体资产、资产依赖等普通 migration |
| 2 | 真实媒体报价/授权/提交收据 | `packages/database/prisma/drafts/20261101000200_real_media.sql` | **必需**（凡真实图/视/TTS/音乐路径） | 既有 Job/Attempt/Asset；启用另需认证、媒体配置与 provision |
| 3 | 预算内整集声音补齐 | `packages/database/prisma/drafts/20261101000300_speech_batch.sql` | **可选**（逐句手动 quote/generate 可先不装；要用 SpeechBatchPanel 则要） | 依赖 character-voice；实际 TTS 仍需 real-media + 准入 |
| — | ViMax 规划（非本轮必需） | `packages/database/prisma/drafts/20261101000100_vimax_planning_request.sql`（及既有 `20261031000100_vimax_storyboard_candidate.sql`） | 本轮首支短片 **默认跳过** | 标题写作配置等 |

审查时核对各文件头部 `DRAFT ONLY` 注释、最终审查 **blob SHA**（安装前填写）：

| 文件 | 安装前审查 blob SHA（用户/审查者填） | 审查人 | 日期 |
| --- | --- | --- | --- |
| `.../20261101000100_character_voice.sql` | ________ | ________ | ________ |
| `.../20261101000200_real_media.sql` | ________ | ________ | ________ |
| `.../20261101000300_speech_batch.sql`（可选） | ________ / N/A | ________ | ________ |

### 2.2 目标库占位（必须由用户填实后才能授权执行）

| 字段 | 占位（审查填写） |
| --- | --- |
| 环境名 | 例：`drama.playhubs.cn` 测试站业务库 |
| 主机/实例标识（非连接串） | ________ |
| 数据库名 | ________ |
| 角色/执行身份（非密码） | ________ |
| 是否与生产隔离 | [ ] 是 [ ] 否（否 → 默认拒绝本包 SQL） |
| 当前普通 migration 头 | ________ |
| 备份对象存储位置（非密钥） | ________ |

### 2.3 备份 / 回退（执行前必须勾选计划）

| 步骤 | 内容 | 勾选 |
| --- | --- | --- |
| 备份 | 目标库逻辑备份或快照；记录备份 id/时间（Asia/Shanghai） | [ ] 计划已写：[ ] 已完成备份 id：________ |
| 预检 | 在**隔离空库或只读副本**核对 SQL 可应用；不把空库 CI 当成业务库已装 | [ ] |
| 执行顺序 | 先 `character_voice` → 再 `real_media` →（可选）`speech_batch`；单文件一事务；失败即停 | [ ] |
| 验证 | `\dt` / 信息架构确认新表存在；应用启动无迁移报错；capabilities 仍可按开关关闭 | [ ] |
| 回退 | **无自动 down migration**。回退策略二选一写明：① 从备份整库恢复；② 保留结构、仅关 `REAL_MEDIA_ENABLED` 并停止付费（数据保留）。选定：________ | [ ] |
| 禁止 | 改写已应用 migration；把 draft 混进默认 `migrate`；删除历史 Job/Asset 充数 | [ ] 已知晓 |

### 2.4 `provision --execute`（写 ProviderConfiguration，不跑 migration、不调模型）

| 项 | 内容 |
| --- | --- |
| Plan（已授权可随时只读） | `corepack pnpm --filter @ai-drama/api real-media:provision` — **0 连接 / 0 写库 / 0 供应商**（需进程已有受控配置才能生成有意义的 plan） |
| Execute（需本包 §0-C） | `corepack pnpm --filter @ai-drama/api exec tsx src/admin/real-media-provision-cli.ts --execute` |
| 影响 | 为当前 ACTIVE workspace 创建所需 `ProviderConfiguration`；`encryptedCredentialRef` 仅为 `env:dashscope-media` / `env:elevenlabs-media` 引用；`maxAttempts=1`；**不存明文 key** |
| 不匹配行为 | 已有配置字段不匹配 → 拒绝；重新启用已禁用且完全匹配的配置需显式 `--enable-existing`（默认本包 **不勾选**） |
| 验证 | plan 输出与 execute 后只读列出配置 id/能力/version（无密钥）；`capabilities` 在开关打开后反映准入；仍须逐次 quote→authorize 才可付费 |
| 回退 | 禁用相关 ProviderConfiguration（应用侧）；不删除历史授权/收据行；关 `REAL_MEDIA_ENABLED` 停新发送 |

**本包当前**：provision execute = **未执行**。

---

## 3. 首支双角色 4–8 句：请求数、金额上限、付费触发对照

### 3.1 样片范围（建议默认，可改）

| 项 | 建议值 | 用户确认 |
| --- | --- | --- |
| 形态 | 单项目、单集、单场景、双角色、4–8 句中文对白 | [ ] 同意 / 修改为：________ |
| 文本来源 | **优先人工**剧本/分镜（避免本轮文本模型费）；若用 auto-run/候选须另计入 §3.3 | [ ] 人工 [ ] 含文本模型 |
| 视频 profile | 代码固定例：`wan2.6-i2v-flash`（账号资格另核） | [ ] |
| TTS profile | `qwen3-tts-flash` | [ ] |
| 图片 profile | 如需：`qwen-image-3.0` | [ ] 需要 [ ] 不需要 |
| 音乐 | ElevenLabs `music_v2` | [ ] 需要 [ ] 不需要 |
| 严格角色参考 | 不得为跑通关闭严格门；缺口记阻塞 | [ ] 已知晓 |

### 3.2 建议请求数上限（可勾选封顶）

下列为**建议天花板**（含少量失败重试余量）。用户可改低，不可在未改授权时超过。

| 能力 | 建议上限（次 Job / 付费提交） | 测算依据 | 用户批准上限 |
| --- | --- | --- | --- |
| TTS（逐句） | **12** | 4–8 句 × 1 首选用 take + ≤4 次重做 | ____（默认 12） |
| 真实图片 | **4** | ≤2 镜头参考/关键图 + 重试 | ____（默认 4 或 0） |
| 真实视频 | **6** | 1 场景 1–4 镜头 + 重试 | ____（默认 6） |
| 音乐 | **2** | 0–1 条 + 1 次重试 | ____（默认 0 或 2） |
| 文本模型（auto-run/候选/ViMax） | **0**（人工文本时） | 若启用另填 | ____（默认 0） |
| **合计付费 Job 上限** | **≤ 24**（按上面默认相加可再收紧） | — | **____** |

> `quote` / `authorize` / batch 冻结 **不计入**上表；计入的是实际创建并向供应商提交的 Job（见下表「会触发付费」列）。

### 3.3 币种与金额上限（用户必填，源码默认值无效）

应用门槛 `REAL_MEDIA_MAX_SINGLE_CNY` / `_USD` **不是**本次预算。请按官方现价与账号配额自行核算后填写：

| 字段 | 用户填写 |
| --- | --- |
| 主币种 | [ ] CNY [ ] USD [ ] 分项（TTS=CNY，音乐=USD） |
| 本次样片 **总费用上限** | ________（含税/服务费规则：________） |
| 单次 `authorize` 金额不得超过 | ________（且 ≤ 对应 quote.`maximumAmount`） |
| speech-batch 若启用：各币种 `budgets` 总和 | 必须 **精确等于** 冻结逐句 `maximumAmount` 之和（不能随意报低） |
| 未知费用处理 | 保持 UNKNOWN / 不写假 ACTUAL；超限即停 | [ ] 同意 |
| 云账号侧硬上限（若有） | ________（控制台或商务约定；本包不代替） |

### 3.4 付费触发对照（摘自 GROKBOT_ORCHESTRATION.md）

| 操作 | HTTP / CLI | 是否触发供应商/模型付费 | 本轮首支短片 |
| --- | --- | --- | --- |
| 健康、项目/剧集/场景/镜头/任务 GET | 只读 GET | 否 | 允许 |
| `POST /projects`、人工文本修订、审核 decision | 写库 | 否（无外部模型费） | 允许 |
| 标题/自动创作/剧本拆解/系列写作/ViMax 发送 | 对应 POST | **是（文本模型）** | 默认不做 |
| `.../real-media/quote`、speech `.../quote`、speech-batch 创建（冻结） | POST | 否（报价/回执） | 允许 |
| `.../real-media/authorize`、speech-batch `confirm` | POST | 否（记账授权；confirm 后会建付费 Job） | **须 §0-D 后逐步确认** |
| `.../real-media/generate`、speech `.../generate`、batch 确认后创建的 Job | POST / Worker | **是** | **须 §0-D + 单次确认** |
| Mock generate / mock workflow | POST | 否（零成本 Mock） | **禁止冒充真实质量** |
| compose-preflight / mix-preflight | POST | 否 | 允许 |
| voice-compose / compose / 整集 compose | POST | 否（本地 FFmpeg） | 允许（需字体） |
| 导出/下载已审成片与 manifest | GET | 否 | 允许 |
| Job / batch / run `cancel` | POST | 否（不退已产生费用） | 允许 |
| `real-media:provision`（无 `--execute`） | CLI | 否 | 允许 |
| `provision --execute` | CLI | 否（模型）；**写库配置** | 须 §0-C |

### 3.5 建议执行闸门（授权后仍逐步确认）

1. 只读 §1 全绿或阻塞已书面接受。  
2. §2 draft（必需两项）已装且 §0-C provision 完成（或确认已有匹配 ProviderConfiguration）。  
3. 人工文本与分镜全部 §4 批准。  
4. 逐句 **quote → 展示金额 → 用户确认 → generate**（或 batch：冻结 → 确认 budgets → confirm）；每步新 `Idempotency-Key`。  
5. 镜头真实媒体同样 **quote → authorize（confirmSinglePaidOperation）→ generate**。  
6. 选用 take → mix/compose-preflight → voice-compose/compose → **人工**审成片 → export。  
7. 全程记录：运行 SHA、输入版本、Job/Attempt/Asset、实测时长、请求数、已知/未知费用。

**超限或 UNKNOWN 无远端 ID：立即停，不自动重发、不换模型。**

---

## 4. 人工审核门（Bot 不代批）

Bot / 自动化 **不得**调用下列接口并填写 `APPROVE`，也不得在聊天中宣称「已审核通过」以代替用户操作。

| 门 | 对象 | 用户动作 | Bot 允许 |
| --- | --- | --- | --- |
| 剧本 / 故事 | story / script revisions | 阅读全文后 `APPROVE` / `REJECT` + note | 仅列出待审版本与 diff 摘要 |
| 角色 / 场地 / 场景 / 分镜 | character / location / scene / shot revisions | 同上 | 同上 |
| 选声 | speech takes → selection | 试听完整句后选用；不自动选新候选 | 列出 takes / 播放链接（若有） |
| 参考图 / 真实素材 Asset | `POST /assets/:id/review`（须正确 `contentHash`） | 看图/听音/看片后决策 | 提供预览与 checksum，不代填 decision |
| 成片 Composite | 单镜/整集成片 Asset | 看完整画面、听完整对白、核中文字幕与 ducking/淡出 | 提供 MP4/预览与 manifest，不代批 |
| 导出 | 仅已 `APPROVED` 资产 | 确认导出对象 | 仅下载已批准项 |

冲突（`REVIEW_CONFLICT` / 错误 `contentHash`）：重新 GET，由用户再审；禁止跳过哈希。

用户确认栏：

- [ ] 我理解并通过 UI 或亲自调用 review API 完成批准；不授权 Bot 代批。  
- 签名/日期：________（Asia/Shanghai）

---

## 5. 本包执行状态（维护用）

| 里程碑 | 状态 | 证据 |
| --- | --- | --- |
| 文档合入 Draft PR #102 | 进行中 / 已推送 | 本文件路径 |
| §1 服务器只读核验 | 未做 | — |
| §2 draft 安装 | 未做 | — |
| §2.4 provision --execute | 未做 | — |
| §3 付费样片 | 未做（供应商调用 0） | — |
| §4 人工审核结论 | 未做 | — |
| 部署 | 本包不包含 | — |

变更本表时同步一句到 [REAL_PRODUCTION_COMPLETION_PROGRESS.md](REAL_PRODUCTION_COMPLETION_PROGRESS.md)。

---

## 6. 参考命令（零付费预览）

```sh
# 编排 dry-run（默认不发付费请求）
node scripts/grokbot-orchestration/dry-run.mjs help
node scripts/grokbot-orchestration/dry-run.mjs create-plan
node scripts/grokbot-orchestration/dry-run.mjs quote-plan --project-id <uuid> --shot-revision-id <uuid>
ADS_API_BASE=https://drama.playhubs.cn/api/v1 \
  node scripts/grokbot-orchestration/dry-run.mjs health --live

# provision 仅 plan（不写库）
corepack pnpm --filter @ai-drama/api real-media:provision
```

**禁止**在未获 §0 对应勾选时运行：`provision ... --execute`、任何 `generate`、`authorize`（除非仅文档演练且用户在场逐步确认）、speech-batch `confirm`、业务库 draft SQL、站点部署。
