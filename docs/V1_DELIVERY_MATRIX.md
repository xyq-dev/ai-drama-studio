# V1 交付台账

本文件记录仓库当前 V1 的实现和验收边界。它不新增产品能力，也不把历史报告改写成新的通过结论。

依据顺序：本次交付要求，已确认的产品规则（[`PRODUCT_SCOPE.md`](PRODUCT_SCOPE.md)、[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)、[`COMMERCIAL_PRODUCT_PLAN.md`](COMMERCIAL_PRODUCT_PLAN.md)），再是模块设计。历史报告只提供证据 SHA。

起点是 `origin/main` `a6315a5eadc7bb8c14ba18f2dee85ff237fc0272`。本分支在其上保留已审查的千问候选提交，到 `38866f7abd20bfbb94b6fd085cc2f2c4b3b2fc34`。其后的台账提交以该提交的父链为准，不把 `38866f7` 的 CI 记成新提交的 CI。

状态用词：

- **技术验收通过**：Mock 或本地工具链已经按对应 SHA 验收。不是真实模型结果。
- **本机候选可用**：命令行可以生成待人工导入的候选。网页不会自动调用模型。
- **待审查后实现**：规则还没有确认，本轮不编码。
- **外部待验收**：代码或技术闭环已在，真实密钥、配额或服务器验收未执行。
- **非 V1**：商业文档列为后续，或产品范围明确排除。

## 创作者路径

| 需求 | 出处 | 当前代码 | 已有证据 | 尚缺 | 验收方法 | 外部依赖 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 首页、创作中心、真实项目工作台、空态/失败/重试、桌面与窄屏导航 | [`COMMERCIAL_PRODUCT_PLAN.md`](COMMERCIAL_PRODUCT_PLAN.md) | `apps/web` 的 `/`、`/studio`、`/projects/[projectId]`、`/preview`、`/status` | PR #42 合并 `deec35e`，界面提交 `40d87f6` | 无代码缺口 | 既有 Web 组件测试；本分支回归 `pnpm verify` | 无 | 技术验收通过。本分支不重写 |
| 新建作品只提交标题和梗概，创建失败保持同一幂等键 | 商业界面计划；M1 幂等 | `apps/web` 创作中心与 API project 创建 | 同上，及 M1-C 在 main `a6315a5` 的隔离集成 | 无 | API 集成与页面测试 | 专用数据库只在 CI | 技术验收通过 |
| 故事、三集剧本、角色、场地、场景、镜头及来源边 | [`PRODUCT_SCOPE.md`](PRODUCT_SCOPE.md)；M2 | `packages/domain` 文本链，`apps/api` studio 路由，工作台编辑器 | M2 验收文档；main 上的 M2-A/M2-C | 集数仍固定为三集。商业计划把集数参数化列为后续 | 版本、审核、STALE 测试 | 无 | 技术验收通过。不把三集限制改成可变集数 |
| 版本历史、比较、人工审核、STALE | [`VERSION_AND_STALE_RULES.md`](VERSION_AND_STALE_RULES.md) | 修订不可变；审核门；失效传播 | M2/M4 既有测试与样片闭环 `72b51b9` Run `37100980441` | 无代码缺口 | 既有领域与页面测试 | 无 | 技术验收通过 |
| 编剧助手：指令、候选、差异、采纳、本地草稿、手动保存；保留 If-Match、幂等键、409 | 编剧助手实现与 PR #43 | `apps/web/src/components/writing-assistant.tsx` | main `a6315a5`；Writing assistant API Run `37197662255` | 网页不调用模型 | 组件测试与隔离 API/Web 验收 | 专用库仅在该 workflow | 技术验收通过。保存仍是原「保存新版本」 |

## 千问文本

