# 红果生产状态第二阶段：机器可读结构设计

- 状态：方案，待确认。确认前不写实现代码。
- 日期：2026-11-12（Asia/Shanghai）
- 依据：已锁定规范 `PRODUCTION-STATE-MACHINE-v1`；已定稿的第一阶段对象关系与指针分工；正式生产闸门（Bible + Script + Look + Voice + DialogueTimeline + ModelPolicy 均须有当前生效锁定）。
- 本阶段交付：JSON Schema 用法、`production-state.json` 结构示例、指针/状态约束、校验规则。
- 确认后立即进入第三阶段，只实现生产状态核心层。Migration、多模型 API、Studio UI、部署仍然不做。
- 本阶段不扩字段。

## 1. JSON Schema

官方契约继续用已有文件，不再另开一份 schema：

`/workspace/drama-studio/workflows/schemas/hongguo-production-state.v1.schema.json`

- `$id`：`hongguo-production-state.v1`
- 管结构：必填字段、类型、枚举、容器形状
- 不管具体生产模型名、参数、预算数值；那些是项目 `modelPolicy` 里的实例数据
- 语义不变量（指针唯一、锁档不可改写、正式闸门等）不全部塞进 JSON Schema，放在第 4 节校验规则里，实现时与 schema 一起执行

根对象 `Project` 必填：`schema`、`spec`、`projectId`、`title`、`status`、`timezone`、`updatedAt`、`format`、`modelPolicy`、`approvalLog`、`bible`、`characters`、`episodes`。

## 2. 状态真源与示例

每个作品一份：

`/workspace/drama-studio/projects/<projectId>/production-state.json`

《末班车暗号》的现有状态文件作为第一份完整对照样本，第三阶段回填验证也用它。下面只展示结构关系（示例，不是扩字段）。`S1/script/v2` 是为说明「历史 locked 可多个」而写的示意，现有项目真源里 S1 剧本目前仍只有 v1。

```json
{
  "schema": "hongguo-production-state.v1",
  "projectId": "moban-che-anhao",
  "bible": {
    "currentVersionId": "系列/bible/v1",
    "activeLockedVersionId": "系列/bible/v1",
    "versions": [
      { "versionId": "系列/bible/v1", "status": "locked", "path": "…", "sha256": "…" }
    ]
  },
  "characters": [
    {
      "characterId": "alan",
      "look": {
        "currentVersionId": "系列/look/alan/v1",
        "activeLockedVersionId": "系列/look/alan/v1",
        "versions": [{ "versionId": "系列/look/alan/v1", "status": "locked" }]
      },
      "voice": {
        "currentVersionId": "系列/voice/alan/v1",
        "activeLockedVersionId": "系列/voice/alan/v1",
        "versions": [{ "versionId": "系列/voice/alan/v1", "status": "locked" }]
      }
    }
  ],
  "episodes": [
    {
      "episodeId": "S1",
      "script": {
        "currentVersionId": "S1/script/v2",
        "activeLockedVersionId": "S1/script/v2",
        "versions": [
          { "versionId": "S1/script/v1", "status": "locked" },
          { "versionId": "S1/script/v2", "status": "locked", "supersedes": "S1/script/v1" }
        ]
      },
      "dialogueTimeline": {
        "currentVersionId": "S1/dialogue/formal-v1",
        "activeLockedVersionId": "S1/dialogue/formal-v1",
        "versions": [{ "versionId": "S1/dialogue/formal-v1", "status": "locked" }]
      },
      "storyboard": { "currentVersionId": "…", "activeLockedVersionId": "…", "versions": [] },
      "shots": [
        {
          "shotId": "S1-05",
          "currentVersionId": "S1-05/v2",
          "activeLockedVersionId": "S1-05/v2",
          "versions": [
            {
              "versionId": "S1-05/v1",
              "status": "locked",
              "selectedTakeId": "S1-05/v1/t1",
              "takes": [
                {
                  "takeId": "S1-05/v1/t1",
                  "index": 1,
                  "status": "selected",
                  "modelPool": "production",
                  "manifest": {
                    "provider": "…",
                    "model": "…",
                    "prompt": "…",
                    "referenceAssets": [],
                    "params": {},
                    "cost": "unknown",
                    "output": {},
                    "timestamp": "…",
                    "jobStatus": "success"
                  }
                }
              ]
            },
            {
              "versionId": "S1-05/v2",
              "status": "locked",
              "supersedes": "S1-05/v1",
              "selectedTakeId": "S1-05/v2/t1",
              "takes": []
            }
          ]
        }
      ],
      "assemblies": [
        {
          "trackId": "ai-motion-zh",
          "currentVersionId": "S1/assembly/v1",
          "activeLockedVersionId": "S1/assembly/v1",
          "versions": [{ "versionId": "S1/assembly/v1", "status": "locked" }]
        }
      ],
      "qa": [
        {
          "qaId": "qa-S1-v1",
          "assemblyVersionId": "S1/assembly/v1",
          "result": "pass",
          "checks": {
            "visual": {}, "audio": {}, "subtitle": {},
            "duration": {}, "resolution": {}, "fps": {},
            "fileIntegrity": {}, "shotOrder": {}, "assetHash": {}
          }
        }
      ],
      "retakeRequests": []
    }
  ],
  "modelPolicy": {
    "currentVersionId": "系列/modelPolicy/v1",
    "activeLockedVersionId": null,
    "versions": [
      {
        "policyVersion": "系列/modelPolicy/v1",
        "status": "draft",
        "budget": {
          "maxCostPerTake": null,
          "maxTakesPerShot": null,
          "maxExperimentalCostPerEpisode": null
        }
      }
    ]
  },
  "approvalLog": [
    {
      "eventId": "ae-…",
      "action": "lock",
      "objectType": "script",
      "objectId": "S1",
      "versionId": "S1/script/v2",
      "fromStatus": "review",
      "toStatus": "locked",
      "actor": "user",
      "timestamp": "…"
    }
  ]
}
```

