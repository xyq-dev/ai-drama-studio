# 时长按所指对象区分（2026-10-21，prompt.v7 / checks.v7）

设计与规则见 `docs/AI_AUTO_CREATION.md` 第 3.6 节。本文件记录这一轮的证据边界、影响范围和离线验收结果。

## 证据边界

- 线上失败：runId `1af794d3-5a55-4a8b-b64b-d1f18a5b06ff`，`unsourced_number@hypotheses[0].statement:digits+market_statistic+viewing_duration`。
- 被拒正文没有保存，**线上原句仍不知道**；本轮不猜测原句。下文全部是合成样本。
- 修复前复现（main b804437，完整 `validateAutoStageOutput("research", …)`，limited，1 集 60 秒）：

| 合成样本 | 修复前 | 修复后 |
| --- | --- | --- |
| 待验证观众是否喜欢本剧60秒的紧凑叙事。 | `digits+market_statistic+viewing_duration` | 通过（A：本剧篇幅，等于冻结时长，无提示） |
| 观众可能愿意看完本剧60秒的故事。 | `digits+market_statistic+viewing_duration` | 通过（A） |
| 待验证：观众能否在60秒内理解人物冲突。 | `digits+market_statistic+viewing_duration` | 通过，原文保留，服务端提示 `duration_unconfirmed`（C） |
| 观众是否会在前3秒被吸引。 | 通过 | 通过（开场时刻，无提示） |

- 新增 `packages/domain/src/auto-creation-duration.spec.ts`（42 项）在修复前 26 项失败，修复后 42 项通过。

## 误拒原因

提到观众或市场的分句不移除冻结设定里的数字（这是为了让「每天观看60秒」在 60 秒任务里仍算统计），所以这些句子里的 60 秒进入时长判断；旧规则在观众分句里只放行「前 / 开头 / 开场」后的秒数，其余一律判为 `viewing_duration`，没有区分时长指的是本剧还是观众的观看行为。

## 三类时长与边界

- **A 本剧篇幅**：紧跟指本剧的词（本剧、本集、这部剧、全剧、单集、每集…）。按冻结设定检查：相等通过，超过为 `frozen_conflict+over_length`，变短为 `frozen_conflict+length_changed`。数值相等不单独构成豁免：不指向本剧的 60 秒照样走 B/C；观众分句仍须写明待验证。
- **B 观看时长 / 测量结果（硬拒）**：习惯或多数说法（通常、一般、大部分…）、时长前的观看动词（观看、看了、停留…）、时长后的离开（后退出、就划走…）为 `market_statistic+viewing_duration`；平均值、频次与已得结果照原规则拒收（`rate_or_average`、`measured_result`）。写成「假设」「计划」「可能」不豁免。
- **C 无法确认（未核实提示）**：不属于 A、B 或开场时刻，分句写明待验证且不超过冻结时长。只在无来源创作字段（hypotheses statement / howToVerify、application pattern / why、opportunities、方向 differentiation / difficultyNote）保留并提示 `unclassified+duration_unconfirmed`；没有来源的 audience 与 audienceFit 没有提示出口，C 在那里以同一诊断拒收。提示不让检查提前结束，之后的统计、实测结果或冻结冲突仍整份拒收。

## 影响范围

- domain：`auto-creation-numbers.ts` 观众分句里的时长判断与「每集 + 时长」不当频次；`creativeNumber` 按子规则生成提示；研究提示数字规则第 2 条（prompt.v7）；身份说明。
- contracts：`AUTO_CREATION_PROMPT_VERSION` v7、`AUTO_CREATION_CHECKS_VERSION` v7（v6 保留在历史版本联合类型里）；`AutoUnverifiedNotice` 增加 `duration_unconfirmed` 及其 note；`autoUnverifiedHeading`（全是 no_role 时标题与旧版相同）。
- web：提示列表标题；`length_changed`、`duration_unconfirmed` 的拒收说明；`viewing_duration` 说明更具体。
- providers：模型替身增加 `durations` 计划（合成样本）。
- 研究回答结构不变（research.v4），limited 仍只回答五个根字段；没有新增调用、重试、裁判或回退；预算、限额、并发、预约、租约、幂等、未知调用恢复、DRAFT 与人工审核门槛不变。Migration 编写 0、执行 0。

## 离线验收（全部为模型替身，合成样本）

| 项 | 结果 |
| --- | --- |
| 完整校验（domain） | 三条样本、前 3 秒、A 相等 / 超过 / 变短、不同冻结时长（45 / 90 / 120 秒）、B 明确观看时长 / 平均值 / 实测（含「假设」「计划」前缀与等于冻结值）、C 之后同分句 / 同句 / 后续字段夹带统计仍拒、四个创作字段与有效引用 / null 引用、无来源 audience、sourced 契约对照、提示文字 |
| 完整引擎流程（providers） | DeepSeek 替身，1 集、60 秒、0 轮、预算 6：六阶段各发送一次，故事 DRAFT；研究原文保留，H2 有一条 `duration_unconfirmed` 提示；选题提示以未核实提示带上它；Markdown 与 JSON 两次生成一致，JSON 与存储相同；`executedWith` 为 prompt.v7 / checks.v7 |
| 拒收对照 | 「观众通常观看60秒后退出」：只发送 1 次，`unsourced_number@hypotheses[0].statement:digits+market_statistic+viewing_duration`，之后维护与再驱动零发送，被拒正文不保存 |
| 历史兼容 | 旧 no_role 提示与旧诊断照原样读取显示（页面与 Markdown 标题不变）；v1 / v2 / v4 / v5 / v6 原键重放零新建、零发送；已完成研究续跑不重发 |
| 单元 | contracts 66、domain 800、providers 308、web 729、api 315（另 87 跳过）；`pnpm verify` 通过 |
| PostgreSQL 16（embedded，一次性库） | 测试站组合、基础七个、含拆解三种起点各 41/41（新增时长完整流程、明确观看时长拒收、v6 原键重放） |
| 真实浏览器 | 8/8（Chrome + 构建后的 Web + 真实 API + 一次性库 + 替身，1280 / 390） |

## 仍有歧义

判断按措辞，不理解语义：A 只认紧挨着的本剧指代词（「这个故事的 60 秒」不算 A）；B 的习惯词与观看动词是有限列表，没列出的观看说法若写明待验证会成为 C 提示而不是拒收；多集任务里「本剧 60 秒」可能指单集或全剧，两者都按冻结值接受。离线通过**不代表真实模型必然成功**：真实模型的写法需要合并部署后的受限真实验收确认。本轮真实模型调用 0 次，媒体调用 0 次。
