# 真实媒体、角色配音与单场景规划运行手册

更新：2026-11-01。本文说明当前代码怎样受控启用，不表示已经启用。**本轮真实付费模型调用 0、业务库 SQL 0、服务器部署 0。** 新能力默认关闭；独立 SQL 草案、业务库安装、真实试验和部署分别核对授权。Mock/协议替身、正弦波与 lavfi 素材只证明工程链路。

## 当前入口

| 功能 | 当前实现与范围 |
| --- | --- |
| 真实镜头素材 | 百炼北京 `qwen-image-3.0`、`wan2.6-i2v-flash`、`qwen3-tts-flash`；音乐为 ElevenLabs `music_v2` 纯伴奏。模型/地域/参数/价格/凭据版本冻结进输入。账号资格、现价与质量仍须实际核验。 |
| 一次生成 | `/api/v1/projects/:projectId/shot-revisions/:shotRevisionId/real-media/quote` → `/projects/:projectId/real-media/authorize` → 原镜头路径的 `/real-media/generate`。需要站点登录、CSRF、有效报价、单次授权与幂等键。 |
| 角色声音 | `/projects/:projectId/voice-bindings`、`/shot-revisions/:revisionId/speech-plan`、`/speech-plans/:revisionId/lines/:lineId/quote` 与 `/generate`、逐句选用和 `/mix-preflight`。当前目录仅 neutral/语速 1，每句最多 600 字符（服务端计数）；更长须按原文 span 拆句，不能删改批准对白。 |
| 新声音合成 | `POST /shot-revisions/:revisionId/voice-compose`；沿原 `MEDIA_COMPOSE` Job/Attempt/Outbox、成片审核及整集 MP4/来源清单导出。输入是已选逐句资产，不能上传 URL、路径或字体。 |
| 整集声音补齐 | 短剧剧本页 `SpeechBatchPanel`：只补选中的缺失/未知逐句项，保留有效 take 待试听；冻结报价、按币种总额确认、逐句创建原 `MEDIA_TTS` Job。具体路由与取消边界见下文。 |
| ViMax 规划 | `/projects/:projectId/episodes/:episodeId/vimax-planning/options`、`/requests`、`/requests/:requestId` 与 `/cancel`；一次文本规划，随后沿原候选→场景草稿→人工批准→镜头草稿。不自动批准或生成媒体。 |

所有路径均以 `/api/v1` 为前缀。系列作品仍为 1–60 集文本模式，以上媒体/单场景规划入口继续拒绝系列作品。声音克隆、口型、重叠对白、自托管 GPU、ComfyUI 实际推理、平台发布不在本轮实现范围。声音 V1-D 批量代码已实现，新增 PostgreSQL 用例仍待最终 HEAD CI；不把旧提交的通过记录当作该批量能力验收。

## 配置与准备

先按 [`DEV_RUNBOOK.md`](DEV_RUNBOOK.md) 完成锁定安装和依赖构建。API/Worker 必须使用同一 workspace、配置版本、收据密钥与 S3 bucket，并向两者注入有效的 `SITE_AUTH_ENABLED`、`SITE_AUTH_USERNAME`、`SITE_AUTH_PASSWORD_HASH`、`SITE_AUTH_PUBLIC_ORIGIN` 站点认证配置；开发环境也不能以匿名站点打开真实媒体。认证格式见 [`UNIFIED_ADMIN_LOGIN.md`](UNIFIED_ADMIN_LOGIN.md)。生产另需进程级媒体生产许可。密钥只通过服务端进程/secret 注入，不进入 `.env.example`、浏览器、日志或提交。

