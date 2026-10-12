# 剧本拆解：按真实剧本生成场景与分镜（R2，文字层）

本轮只做文字层：AI 读取某一集已批准的剧本版本，拆出场景和镜头文字稿。不接入图片、视频或配音供应商，也不产生任何成片。文中的“预计时长”是写作计划，不是实测成片时长。

## 1. 先确认可复用的结构（不新增重复模型）

| 需要 | 已有结构 | 本轮做法 |
|---|---|---|
| 场景的稳定标识、顺序、来源 | `scene`（稳定 ID）、`scene_revision`（不可变，`ordinal`、`heading`、`time_of_day`、`summary`、`source_script_revision_id`） | 直接复用。`summary` 即“场景描述” |
| 镜头的稳定标识、顺序、来源 | `shot`、`shot_revision`（不可变，`ordinal`、`shot_type`、`camera`、`action`、`dialogue`、`prompt_text`、`source_scene_revision_id`） | 直接复用。新增一列 `planned_duration_ms`（预计时长，整数毫秒） |
| 镜头引用角色 | `shot_character_reference`（数据库触发器要求角色版本为当前且未过期，镜头版本为草稿） | 直接复用 |
| 编辑保存为新版本、If-Match、幂等 | 场景/镜头修订接口和工作台编辑表单 | 直接复用；镜头表单增加“预计时长（秒）”。未填与显式 `null` 都表示没有预计时长，请求身份不含该字段，与增加字段前记录的幂等回执一致；填写的时长计入身份 |
| 源剧本修改后的失效 | `staleFromScript`：场景整版依赖剧本，新剧本版本成为当前版本时，旧场景和其镜头标为 `STALE` | 直接复用，不新写失效逻辑 |
| 付费模型调用、额度、取消、租约恢复、结果未知不重发 | 标题创作的 `title_writing_run / step / call / resume` 与 `TitleWritingEngine` | 复用：新增运行种类 `script_breakdown`，只有一个步骤 `breakdown` |
| 模型配置、操作者令牌、开关 | `TITLE_WRITING_ENABLED`、`X-Operator-Token`、服务端模型白名单 | 直接复用，没有新的模型入口 |

### 1.1 关键约束与取舍：镜头必须等场景批准后才写入

现有规则（`createShotScopedInTransaction`，并有集成测试 `scene-shot-api.integration.spec.ts` 断言）：**新镜头只能挂在当前且已批准的场景版本下**。如果一次生成就把场景和镜头都写成草稿，就要放宽这条规则。

本轮**不放宽**，改用与“故事批准后才写入分集剧本”相同的两段式：

1. 拆解结果先写入场景草稿；镜头方案保存在这次任务的结果里（可查看，不可编辑）。
2. 创作者审核并批准场景后，点“写入镜头”，系统把该场景的镜头方案写成镜头草稿。之后镜头可以按现有方式编辑、审核。

这样 AI 不替人审核，也不绕过任何现有门槛。代价是：镜头要在场景批准之后才能编辑。

## 2. 数据结构

### 2.1 冻结输入 `ads.script-breakdown.input.v1`（存于 `title_writing_run.input_json`）

```ts
{
  schema: "ads.script-breakdown.input.v1",
  promptVersion: "ads.script-breakdown.prompt.v1",
  episodeId, episodeNo,               // 所选集
  scriptRevisionId, scriptRevisionNo, // 冻结的剧本版本
  scriptContentHash,                  // 该版本的内容哈希
  scriptText,                         // 该版本正文的副本：提示词只从这里构建，不再读数据库
  targetEpisodeSeconds,               // 作品的每集目标秒数，没有记录时为 null
  characters: [{ key: "C1", characterId, revisionId, name }], // 冻结时的当前角色版本，最多 30 个
  replace: { scenes: [{ sceneId, rowVersion }], shots: [{ shotId, rowVersion }] }, // 冻结时本集现有的场景和镜头
  providerKey, model,                 // 服务端白名单解析后的供应商和模型
}
```

- 请求身份：`title_writing_run (workspace_id, actor_id, idempotency_key)` 唯一。
- `input_hash` 是**请求**的哈希（作品、集、供应商、模型、是否替换），不是冻结内容的哈希。这样同一个键在剧本变化后重放，仍返回原任务，而不会被当作冲突或建出第二个任务。冻结内容另存于 `input_json`。

### 2.2 模型输出 `ads.script-breakdown.output.v1`

```ts
{
  schema: "ads.script-breakdown.output.v1",
  episodeNo,                                        // 必须等于所选集
  scenes: [{ key: "S1", heading, timeOfDay, description }],
  shots: [{
    key: "S1-1", sceneKey: "S1",
    shotType,            // 景别
    camera,              // 镜头描述：机位、构图、运镜
    action,              // 动作
    dialogue: [{ speaker, line }], // 对白
    characterKeys: ["C1"],         // 引用冻结角色
    plannedSeconds,                // 预计时长（秒，整数）
  }],
}
```

