# 红果生产状态第二阶段：机器可读结构设计

- 状态：已定稿（2026-11-12，Asia/Shanghai）。确认前按用户意见修了 3 处：收紧正式生产闸门的人物范围、区分 schema `$id` 与状态文件 `schema` 标识、改为最小合法完整 fixture。本阶段不再扩设计。
- 依据：已锁定规范 `PRODUCTION-STATE-MACHINE-v1`；已定稿的第一阶段对象关系与指针分工。
- 本阶段交付：JSON Schema 用法、最小合法完整示例（fixture）、指针/状态约束、校验规则。
- 下一阶段：生产状态核心层实现。Migration、多模型 API、Studio UI、部署仍然不做。不扩字段。

## 1. JSON Schema

官方结构契约继续用已有文件，不再另开一份 schema：

`/workspace/drama-studio/workflows/schemas/hongguo-production-state.v1.schema.json`

两个标识必须分开，实现时不得混用：

| 标识 | 位置 | 值 |
|---|---|---|
| `$id` | schema 文件自身 | `https://hongguo.local/schemas/hongguo-production-state.v1.schema.json` |
| `schema` | 状态文件根字段 | 常量 `hongguo-production-state.v1` |

- `$id` 是 schema 文档的 URI，用来定位和引用这份契约。
- `schema` 是项目状态真源声明自己遵循的版本名。读写和校验都认这个字段，不要拿 `$id` 的 URL 去当状态文件里的 `schema` 值。
- JSON Schema 只管结构：必填字段、类型、枚举、容器形状。
- 具体生产模型名、参数、预算数值不是 schema 常量，而是项目 `modelPolicy` 里的实例数据。
- 语义不变量（指针唯一、锁档不可改写、正式闸门等）放在第 4 节，实现时与 schema 一起执行。

根对象 `Project` 必填：`schema`、`spec`、`projectId`、`title`、`status`、`timezone`、`updatedAt`、`format`、`modelPolicy`、`approvalLog`、`bible`、`characters`、`episodes`。

## 2. 状态真源与示例

每个作品一份：

`/workspace/drama-studio/projects/<projectId>/production-state.json`

最小合法完整示例（已通过 schema 校验，第三阶段可直接作 fixture）：

`/workspace/drama-studio/workflows/fixtures/hongguo-production-state.v1.minimal.json`

该 fixture 是一份完整、可校验的小作品状态，不是伪结构摘录。它演示：两个历史 locked 剧本版本与 `supersedes`、系列中有一个本集未引用人物、说话角色用 `characterId`/`role` 引用、Look-only 人物不必有 Voice、QA 九项齐全、`modelPolicy` 已锁定因而正式闸门可通过。它不是《末班车暗号》的真源；真源仍是：

`/workspace/drama-studio/projects/moban-che-anhao/production-state.json`

第三阶段回填验证用这份真源。对照第一阶段对象树：

- `Project` → `bible` / `characters` / `episodes` / `modelPolicy` / `approvalLog`
- `Character` → `look` / `voice`（有的人物只有 Look，没有 Voice 是允许的）
- `Episode` → `script` / `dialogueTimeline` / `storyboard` / `shots` / `assemblies` / `qa` / `retakeRequests`
- `Shot` → `versions[]`（即 ShotVersion）→ `takes[]`
- `Take` 必有 `manifest`
- `QA` 挂到某条 `assemblyVersionId`
- `ApprovalLog` 在 Project 根上，只追加

## 3. 指针与状态约束

可锁定对象（Bible、Look、Voice、Script、DialogueTimeline、Storyboard、Shot、Assembly、ModelPolicy）统一：

| 字段 | 含义 |
|---|---|
| `versions[]` | 该对象全部历史版本，只增不删 |
| `currentVersionId` | 当前工作版本；正在改下一版时指向新的 draft / review / revision；没有改稿时，与生效锁定相同 |
| `activeLockedVersionId` | 当前生效的 locked 版本；尚未锁定时为 `null` |

`ModelPolicy` 版本的主键是 `policyVersion`（可另有可选别名 `versionId`），指针匹配时以 `policyVersion` 为准。

状态只走：`draft` → `review` → `revision` → `locked`。

约束：

