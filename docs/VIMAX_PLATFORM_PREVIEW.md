# ViMax E2-A：工作台单场景只读预览

状态：E2-A 只读预览已实现。本页保留早期局部保存设计，[E2-B 持久候选与两段式保存](VIMAX_CANDIDATE_PERSISTENCE.md)代码已实现，业务库 SQL 草案尚未执行。完整 E2 **尚未完成**，也未运行上游 ViMax 或真实模型。E1 与原有整集拆解保持兼容。总路线见 [ViMax 评估](VIMAX_SCRIPT2VIDEO_EVALUATION.md)。

## 已交付范围

在短剧工作台所选集的剧本页展开「单场景分镜预览」，读取当前批准的剧本与当前角色，导入人工准备的分镜方案，再显式点击「校验并预览」。页面对照原场景与逐镜景别、构图/运镜、动作、对白、角色、预计时长、首尾帧文字和机位视觉参考顺序。结构通过后仍需要人工核对叙事、可拍性、竖屏构图和风格。

预览没有保存、批准、生成媒体或启动任务的权限。每个响应固定 `writeAllowed:false`、`modelCalls:0`、`persisted:false`；导入和预览不会预约调用或产生费用记录。不把无网络预览称为预算、租约、恢复或付费供应商验收。

只在非 production 环境提供接口。系列（1–60 集文本）拒绝此入口，系列媒体限制不变。仅调用本页两条 E2-A 接口不会持久化候选，重新打开预览需重新导入。另行显式保存、候选找回及未确认写请求的临时身份恢复属于 [E2-B](VIMAX_CANDIDATE_PERSISTENCE.md)，不改变本页接口的只读语义。

## 交互与接口