`key` 只是这次结果内部的临时标识，用于校验引用；写入数据库时一律由服务端分配 UUID，不会覆盖任何已有标识。场景键必须依次为 `S1`、`S2`……；镜头键必须是“所属场景键-该场内序号”，从 1 连续编号。例如放在 `S1` 下的 `S2-1`、跳号或顺序颠倒都会被拒绝（`invalid_output`），不改名、不重新编号。

### 2.3 有限范围（页面同样显示）

| 项 | 范围 | 依据 |
|---|---|---|
| 输入剧本正文 | 1–20,000 字 | 与剧本编辑器正文上限 `WRITING_BODY_MAX_CHARS` 相同 |
| 冻结角色 | 0–30 个 | 提示词长度可控；超出时拒绝启动 |
| 每集场景 | 1–8 场 | 方案文档：60 秒约 2–4 场，90 秒约 3–6 场 |
| 每集镜头 | 1–20 镜 | 约 5 秒一镜：90 秒约 15–20 镜；单次输出上限 4,096 tokens |
| 每场镜头 | 1–8 镜 | 每场至少 1 镜 |
| 单镜预计时长 | 2–10 秒 | 方案文档建议 3–8 秒，前后各留 1 秒；数据库列允许 1–15 秒 |
| 全集预计时长合计 | 5–180 秒 | 不超过目标上限 90 秒的两倍；与目标的差距只显示，不拒收 |
| 文本字段 | 标题 ≤40、时间 ≤20、场景描述 ≤200、景别 ≤20、镜头描述 ≤80、动作 ≤120、说话人 ≤20、每句台词 ≤120、每镜 ≤4 句 | 控制输出长度，避免截断 |

这些字段和数量上限不保证整个答案一定装进 4,096 tokens。接近上限的镜头或对白可能被截断；截断时拒收，不能将其标为完整分镜，也不会自动追加调用。真实供应商的通过率尚未验收。

对白按“说话人 + 原话”成对校验，不能只因名字和句子分别出现在全文中就认为归属正确。支持同一行的 `姓名：对白`、英文冒号、首尾引号、姓名后的括号表演提示及明确标注的旁白；单独的说话人标签后只接受紧接下一行的完整引号对白。不对无标注散文或任意跨行内容猜测归属，不把动作说明当作对白。剧本存储和编辑格式不被自动改写；输出无法与上述明确标注对应时拒收。

### 2.4 数据库（Migration `20261012000100_script_breakdown`，只扩展）

- `title_writing_run`：
  - 新增 `run_kind`（默认 `'title'`，可选 `'script_breakdown'`）、`episode_id`、`source_script_revision_id`、`breakdown_save`（`pending | saved | source_changed | conflict`）。
  - CHECK：拆解任务必须有这三列，标题任务三列必须为空。
  - 外键：`(source_script_revision_id, episode_id, project_id, workspace_id)` 指向 `script_revision`。
- `title_writing_step`：
  - `step_key` 允许 `'breakdown'`；
  - “只有分集步骤有 `script_save`”的 CHECK 把 `breakdown` 也列为没有 `script_save` 的步骤。
- `shot_revision`：
  - 新增 `planned_duration_ms integer NULL CHECK (1000..15000)`；
  - 不可变触发器函数把新列纳入比较。
- 新表 `script_breakdown_scene`：
  - 字段：任务、场景键、顺序、写入的场景和场景版本、镜头写入状态（`pending | saved`）、写入镜头时依据的场景版本。
  - 主键 `(run_id, scene_key)`。
  - 外键分别指向 `title_writing_run` 和 `scene_revision`。
- 已有数据：一行都不改写。旧任务的 `run_kind` 取默认值 `'title'`。

## 3. 接口