1. 同一对象可以有多条 `status=locked` 的历史 Version；同一时刻 `activeLockedVersionId` 至多一个。
2. `activeLockedVersionId` 非空时，必须存在于 `versions[]`，且该条 `status` 必须是 `locked`。
3. `currentVersionId` 必须存在于 `versions[]`。
4. 已锁定 Version 的内容不可改写。要改只能新增 Version，用 `supersedes` 指向旧版；旧版保持 `locked`。
5. `supersedes` 若有，必须指向同容器里已有的旧版本，且不得成环。
6. 正式生产只认 `activeLockedVersionId`，不认「任意一条 locked」。
7. 切换生效锁定、锁定对象、选定 Take、批准 `modelPolicy`，只能由 `user` 确认，并追加一条 `ApprovalEvent`。Bot 不得自行写入这些动作。
8. 补镜只新增 ShotVersion；若更新成片，只新增 Assembly Version。旧锁档永久保留，只允许在用户确认后改容器上的生效指针。
9. `Take`、`QA`、`ApprovalLog` 不套这组指针。Take 用 `selectedTakeId` + `status: selected | not_selected | discarded`；QA 是验收报告；ApprovalLog 是审计日志，只追加、不改、不删。
10. `modelPolicy` 的预算闸三项仍为 `null` 时，不得将该政策锁定，也不得批量生成或启用试验池。

## 4. 校验规则

分两层，第三阶段实现时一起跑：

**结构层：** 用 `hongguo-production-state.v1.schema.json` 校验整个状态文件。不过则不得作为真源写入。状态文件根字段 `schema` 必须是 `hongguo-production-state.v1`。

**语义层：** 执行第 3 节全部约束，并执行下面的正式生产闸门。

打开某集、判断「能不能进入正式分镜 / 视频生成」时，必须同时满足：

- `bible.activeLockedVersionId` 非空
- 该集 `script.activeLockedVersionId` 非空
- 该集 `dialogueTimeline.activeLockedVersionId` 非空
- `modelPolicy.activeLockedVersionId` 非空
- **本集实际引用的人物**拥有对应的当前生效锁定：被视觉引用的须有 `look.activeLockedVersionId`；被对白/配音引用的须有 `voice.activeLockedVersionId`。人物若两者都被引用，则 Look 与 Voice 都要有生效锁定。

人物范围必须按「本集实际引用」收紧，不能要求系列里每一个有 Look/Voice 的人物都已锁定。否则一个只在 S5 出场、尚未定妆的人物，会把 S1 误卡住。

本集引用人物从该集已生效（若尚未锁定则从当前工作版本，若都没有则视为无引用）的 Script、DialogueTimeline、Storyboard 收集，不新增必填字段，也不解析剧本正文去猜人名：

- Script / Storyboard 的 Version 若已带 `referencedCharacterIds` 或 `characterIds`（可选，非必填），纳入引用。
- DialogueTimeline 的 `lines[]`：优先用 `characterId`；否则用 `role` 精确匹配 `Character.name`。
- 若该集已经有 `shots[]`，把 `shot.look` 中等于某 `characterId` 的值视为 Storyboard 落地后的视觉引用。

未出现在上述集合里的系列人物，不参与本集正式生产闸门。只有 Look、没有 Voice 的资产（如双人关键帧）只要被视觉引用，就只检查 Look，不要求 Voice。

任一不足：校验结果写明缺哪一项，不允许进入正式分镜或视频生成，AI 不得越过。

补充：

- 生成新 Take 时，还须满足当前生效政策的预算闸；`cost` 可为 `unknown`，不得编造数字；`jobStatus=unknown` 不自动重发。
- 只有 `modelPool=production` 且已被用户选中的 Take，可进入 Shot Locked。
- 历史 QA 未单独检查的分项标 `not_scored`，不得事后改写成 `pass`。

按此规则，当前《末班车暗号》的对照结论是：S1 引用的是阿岚、老周和双人关键帧，其 Look/Voice（双人仅 Look）以及圣经、剧本、对白时间码都已有生效锁定；但 `modelPolicy` 仍为 draft、`activeLockedVersionId` 为 `null`（预算闸未定），因此**还不能按新闸门进入新的正式分镜或视频生成**。已锁定的 S1 成片只回填、不改写、不重做。S2 剧本仍为 draft，生产未启动。系列中以后才出场、且未被 S1 引用的人物，不会挡住 S1。

## 5. 第三阶段范围（本设计定稿后立即实现）

只实现生产状态核心层：

1. 以现有 v1 schema 为契约
2. 状态文件读写（先校验再落盘；禁止覆盖 locked Version；ApprovalLog 只追加）
3. 状态约束与正式前置闸校验
4. ApprovalLog / Manifest 的写入约定
5. 用《末班车暗号》现有 `production-state.json` 做回填验证；用上述 minimal fixture 做合法样本验证

仍然不做：Migration、多模型 API、Studio UI、部署，也不扩字段。