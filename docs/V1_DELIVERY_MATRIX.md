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
| 文本首接沿用千问，修复结束状态、UTF-8、单次请求和 token 参数 | 本次要求；[`PROVIDER_CONTRACTS.md`](PROVIDER_CONTRACTS.md) 禁止不确定结果进入可重放同步适配器 | `packages/providers/src/qwen-chat.ts`。`qwen:trial` 仍用 `max_tokens`；`qwen:writing` 只用 `max_completion_tokens` | `38866f7` 的 providers 测试与 CI | 真实 `--execute` 未调用 | 手写响应、假密钥、可注入 transport | 真实密钥时另计费 | 本机候选可用。Paid calls=NO |
| 故事策划与单集剧本候选可被网页导入 | 编剧契约 `ads.writing.story-plan.v1` / `ads.writing.episode-draft.v1` | `packages/providers/src/qwen-writing.ts` | `38866f7`；模拟接线 `writing-assistant-qwen-wiring.spec.tsx` | 不是网页按钮 | `parseWritingImport` 与采纳测试。采纳期间不 POST | 无 | 本机候选可用。模拟响应不是千问真实生成 |
| 网页一键调用模型 | 本次要求：没有持久化请求身份、失败恢复和重复调用规则时先设计 | 无路由、无按钮、无表 | 无 | 见 [`QWEN_WEB_INVOCATION.md`](QWEN_WEB_INVOCATION.md) | 规则确认后再做无凭据测试 | 账户、配额、查询接口均未定 | 待审查后实现。不接入 `REPLAY_SAFE_SYNC`，不替换 `MockTextAdapter` |

## 媒体、合成、导出、成本

| 需求 | 出处 | 当前代码 | 已有证据 | 尚缺 | 验收方法 | 外部依赖 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 图片、视频、配音、字幕、音乐的任务、取消、恢复、来源隔离和资产校验 | M3；[`PROVIDER_CONTRACTS.md`](PROVIDER_CONTRACTS.md) | Mock Adapter 与配置门，默认关闭 | M3 各验收报告；main 上 M3-A/M3-B | 真实商业 Adapter 与 ComfyUI 调用 | Mock 技术流程。不用固定素材宣称真实 AI | 授权、密钥、配额 | 技术验收通过。真实生成是外部待验收 |
| 单镜与集级预检、本地 FFmpeg、播放、审核、上游失效后保留历史 | M4 | `services/media-worker` 与工作台合成面板 | 收尾矩阵中的预检、单镜、集级 Run | 真实成片素材仍是 Mock/样片 | 既有合成测试与 52 阶段样片 | FFmpeg 与隔离 CI | 技术验收通过。不是真实 AI 短剧 |
| 合格成片下载与同一资产来源清单；过期或不合格来源拒绝导出 | M4 导出 | 导出路由与资格判断 | Run `37086868513`，SHA `95f4df1` | 无代码缺口 | 既有导出测试 | 无 | 技术验收通过 |
| 已记录成本查询；实际、估算、未知分开；不用 ACTUAL 0 补齐未知项 | M4 成本；商业计划 | 项目成本查询。Mock 媒体的 0 金额只表示该条 Mock 账 | Run `37091291592`，SHA `174a6bd` | 18 次本地编码没有账本行。没有确认的编码费率 | 查询测试只核对已记录行 | 费率规则未定 | 已记录成本技术验收通过。完整生产成本未验收，本轮不虚构费率 |

## 运行与明确排除

| 需求 | 出处 | 当前代码 | 已有证据 | 尚缺 | 验收方法 | 外部依赖 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 安装、构建、配置、初始化、启动、健康检查、停止 | [`DEV_RUNBOOK.md`](DEV_RUNBOOK.md)、[`README.md`](../README.md) | doctor、compose、健康检查 | 手册与 CI 中的 verify | 本轮不启动本机 Web/API | `pnpm verify` 与 doctor。未执行的启动不记通过 | Docker、专用库 | 命令已写明。本轮未拉起页面 |
| 会员、充值、支付、多租户、登录、集数参数化 | 商业计划「后续」；产品范围非目标 | 无 | 无 | 规则未定，不实现 | 不适用 | 价格、身份、商用授权都未定 | 非 V1 |
| 新增 Migration、部署、真实付费调用 | 本次权限 | 本分支不新增 migration 文件 | 相对 main 的千问差异不含 `prisma/migrations` | 网页模型表若审查通过才可能需要迁移草案 | 只比较 migration 目录 | 授权后才能执行 | 本轮 Migration=NO，Deploy=NO，Paid calls=NO |

## 本轮代码处理

已在 main 验收过的创作者界面、文本链、编剧助手、Mock 媒体、本地合成、导出和已记录成本保持原样，只做回归。

本分支带入的实现是千问共享客户端、`qwen:trial` 兼容入口和 `qwen:writing` 候选生成。候选仍由人比较、采纳到草稿，再点原来的保存。

网页付费调用停在 [`QWEN_WEB_INVOCATION.md`](QWEN_WEB_INVOCATION.md) 的待审查规则。没有无鉴权代理，也没有生成按钮。