全部在 `/api/v1` 下，沿用站点登录、CSRF 和工作区隔离。启动和续跑需要 `X-Operator-Token` 与 `Idempotency-Key`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/writing/script-breakdowns/options` | 开关、存储是否就绪、可用模型、上限 |
| POST | `/projects/:projectId/episodes/:episodeId/script-breakdowns` | 启动。请求体 `{ providerKey?, model?, replaceExisting? }`。见下方“启动条件” |
| GET | `/projects/:projectId/episodes/:episodeId/script-breakdowns/latest` | 本集最近一次拆解任务，没有时为 `null` |
| GET | `/projects/:projectId/episodes/:episodeId/script-breakdowns/:runId` | 某次任务 |
| POST | `…/:runId/cancel` | 请求取消 |
| POST | `…/:runId/resume` | 续跑。结果未知的调用必须由用户逐个确认，规则与标题创作相同。冻结的剧本已被取代、当前版本未批准或已过期时返回 409 `SCRIPT_BREAKDOWN_SOURCE_CHANGED`，不续跑、不预约、不发送 |
| POST | `…/:runId/shots` | 写入镜头。请求体 `{ acceptSceneChanged? }`。只处理已批准的场景，可重复调用 |

**启动条件**（全部在发出任何调用之前检查）：

1. 开关已开启，令牌正确，存储就绪（标题创作表和本轮迁移都在）。
2. 同一个键重放时，直接返回原任务，不重新冻结；键相同但请求不同时返回 409。请求身份按调用方实际提交的内容计算（未填的供应商、模型记为未填），在解析当前默认值和检查供应商配置之前比对。因此管理员更换默认供应商或模型、原供应商不再可用时，原请求的重放仍返回原任务；新请求按当前配置校验。
3. 本集当前剧本存在，是已批准、未过期的版本（沿用“剧本门槛”）。否则返回 409 `SCRIPT_REVIEW_REQUIRED`。
4. 剧本正文是 `{ text }`，长度不超过 20,000 字；角色不超过 30 个。
5. 本集已有场景时，必须带 `replaceExisting: true`，否则返回 409 `BREAKDOWN_EXISTING_SCENES`。
6. 最近 24 小时至少剩 1 次调用额度；同一作品没有其他进行中的 AI 任务；工作区进行中的任务数没有超过上限。

## 4. 状态流转

```text
启动 ──► running ──(一次调用，严格校验)──► 保存
   │         │                               ├─ 保存成功：breakdown_save=saved，任务 completed
   │         │                               ├─ 源剧本已变或引用角色已变：source_changed，任务 needs_attention，结果保留但不写入
   │         │                               └─ 本集场景/镜头在任务期间被改动：conflict，任务 needs_attention，结果保留但不写入
   │         ├─ 输出无效、截断、错误集号、缺引用、重复标识：步骤 rejected，任务 failed（不自动重发）
   │         ├─ 结果未知：步骤 unknown，任务 needs_attention（确认后才可续跑）
   │         ├─ 预约调用时冻结的剧本已不是本集当前、已批准且未过期的版本：不预约、不发送，任务 needs_attention（breakdown_source_changed）
   │         └─ 取消：发送前取消则不发送；已发送的调用如实记录