| 配置 | 默认/要求 |
| --- | --- |
| `REAL_MEDIA_ENABLED` | 默认关闭；true 只开放配置准入，不能代替逐次报价授权。 |
| `REAL_MEDIA_ALLOW_PRODUCTION` | 默认关闭，**仅进程环境**可授权生产准入；API 同时要求站点登录。不是部署命令。 |
| `REAL_MEDIA_RECEIPT_KEY`、`REAL_MEDIA_RECEIPT_KEY_VERSION` | 仅进程环境；密钥须为规范 base64 的 32 字节 AES-256-GCM key。版本默认 `v1`。API/Worker 必须一致。 |
| `REAL_MEDIA_PREVIOUS_RECEIPT_KEY`、`REAL_MEDIA_PREVIOUS_RECEIPT_KEY_VERSION` | 仅进程环境；可保留一个不同版本的旧解密 key。不自动重新加密历史收据。 |
| `DASHSCOPE_MEDIA_API_KEY`、`DASHSCOPE_MEDIA_CREDENTIAL_VERSION` | 媒体独立 key，API key 仅进程环境；凭据版本默认 `v1`。不读取已退役的千问文本配置作为媒体授权。 |
| `DASHSCOPE_MEDIA_PREVIOUS_API_KEY`、`DASHSCOPE_MEDIA_PREVIOUS_CREDENTIAL_VERSION` | 可保留一个旧版本供原任务只读查询；API key 仅进程环境。 |
| `ELEVENLABS_MEDIA_API_KEY`、`ELEVENLABS_MEDIA_CREDENTIAL_VERSION` | 音乐独立 key；API key 仅进程环境，凭据版本默认 `v1`。另支持 `ELEVENLABS_MEDIA_PREVIOUS_API_KEY`、`ELEVENLABS_MEDIA_PREVIOUS_CREDENTIAL_VERSION`。 |
| `REAL_MEDIA_PRICE_VERSION` | 无可用默认；填写已核对价格快照的版本。历史试接文档不是当前报价。 |
| `DASHSCOPE_MEDIA_PRICE_IMAGE`、`DASHSCOPE_MEDIA_PRICE_VIDEO_SECOND`、`DASHSCOPE_MEDIA_PRICE_TTS_CHARACTER` | 各能力正数单价；未配置就不开放该能力。CNY。 |
| `ELEVENLABS_MEDIA_PRICE_MUSIC_SECOND` | 音乐正数单价；未配置不开放音乐。USD。 |
| `DASHSCOPE_MEDIA_VIDEO_SECONDS` / `ELEVENLABS_MEDIA_MUSIC_SECONDS` | 默认均 5；代码范围分别 2–15 / 3–90 秒，不表示每个账号/模型已验收全部值。 |
| `REAL_MEDIA_MAX_SINGLE_CNY`、`REAL_MEDIA_MAX_SINGLE_USD` | 默认 10 / 2；限制一次报价可确认的最大金额。是应用门槛，不是云账号消费硬上限或每日预算。 |
| `APP_WORKSPACE_ID`、`S3_*` | 沿用服务端 workspace 与 S3 配置；真实资产写 `real-media/{workspace}/{project}/{job}/{attempt}/{sha256}.{ext}`。不写 Mock 目录。 |
| `M4_LOCAL_COMPOSE_ENABLED`、`M4_LOCAL_EPISODE_COMPOSE_ENABLED` | 默认 false；还需绝对 `M4_COMPOSE_WORK_DIR`、`M4_COMPOSE_OBJECT_DIR` 和可用 `M4_COMPOSE_PYTHON`。新声音输入是 S3，输出仍是 `local-compose`。 |
| `M4_VOICE_COMPOSE_FONT_PATH` | 可选，操作者指定的绝对 Noto Sans CJK SC 字体路径；不接受客户端路径。不设时只探受信系统候选路径。 |
| `VIMAX_PLANNING_ENABLED` | 默认 false；还需已生效的标题写作配置、站点登录、文本模型及规划/候选存储。共用工作区写作日限额与并发额度。 |
| `VIMAX_ALLOW_PRODUCTION` | 默认 false，**仅进程环境**；不代替 `TITLE_WRITING_ALLOW_PRODUCTION`、登录或一次规划确认。 |

只关闭 `REAL_MEDIA_ENABLED` 可阻止新发送；保留旧密钥和 S3 配置后，恢复适配器仍只有原请求的 inspect/resolve 能力，其 submit 固定拒绝。不要用删除 key 的方式暂停发送，否则原任务也无法恢复。

### 数据库与显式 provisioning

四个新增文件保持在 `packages/database/prisma/drafts/`：`20261101000100_character_voice.sql`、`20261101000200_real_media.sql`、`20261101000100_vimax_planning_request.sql`、`20261101000300_speech_batch.sql`。batch 依赖普通迁移和 character-voice 结构；实际付费还需 real-media 结构与准入。ViMax 规划还依赖既有 `20261031000100_vimax_storyboard_candidate.sql` 及其前置 script-breakdown 结构。核对各文件头部前置条件、最终审查 SHA、备份/恢复及执行对象；普通 `migrate`、启动和 GET 不会安装 drafts。

下列 plan 要求进程中已有完整的受控配置；**不创建连接、不写数据库、不调用供应商**：

```sh
corepack pnpm --filter @ai-drama/api real-media:provision
```

只有另获目标数据库写入授权后，才可运行 `corepack pnpm --filter @ai-drama/api exec tsx src/admin/real-media-provision-cli.ts --execute`。它为当前 ACTIVE workspace 创建所需 `ProviderConfiguration`，`encryptedCredentialRef` 只存 `env:dashscope-media` / `env:elevenlabs-media` 引用，`maxAttempts=1`；不执行 migration，不存明文 key，不调用模型。已有配置不匹配就拒绝；重新启用已禁用且完全匹配的配置还需显式 `--enable-existing`。本轮未运行 execute。

