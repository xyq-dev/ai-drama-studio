# 研究回答契约按资料能力拆分（2026-10-21，research.v4 / prompt.v6 / checks.v6）

设计与规则见 `docs/AI_AUTO_CREATION.md` 第 3.5 节。本文件记录这一轮的证据边界、影响范围和离线验收结果。

## 证据边界

- 线上失败：runId `d33694aa-c70c-40a3-93ae-a4a63a8ab021`，`unsourced_number@observations[0].statement:chinese_numeral+unsourced+not_in_cited_excerpt`。
- 被拒原文没有保存，原句不知道；本轮不猜测具体内容，也不断言模型编造了统计。
- 本轮没有扩充数字或自然语言词表，也没有增加付费语义裁判。改的是契约：资料有限时，模型不再写需要市场来源的字段。

## 两种契约与实际回答字段

| 模式（只看本任务已保存的 `sources.researchMode`） | 模型回答字段 | 服务端写入 |
| --- | --- | --- |
| `limited`（没有符合条件的近期市场资料；仍可读写作方法和用户资料） | `schema`、`hypotheses`（假设 + 验证计划）、`audience.primary / viewingNeeds / emotionalAppeals`、`contentStructure`（方法参考 + 本剧应用）、`opportunities` | `facts=[]`、`observations=[]`、`audience.basis="hypothesis"`、`audience.sourceIds=[]`、`serverRecord`（含 `marketEvidence.status="unavailable"`、`executedWith.answerContract="limited"`）、`unverified` |
| `sourced`（有符合条件的近期市场资料） | 与 research.v3 相同：另含 `facts`、`observations`、`audience.basis / sourceIds` | `serverRecord`（`marketEvidence.status="available"`）、`unverified` |

- limited 回答里出现 facts、observations、audience.basis、audience.sourceIds、服务端字段或任何未定义字段，即使是空值也会整份拒收：`invalid_output@<字段>:unrecognized_keys+limited_contract+forbidden_field`。不会先接受再删改，被拒正文不保存，不自动重试。
- 提示、实际发送的 JSON Schema（`autoCreationJsonSchema(kind, n, mode)`，Schema 名分别为 `auto_research_limited` / `auto_research_sourced`）、Zod 校验和服务端组装都用同一个模式。没有有效快照时，在预约前停止（`research_sources_missing`），不默认按 sourced 处理。
- 来源、连续引文、数字边界、application 检查、冻结约束和 no_role 未核实提示都保持原来的严格程度。

## 影响范围

- contracts：research v4 常量、两份回答 Schema、组装函数、按模式生成的供应商 JSON Schema、v3 历史常量和类型，以及 `autoResearchHasServerRecord` / `autoResearchMarketEvidence`。
- domain：按模式生成研究提示；选题提示只列实际存在的研究编号；拒收诊断；服务端记录；Markdown/JSON 文案。
- providers：引擎按已保存快照选择 Schema，没有快照时不预约；续跑检查；模型替身按提示里的契约作答。
- api：续跑拒绝码 `AUTO_CREATION_RESEARCH_SOURCES_MISSING`。
- web：运行页和开始页文案，统一为「AI 创作策划」「受众待验证」「市场证据不可用」/「有可读取的市场资料」；v3 研究不再误进 v1/v2 分支。
- 单集正常流程仍是六次调用；预算、日限额、并发、预约、租约、取消、幂等、结果未知的恢复、DRAFT 与人工审核门槛都不变。Migration 编写 0、执行 0。

## 离线验收（全部为模型替身，合成样本）

| 项 | 结果 |
| --- | --- |
| A 实际请求契约 | 捕获引擎发给 OpenAI / Claude / DeepSeek 的请求体：limited 的 Schema 与 `autoCreationJsonSchema(…,"limited")` 相同（Claude 经适配器转换），任一路径都不含禁止字段，键结构与 Zod 一致；提示的指令部分不出现 facts / observations / basis / sourceIds / F1 / O1。sourced 的请求体带完整的引用契约 |
| B 四种资料组合 | 无市场源但有写作方法 → limited，保留方法引用；没有任何可读资料 → limited，结构全部为自主设计；开启读取但市场页失败 → limited；合法近期市场页 → sourced，保存事实与引文 |
| C limited 完整流程 | DeepSeek，1 集、60 秒、0 轮、预算 6：六阶段、六次调用、故事保存为 DRAFT，方法引用保留；两个驱动并发也不重复发送；Markdown 与 JSON 多次生成一致；浏览器中离开页面后任务继续完成，刷新后 Markdown 与 JSON 下载一致 |
| D 拒收 | 注入 facts / observations / audience.basis / audience.sourceIds、整份 sourced 形态、伪引用、明确统计、冻结冲突：每种只发送 1 次，之后不再发送，被拒正文不保存 |
| E sourced 对照 | 合法事实保存；伪造引文与无来源数字照旧拒收 |
| F 历史兼容 | v3 研究原样读取、显示、导出，服务端记录不标成 AI 复述，不补造市场证据；续跑不重发已完成的研究；v1 / v2 / v4 / v5 原键重放零新建、零发送；旧任务的研究按新契约续跑并记录实际版本，冻结输入与哈希不变；预算不足时不续跑、不重置 |
| G 回归 | 现有预算、幂等、结果未知、人工审核测试全部保留并通过 |
| 单元 | contracts 66、domain 758、providers 306、web 728、api 315（另 87 跳过） |
| PostgreSQL 16（embedded，一次性库） | 测试站组合、基础七个、含拆解三种起点各 38/38 |
| 真实浏览器 | 8/8（Chrome + 构建后的 Web + 真实 API + 一次性库 + 替身；1280 / 390、下载、刷新；新增 B5 limited 契约拒收页面说明） |

离线通过**不代表真实模型必然成功**。真实模型是否只写 limited 的五个字段、是否会在创作文字里写出会被拒收的数字，需要合并部署后做受限的真实验收。本轮真实模型调用 0 次，媒体调用 0 次。