```

- **保存成功**：在一个事务中依次完成：
  1. 在项目锁下复核来源和冻结的场景/镜头集合；
  2. 把冻结的旧场景、旧镜头归档（不删除，历史版本仍可查看），并用现有失效逻辑把依赖它们的媒体标为 `STALE`；
  3. 按结果新建场景草稿，写入对应关系表。
- **写入镜头**：只处理“当前且已批准”的场景：
  0. 在项目锁内确认冻结的剧本仍是本集当前、已批准且未过期的版本；来源变化则拒绝整次写入。`acceptSceneChanged` 不能授权把旧剧本的镜头挂到新剧本。
  1. 已批准的场景版本与这次 AI 写入的版本相同时，直接写入镜头草稿、预计时长和角色引用。
  2. 场景版本被人改过时，需要 `acceptSceneChanged: true`，且批准场景的来源仍必须是冻结的同一份剧本，否则不写入。
  3. 被引用的角色版本已不是当前版本时，这个场景不写入。
  4. 已写入的场景不会重复写入。
  5. 尚未导入镜头的场景已有人工镜头时，保留人工内容并跳过该场景，其他无冲突场景继续写入。不会覆盖或混入人工镜头，也不会因同序号的数据库错误回滚全部场景。
- **续跑与发送前的来源复核**：续跑准备和每次调用预约，都在同一事务内、按“任务 → 作品 → 集”的锁顺序复核冻结的剧本仍是本集当前、已批准且未过期的版本。来源已变时，续跑返回 409，预约返回 `source_changed`，都不写入续跑记录、不增加调用次数、不发送。剧本保存和审核持有作品锁时，复核会等它提交后再判断。预约之后到网络发送之间不持有锁；这段时间内的来源变化仍由保存时的复核拦下（`source_changed`）。不会自动换成新剧本、自动审核或改写旧任务的冻结输入。
- **迟到结果**：被收回租约的执行者，其回写会被丢弃，调用记为结果未知。结果只按冻结来源保存：来源变了就是 `source_changed`，不会写入，更不会被标为当前可用。
- **剧本修改后**：新剧本版本成为当前版本时，现有逻辑把旧场景和镜头标为 `STALE`。页面显示来源剧本版本号、当前版本号和“需要重新生成”，不自动发起任何调用。
- **浏览器请求身份**：启动、续跑在发送前把幂等键及固定请求参数保存在当前标签页的 sessionStorage，按作品与集区分；不保存操作者令牌、密钥或剧本。网关错误、断连及不完整回执都保留身份，刷新后只能显式确认原请求；不能保存身份时不发送。曾经结果未知的请求随后遇到鉴权拒绝，也不换键。
- **浏览器状态**：切集后旧请求不回写新集；读取串行并合并补读，终态停止自动轮询。取消的旧回执不覆盖较新的终态；工作台编辑或审核来源后，即使任务已结束也会补读来源状态。

## 5. 界面

在工作台某一集的剧本页，剧本编辑区下方增加“AI 拆解场景与分镜”面板：

- 显示当前剧本版本及是否已批准；未批准时，按钮不可用，并说明原因。
- 显示本轮的范围上限和“预计时长不是成片时长”的说明。
- 显示所用模型、调用次数上限和“费用未知”。
- 本集已有场景时，必须勾选“用新结果取代本集现有场景（旧版本保留）”才能启动。
- 进行中时显示状态，可以取消。结果未知时，逐个确认后才能续跑。
- 完成后：
  - 列出场景：标题、时间、描述、审核状态和是否过期。点击可以打开现有的场景编辑页修改或审核。
  - 每个场景下列出镜头方案：景别、镜头描述、动作、对白、角色、预计秒数。
  - 显示预计合计秒数，以及作品的目标秒数。
  - 场景批准后可以“写入镜头”；写入后，镜头可以打开编辑页修改和审核。
- 来源剧本已不是当前版本时，明确提示“来源剧本已更新到第 N 版，以下场景/分镜需要重新生成”。旧结果保持可见，不会自动重新生成。

## 6. 不在本轮

- 图片、视频、配音、合成，以及任何真实媒体供应商。
- 跨集自动改写、全片自动编排、只重做某一场或某一镜。
- 剧本台词级的细粒度来源边：当前剧本是纯文本 `{ text }`，场景整版依赖剧本，剧本一改，本集场景就全部失效。
- 新手五步流程仍使用原来的“一场一镜”模板，没有切换到 AI 拆解。

## 7. 实现位置

| 层 | 文件 |
|---|---|
| 契约 | `packages/contracts/src/script-breakdown.ts`（冻结输入、输出 schema、范围、视图）；`title-writing-store.ts`（运行种类、存储接口） |
| 领域 | `packages/domain/src/script-breakdown.ts`（提示词、严格校验、对白比对、镜头文本） |
| 引擎 | `packages/providers/src/title-writing-engine.ts`（同一引擎驱动两种运行；内存存储）；`script-breakdown-run.ts`（新建运行、请求哈希、视图） |
| 数据库 | 迁移 `20261012000100_script_breakdown`；`title-writing-store.ts`（冻结读取、保存、写入镜头）；`text-chain.ts`（归档、角色引用、`planned_duration_ms`） |
| API | `apps/api/src/studio/script-breakdown.service.ts`、`script-breakdown.controller.ts`；标题创作路由不再显示、取消、续跑或写入拆解任务 |
| Web | `apps/web/src/components/script-breakdown-panel.tsx`、`lib/script-breakdown-client.ts`；镜头编辑表单增加“预计时长（秒）” |

## 8. 兼容与发布

- **标题创作不依赖本迁移。**
  - 运行行的 `breakdown_save` 通过 `to_jsonb` 读取。
  - 标题任务列表按 `input_json.schema` 过滤。
  - 迁移执行前，标题创作照常工作，拆解返回 503 `SCRIPT_BREAKDOWN_STORAGE_UNAVAILABLE`。
- **历史 v1/v2 任务**：输入、哈希、步骤、提示词和解析方式都不变。新任务以 `run_kind = 'script_breakdown'` 和独立的输入版本标识区分。
- **手动镜头编辑**：
  - 不填预计时长时，写入路径和内容哈希与原来完全相同。
  - 填写时，需要本迁移已执行，否则返回 400，不会写入半条记录。
- **代码回滚**：
  - 旧代码不认识拆解任务。只确认没有进行中的任务，不足以证明可以回滚。
  - 只要已保存任何拆解任务（包括 completed、failed、canceled），就不要回退到没有运行种类隔离的旧 API/Web：旧版最近标题任务查询可能读到拆解记录，返回缺少标题任务 settings 的视图，使旧进度页报错。关闭 AI 开关只限制启动，不能修复读取路径。
  - 已有拆解数据时采用前滚修复；确需回退，先交付并验收兼容补丁，覆盖任务读取、启动、续跑和恢复。不得删除记录、伪造任务类型或回退数据库来配合旧代码。