| 需求 | 出处 | 当前代码 | 已有证据 | 尚缺 | 验收方法 | 外部依赖 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 文本首接沿用千问，修复结束状态、UTF-8、单次请求和 token 参数 | 本次要求；[`PROVIDER_CONTRACTS.md`](PROVIDER_CONTRACTS.md) 禁止不确定结果进入可重放同步适配器 | `packages/providers/src/qwen-chat.ts`。HTTP 5xx 的 `providerResult` 为 `unknown`，保留校验后的请求 ID。`qwen:trial` 与 `qwen:writing` 共用该客户端 | 两个 CLI 规格覆盖 500/502/503/504，并断言每次操作一次请求 | 真实 `--execute` 未调用 | 手写响应、假密钥、可注入 transport | 真实密钥时另计费 | 本机规则已测。真实调用是外部待验收。Paid calls=NO |
| 故事策划与单集剧本候选可被网页导入 | 编剧契约 `ads.writing.story-plan.v1` / `ads.writing.episode-draft.v1` | `acceptPreparedCandidate` 校验最终写入 `candidate.json` 的字节，含格式化、换行和脱敏 | 回归读取实际文件再导入，并覆盖接近 48,000 字节的合法候选 | 不放宽 48,000 字节或 20,000 字限制 | 同一套 `parseWritingImport` / `formatWritingImport` | 无 | 本机候选可用。模拟响应不是千问真实生成 |
| 网页千问调用 | 审查后的六项技术决定 | 操作者门禁、发送前持久化、幂等拒绝、7 天候选和过期留审计。草案不在已执行 migration 目录。页面默认不显示请求按钮 | 假凭据与可注入 transport 测试 | 真实库表未执行，因此线上路由在发请求前停止。真实 `--execute` 未调用 | 无凭据状态测试。生产开关关闭 | 迁移执行授权；真实密钥另计费 | 规则已实现。数据库执行和真实调用是外部待验收。不接入 `REPLAY_SAFE_SYNC` |

## 媒体、合成、导出、成本

| 需求 | 出处 | 当前代码 | 已有证据 | 尚缺 | 验收方法 | 外部依赖 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 图片、视频、配音、字幕、音乐的任务、取消、恢复、来源隔离和资产校验 | M3；[`PROVIDER_CONTRACTS.md`](PROVIDER_CONTRACTS.md) | Mock Adapter 与配置门，默认关闭。分镜预览走 `image.generate` 的 preview 门。视频仍要求镜头已审核 | M3 各验收报告；preview 与视频分流的集成规格 | 真实商业 Adapter 与 ComfyUI 调用。选定参考图的视频门槛依赖未执行草案 | Mock 技术流程。不用固定素材宣称真实 AI | 授权、密钥、配额；草案执行 | 预览门已实现。真实生成和选定参考图持久化是外部待验收 |
| 角色参考图生成、选择、审核及来源 | [`PRODUCT_SCOPE.md`](PRODUCT_SCOPE.md) 审查后基线 | 领域谓词 `characterReferenceAllowed`、`videoGenerationAllowed`。SQL 草案增加 `reference_role` 与 `character_reference_selection` | 领域单测与草案文件测试 | 现行库禁止把 IMAGE 标成 APPROVED，也没有选择表。在线视频路径因此不查询该表 | 草案执行后才能做真实库验收 | 迁移执行授权 | 规则与草案已写。持久化和在线强制执行未实现，受未授权迁移阻塞 |
| 失败重试与成功结果主动重生 | 审查后基线 `bypassCache=true` | 内容端点接受 `bypassCache`。为真时更换 seed，不走 job retry。终态任务不重开 | 领域 `classifyGenerationAction` 与工作台按钮测试 | 没有按 inputHash 复用的资产缓存。`bypassCache` 只改变本次 seed 和快照标记 | 组件测试断言重生请求体 | 无 | 已实现。重生不是失败重试 |
| 每次 attempt 的输入、Provider/model、状态、错误、耗时与成本 | 审查后基线 | `presentStoredAttempt` 与工作台 AttemptList。成本缺金额、币种或类型时保持未知 | 领域与工作台测试 | 不展示原始错误正文 | 只核对已记录字段 | 无 | 已实现。未知费用保持未知 |
| 单镜与集级预检、本地 FFmpeg、播放、审核、上游失效后保留历史 | M4 | `services/media-worker` 与工作台合成面板 | 收尾矩阵中的预检、单镜、集级 Run | 真实成片素材仍是 Mock/样片 | 既有合成测试与 52 阶段样片 | FFmpeg 与隔离 CI | 技术验收通过。不是真实 AI 短剧 |
| 合格成片下载与同一资产来源清单；过期或不合格来源拒绝导出 | M4 导出 | 导出路由与资格判断 | Run `37086868513`，SHA `95f4df1` | 无代码缺口 | 既有导出测试 | 无 | 技术验收通过 |
| 已记录成本查询；实际、估算、未知分开；不用 ACTUAL 0 补齐未知项 | M4 成本；商业计划 | 项目成本查询。新的本地编码结果带 `localEncode` 耗时与资源计数，`productionCost` 金额和币种为空、状态 unknown | Run `37091291592`，SHA `174a6bd`；`test_encode_measurement.py` | 历史 18 次本地编码没有账本行。没有确认的编码费率。Windows 上 CPU/RSS 计数可以为空 | 查询测试只核对已记录行；新测量不写虚构金额 | 费率规则未定 | 已记录成本与本机耗时已测。完整生产成本未验收 |
| 合成资源限制、临时文件清理、存储生命周期 | M4 合成 | `compose_cli.py` 限制输出 64MB、时长不超过 90 秒、线程 2，并清理临时文件 | 既有合成测试 | 负载曲线没有新的生产压测 | 既有媒体 worker 测试 | 隔离 CI 的 FFmpeg | 限制与清理已在。生产负载证据仍是外部待验收 |
| 许可与 SBOM | [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) | drama-skills MIT 原文在 `third_party/drama-skills/LICENSE`，commit `c2426e03c0e7722bebcc6a488b6658dc38c65ac3` | 该文件与来源说明 | FFmpeg 实际 build、configure flags 与依赖许可证未固定 | 只引用已核验文本 | 选定 FFmpeg 构建后的 SBOM | drama-skills 已核验。FFmpeg SBOM 是外部待验收 |