对照第一阶段对象树：

- `Project` → `bible` / `characters` / `episodes` / `modelPolicy` / `approvalLog`
- `Character` → `look` / `voice`（有的人物只有 Look，如双人关键帧，没有 Voice 是允许的）
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

**结构层：** 用 `hongguo-production-state.v1.schema.json` 校验整个状态文件。不过则不得作为真源写入。

**语义层：** 执行第 3 节全部约束，并执行下面的正式生产闸门。

打开某集、判断「能不能进入正式分镜 / 视频生成」时，必须同时满足：

- `bible.activeLockedVersionId` 非空
- 该集 `script.activeLockedVersionId` 非空
- 每个有 Look 的人物，`look.activeLockedVersionId` 非空
- 每个有 Voice 的人物，`voice.activeLockedVersionId` 非空
- 该集 `dialogueTimeline.activeLockedVersionId` 非空
- `modelPolicy.activeLockedVersionId` 非空

任一不足：校验结果写明缺哪一项，不允许进入正式分镜或视频生成，AI 不得越过。

补充：

- 生成新 Take 时，还须满足当前生效政策的预算闸；`cost` 可为 `unknown`，不得编造数字；`jobStatus=unknown` 不自动重发。
- 只有 `modelPool=production` 且已被用户选中的 Take，可进入 Shot Locked。
- 历史 QA 未单独检查的分项标 `not_scored`，不得事后改写成 `pass`。

按此规则，当前《末班车暗号》的对照结论是：S1 的圣经、剧本、定妆、声线、对白时间码都已有生效锁定，但 `modelPolicy` 仍为 draft、`activeLockedVersionId` 为 `null`（预算闸未定），因此**还不能按新闸门进入新的正式分镜或视频生成**。已锁定的 S1 成片只回填、不改写、不重做。S2 剧本仍为 draft，生产未启动。

## 5. 确认后的第三阶段（现在还不动）

你确认本第二阶段后，立即只实现生产状态核心层：

1. 以现有 v1 schema 为契约
2. 状态文件读写（先校验再落盘；禁止覆盖 locked Version；ApprovalLog 只追加）
3. 状态约束与正式前置闸校验
4. ApprovalLog / Manifest 的写入约定
5. 用《末班车暗号》现有 `production-state.json` 做回填验证

仍然不做：Migration、多模型 API、Studio UI、部署，也不扩字段。