### 收据与凭据轮换

1. 暂停新发送，保留恢复所需进程配置、S3 与旧 key。确认 API/Worker 即将使用相同配置。
2. 收据轮换：把当前 key/version 放到 `REAL_MEDIA_PREVIOUS_RECEIPT_KEY` / `_VERSION`，新 key 使用新的 current version；同一版本不能对应两把 key。新写入用新 key，旧密文按自身 keyVersion 解密。
3. 供应商轮换：对应 `*_PREVIOUS_API_KEY` / `*_PREVIOUS_CREDENTIAL_VERSION` 保留旧版本，新的 current version 供新报价。更换 API key 必须更换 credential version，不能把另一把 key 悄悄写到原版本名下。恢复按原冻结版本查原任务，不偷偷换账号或供应商。
4. 当前只支持一个 previous 版本，没有批量重加密命令。再次轮换或删除旧 key 前，需单独核对仍需读取的历史收据并设计经授权的迁移/恢复方案；否则旧收据会不可读。不要修改历史输入、哈希或回执版本来规避。

## UNKNOWN、费用与资产

提交前原子写 INTENT；图片/视频有 task ID 只查询原任务。POST 超时/断连且没有 ID 时停在 UNKNOWN，不自动再发。同步 TTS/音乐靠已保存的加密输出收据恢复下载；回执遗失或输出已不可取且不能 query 时保留未知。

新的付费操作不能隐瞒同源未知任务：报价列出 uncertainJobIds，授权和实际发送前重新核对，并要求明确确认可能重复费用。确认是新授权，原 UNKNOWN 不会被改成失败或免费。取消也不能撤销已经发生的供应商处理或费用。

只写可证实的用量和 ESTIMATED；`actualCost` 保持 unknown，不能用 usage 推算成 ACTUAL 或补 ACTUAL 0。对象下载、格式/时长探测、SHA-256、S3 持久化通过后，才把 Asset 和成功 Job/Attempt/receipt 原子提交。下载/存储恢复不重新调用模型。来源或声音/选用变化按原 STALE 图传播。

## 预算内整集逐句补齐（V1-D）

batch 没有单独的付费开关，沿用声音、真实媒体、认证及原任务准入；缺 batch draft 返回不可用。它持久保存一次有界命令的回执，供应商任务和资产仍以既有 Job/Attempt/Asset 为准。入口在短剧剧本页，系列页保持禁用。

| 方法与路径（均加 `/api/v1`） | 用途 |
| --- | --- |
| `GET /projects/:projectId/episodes/:episodeId/speech-batch-plan` | 读取逐句 inventory、当前 `sourceHash` 与来源/批准/声音 blockers。 |
| `GET /projects/:projectId/episodes/:episodeId/speech-batches` | 最近最多 100 个批次回执。 |
| `POST /projects/:projectId/episodes/:episodeId/speech-batches` | 以永久 `Idempotency-Key` 提交 `{sourceHash,lineInputRevisionIds}`，冻结逐句免费报价及原输入；写回执，不调用模型。 |
| `GET /speech-batches/:batchId` | 只读原批次、逐句授权与现有 Job 状态。 |
| `POST /speech-batches/:batchId/confirm` | 确认 `frozenHash`、`maximumJobs`、按币种 `budgets`、`confirmPossibleCharges:true` 和全部 `confirmedUncertainJobIds`。 |
| `POST /speech-batches/:batchId/resume` | 空对象 `{}`，用户显式恢复原命令；沿用每句原 quote、授权及永久操作键。 |
| `POST /speech-batches/:batchId/cancel` | 空对象 `{}`，停止后续创建 Job；与 confirm 分开请求，不必等待 confirm HTTP 返回。 |

每批 1–100 句、冻结快照最多 2 MiB。inventory 最多 300 个镜头、3000 句、300 个无镜头场景，超限拒绝，不静默省略。已有有效 take 的句子标为待试听/选用，不重复付费；缺计划、声音或批准的镜头列为 blocker，其他合格句子仍可选择。

确认的 `maximumJobs` 必须等于冻结句数；各币种总额必须精确等于对应逐句 `quote.maximumAmount` 之和，不能任意报低/报高。总额是本次固定操作授权上限，不是实际账单；预估与实际未知仍分开。来源、选声、逐句输入、报价有效期、未知风险和租约在创建每个 Job 的事务内再次校验；来源变化或已出现音频/活动 Job 就停止，不能偷换输入。