## 运行与明确排除

| 需求 | 出处 | 当前代码 | 已有证据 | 尚缺 | 验收方法 | 外部依赖 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 安装、构建、配置、初始化、启动、健康检查、停止 | [`DEV_RUNBOOK.md`](DEV_RUNBOOK.md)、[`README.md`](../README.md) | doctor、compose、健康检查 | 手册与 CI 中的 verify | 本轮不启动本机 Web/API | `pnpm verify` 与 doctor。未执行的启动不记通过 | Docker、专用库 | 命令已写明。本轮未拉起页面 |
| 会员、充值、支付、多租户、登录、集数参数化 | 商业计划「后续」；产品范围非目标 | 无 | 无 | 规则未定，不实现 | 不适用 | 价格、身份、商用授权都未定 | 非 V1 |
| 新增 Migration、部署、真实付费调用 | 本次权限 | `prisma/drafts` 有两份 SQL 草案。`prisma/migrations` 仍是原来的 5 个 | 草案测试确认草案不在已执行目录 | 草案未执行 | 只比较 migration 目录 | 授权后才能执行 | Migration 执行=NO，Deploy=NO，Paid calls=NO |

## 本轮代码处理

已在 main 验收过的创作者界面、文本链、编剧助手、Mock 媒体、本地合成、导出和已记录成本保持原样，只做回归。

本分支在千问共享客户端上补了 5xx 不确定结果，以及写入 `candidate.json` 前的最终字节校验。网页调用规则见 [`QWEN_WEB_INVOCATION.md`](QWEN_WEB_INVOCATION.md)。工作台默认不显示请求按钮。路由在存储草案执行前不会发模型请求。

角色参考图的选择表和 IMAGE 审核放宽只存在于未执行草案。分镜预览门已经接到现有 `image.generate`。视频仍使用已审核镜头门槛，选定参考图的在线强制执行要等草案执行。