所有路径位于 `/api/v1`，沿用站点登录、工作区隔离和 POST 的 CSRF 校验。没有模型密钥或付费操作者令牌输入，因为预览不向外发送内容。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/projects/:projectId/episodes/:episodeId/vimax-preview/source` | 返回当前批准且 CURRENT 的剧本正文、原始正文 SHA-256、版本与当前角色身份；不写入 |
| POST | `/projects/:projectId/episodes/:episodeId/vimax-preview` | 重新读取服务端来源，核对导入方案的冻结身份，严格验证单场景候选并返回只读报告；不写入 |

源读取使用 `REPEATABLE READ READ ONLY` 事务，project、episode、script、character 均限制为当前服务器工作区和作品。快照的一致性只覆盖读取事务：请求结束后来源仍可能变化，不产生锁定、审批或保存凭证。手动刷新来源或编辑来源后，旧预览不能被当作当前有效结论；必须重新校验原方案，不把其中的旧身份自动改成新版本。

来源不存在、不属于作品、未批准、已过期、正文格式/长度不支持、角色集合超限或存在不可用角色时明确阻断。角色 key 由固定排序生成；请求的 key、角色 ID、修订 ID、名字及集合顺序都必须与本次服务器快照一致。后台换名、换版、新增或移除角色均需重新准备方案。场景与对白偏移仍使用 UTF-16 `[start,end)`，支持格式与保真规则沿用 E1；同名人物必须由明确身份消歧。

## 独立平台契约

契约在 `packages/contracts/src/vimax-platform-preview.ts`。平台输入使用 `ads.vimax-platform-input.v1` 与 `sourceKind:workspace`，不会把真实作品标为 synthetic/redacted。E1 的输入、报告和成功标志都不能作为平台请求或写入授权。

| 契约 | 内容 |
| --- | --- |
| `ads.vimax-platform-source.v1` | 服务器返回作品/集、当前批准剧本身份与正文、原始正文哈希、当前角色快照 |
| `ads.vimax-platform-preview.request.v1` | `source` 冻结身份；明确 `sceneSpans`、唯一 `selectedSceneKeys`、逐句 `sourceDialogue`、`requirements`；原始 `candidate` 与人工 `supplements` |
| `ads.vimax-platform-preview.report.v1` | 严格校验结果、固定诊断、候选来源哈希、原文与分镜对照；始终不可写 |
| `ads.vimax-platform-preview.response.v1` | 当前源快照、报告、服务器核验时刻、零模型调用与未持久化声明 |

请求不接受调用方提交的工作区、项目/集号、正文或批准/当前标志。源正文只来自数据库。`script_revision.content_hash` 是现有内容结构哈希，与这里的原始正文 UTF-8 SHA-256 不同；这里从 `{text}` 重新计算，保留原始换行。

导入上限为完整 JSON 的 **300 KiB**，与现有 API JSON body limit 一致；各部分继续受 E1 的 256 KiB、深度、节点和数量上限限制。页面严格校验响应契约、作品/集及请求来源，不把不完整的 HTTP 200、其他作品或旧请求响应当作成功。切作品/集、收起或卸载时取消读取并丢弃迟到结果。

来源模板只帮助填写请求，不是可直接执行的完整候选。必须明确补齐场景范围、逐句来源、候选和镜头补充；不会从声音描述猜测台词或用占位内容冒充模型产出。首尾帧和 `audio_desc` 都只是文字意图；不能当作图片或对白保真证据。

## E2-B 局部保存设计（早期设计记录）

以下为 E2-A 阶段的设计记录；当前实现与 SQL 草案前置条件以 [E2-B 文档](VIMAX_CANDIDATE_PERSISTENCE.md) 为准。独立数据结构不借用 title 运行类型、整集拆解关系表、24 小时 HTTP 回执或任意事件 JSON 充当长期仓库。E2-B 已编写草案，隔离验收的实际执行记录以 [接续记录](VIMAX_E2B_PROGRESS.md) 为准；业务库未执行。

1. 新候选记录冻结服务器工作区/操作者、请求键及请求哈希、源剧本/角色/目标场景版本、输入与候选哈希、严格版本化候选/补充/报告和永久保存状态。首尾帧、机位树等只留在该明确契约中，不塞入 `camera`。独立镜头映射以 `(candidate_id,shot_index)` 唯一，记录创建的 shot/revision ID，提供永久去重。
2. 首个保存范围只允许已有的单个目标场景，且没有活动镜头。冻结 `sceneId/currentRevisionId/rowVersion`、`ordinal` 与 `locationRevisionId`。有人工镜头或版本变化时阻断，不覆盖、不归档、不自动补齐整集。
3. 在既有工作区任务 advisory 锁之后，按候选 → project → episode → scene → shots 的顺序锁定，复核剧本仍当前/已批准/CURRENT、角色及目标版本未变。与同集整集拆解冲突时零写入。来源复核、场景修订、永久状态和回执在同一事务提交。
4. 调用现有 `createSceneRevisionInTransaction` 为该稳定 scene ID 创建新草稿，保留序号和地点引用，沿用 STALE 传播。其他场景、镜头、来源边与媒体不变；不能调用 `saveBreakdown` 的整集替换路径。
5. 人工批准候选创建的精确场景修订之后，才用 `createShotScopedInTransaction` 和角色引用方法写入镜头草稿。人工改动、新增镜头、角色变化或剧本变化一律阻断，不用 `acceptSceneChanged` 放宽首版边界。镜头仍需现有人工审核。
6. 原键同内容重放先返回永久回执，随后发生的来源变化不导致重建或再次写入；同键不同内容返回 409。HTTP 回执仅加速，不能作为唯一永久去重依据。

保存验收须证明：单场景作用域、其他场景与独立媒体不受影响、并发/重复回执只写一次、源变化零修订、未批准场景零镜头、人工镜头不覆盖、旧协议回放不变、页面刷新可恢复候选，以及 1280px/390px 页面表现。这些是设计阶段提出的要求，当前实际验证见 [接续记录](VIMAX_E2B_PROGRESS.md)。

后续 E2 的受控替身发送还须单独覆盖预算不足零发送、隐式重试阻断、预约/提交/保存前来源重检、取消、过期执行者、未知结果恢复；E3 才是另行授权的真实单场景文本试验。

## 验证范围

领域回归覆盖独立来源种类、旧 E1 契约不变、对白/身份/机位/原文哈希严格拒收、不可执行的非 JSON 输入。数据库与 API 测试覆盖只读源快照、作用域、源变更、production/series 阻断、零写入/调用。页面测试覆盖导入失败、阻断/正常方案、来源失效、切换后迟到响应和不可信回执。真实 PostgreSQL、浏览器与 CI 的实际执行状态以对应 PR 的精确提交记录为准，不以测试文件存在记为通过。