响应丢失、UNKNOWN 或中断后先 GET 原回执和原 Job；刷新不会自动确认或恢复。显式 resume 使用原操作键，不能据此重发供应商无 ID 的 UNKNOWN。`dispatched` 只表示该批的本地 Job 已创建，不表示已发给供应商、生成成功或已收费。取消只阻止尚未创建 Job 的项；**已创建的 queued/运行中 Job 仍需在任务面板独立查看和取消**，不会撤销已发外部调用或既有费用。已取消/已绑定项不能重新打开，确需新付费操作须另行报价确认。

## 中文声音合成

新 profile 为 `local-ffmpeg-voice-v1`，原 `local-ffmpeg-v1` 行为不变。逐句按所选 WAV 的实测时长与停顿顺排；超出视频即拒绝，每句 speech 链不含裁切。短音频补静音，不拉伸；音乐按人声时间窗 ducking，并在最后 `min(1000ms, 视频时长)` 淡出，只作用于音乐。人声和已确认环境声不套用该 fade。默认移除原视频音轨，只有明确确认的环境声可混入。字幕以固定 textfile + `expansion=none` 渲染，不解释用户的 ASS/HTML/反斜杠控制字符串。

安装 Noto Sans CJK SC（Linux CI 使用 `fonts-noto-cjk`），或为 Worker 设置受控绝对字体路径。编码前选择精确 SC face、核对所需字符 glyph 并记录实际字体 SHA/source SHA/face index；缺字/缺字体返回 `COMPOSE_FONT_UNAVAILABLE`。业务 mix-preflight 证明的是来源与时间线，不能替代 Worker 字体预检。合成输出为 1080×1920、25fps、H.264/AAC MP4；仍需人工看画面、听完整对白后审核。

## 三个独立空库验收入口

这些 suite **会安装迁移/草案并写测试数据**，不是普通离线测试；必须另有明确的新空隔离库授权与专用 URL，不使用业务 `DATABASE_URL`。执行前会核对真实库名及空库，缺条件拒绝。下面只给入口，本轮未据此执行业务 SQL。

| suite 配置 | 必需进程变量与库名 |
| --- | --- |
| `vitest.real-media-acceptance.config.ts` | `REAL_MEDIA_ACCEPTANCE_AUTHORIZED=true`、`REAL_MEDIA_ACCEPTANCE_DRAFT_AUTHORIZED=true`、`REAL_MEDIA_ACCEPTANCE_DATABASE_NAME=ads_media_acceptance_<suffix>`、`REAL_MEDIA_ACCEPTANCE_DATABASE_URL`。 |
| `vitest.speech-acceptance.config.ts` | `SPEECH_ACCEPTANCE_AUTHORIZED=true`、`SPEECH_ACCEPTANCE_DRAFT_AUTHORIZED=true`、`SPEECH_ACCEPTANCE_DATABASE_NAME=ads_speech_acceptance_<suffix>`、`SPEECH_ACCEPTANCE_DATABASE_URL`；同一入口安装 voice 与 batch draft，包含批量新增用例。 |
| `vitest.vimax-planning-acceptance.config.ts` | `TITLE_WRITING_ACCEPTANCE_AUTHORIZED=true`、`TITLE_WRITING_ACCEPTANCE_DATABASE_NAME=ads_title_acceptance_<suffix>`、`TITLE_WRITING_ACCEPTANCE_DATABASE_URL`，另需 `VIMAX_CANDIDATE_ACCEPTANCE_DRAFT_AUTHORIZED=true` 和 `VIMAX_PLANNING_ACCEPTANCE_DRAFT_AUTHORIZED=true`。 |

每个 suffix 为 6–40 个小写字母、数字或下划线，每个 suite 使用各自全新空库。获准且设置完专用变量后，入口格式为：

```sh
corepack pnpm --filter @ai-drama/database exec vitest run --config vitest.real-media-acceptance.config.ts
corepack pnpm --filter @ai-drama/database exec vitest run --config vitest.speech-acceptance.config.ts
corepack pnpm --filter @ai-drama/database exec vitest run --config vitest.vimax-planning-acceptance.config.ts
```

普通协议/领域/组件测试与 Python 技术素材测试不需要供应商 key。Python 新声音测试为 `services/media-worker/tests/test_voice_compose.py`；实际中文字幕测试只有真实 Noto 字体可用时才运行。可设绝对 `VOICE_COMPOSE_TEST_EVIDENCE_DIR` 保存 `voice-proof.png/json`；证据注明 tone 技术素材、AI 人声质量未验证及人工视觉复核待完成。缺字体的 skip 不能写成中文渲染通过。

最终验证、Review、PR/CI 与 merge 以当前提交的实际记录为准；业务 SQL、真实模型和部署的实际执行应另记对象、SHA、次数、金额已知/未知及产物审阅结果。不要改写旧 M3/M4 的 Mock 验收报告。
