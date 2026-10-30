# ViMax E1：单场景离线评估工具

状态：E1 原型已实现。它读取人工准备的合成或经授权脱敏 JSON，把固定版本的 ViMax 文本规划候选与本项目角色、对白和镜头字段进行对照。它不会调用模型、读取线上作品、写业务库或创建 Scene/Shot 草稿。E2 平台集成和 E3 真实规划仍未实施。总体方案见 [评估设计](VIMAX_SCRIPT2VIDEO_EVALUATION.md)。

## 运行

使用仓库锁定的 Node 24 与 pnpm 10.17.0，先按既有开发流程安装锁定依赖并构建：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @ai-drama/domain... build
corepack pnpm vimax:evaluate
```

最后一条命令读取 `scripts/vimax-evaluation/fixtures/single-scene.json`，向标准输出写报告；没有指定文件时始终使用这个合成样本。自备样本应放在仓库内不提交的本地目录，再传入相对路径：

```sh
corepack pnpm vimax:evaluate artifacts/my-redacted-scene.json
```

输出 JSON 需要直接交给其他本地工具时，使用脚本而不是包含 pnpm 日志的外层命令：

```sh
node --permission --allow-fs-read=. scripts/vimax-evaluation/run.mjs
```

`ready_for_review` 退出码为 0，`blocked` 为 1。缺少文件、构建产物或字段时明确停止，不自动下载、安装、重建、查找缓存或生成候选。安装和构建是独立的开发准备步骤；评估命令本身离线运行。内置样本为双角色、三镜头，计划时长 4 / 4 / 5 秒，全部内容与 ID 都是合成数据。

## 文件与契约

顶层只接受 `fixtureKind`、`input`、`candidate`、`supplements` 四个字段。`fixtureKind` 必须为 `synthetic` 或 `redacted`，且与 `input.sourceKind` 一致。这是调用方的数据声明，工具不能证明真实数据已取得授权或完成脱敏；不得提交生产剧本和密钥。

| 部分 | 内容与边界 |
| --- | --- |
| `input`，`ads.vimax-evaluation.input.v1` | 短剧模式、项目/集/当前批准剧本/角色修订身份，非 STALE 声明；完整剧本文本与 SHA-256、场景原文边界、一个选中场景、逐句对白目录；9:16、风格和目标单场景秒数 |
| `candidate` | 上游固定提交 `fd4b72e7731be6e5f88486206d25ea59849b0285` 的 JSON 投影：`characters`、`storyboard`、`shot_descriptions`、数组形式的 `camera_tree`；不接受 Python 对象、额外字段或字符串化的 JSON |
| `supplements`，`ads.vimax-evaluation.supplements.v1` | 人工明确填写 ViMax 角色索引到冻结角色 key 的一一映射，以及各镜头的景别、camera、action、计划时长、角色和逐句对白来源 ID；不从自由描述猜测身份、对白或时长 |
| 输出，`ads.vimax-evaluation.report.v1` | 通过时保留原候选、源场景原文、约束、补充字段、预计总时长和机位生成顺序；拒收时只给固定诊断和字段路径，不回显被拒文本 |

冻结信息只与文件内快照相互校验，没有访问实时数据库确认 APPROVED、CURRENT、STALE 或访问权限。成功报告带 `frozen_metadata_not_live_verified`，不能用它作为线上保存凭证。三部分使用排序键的 JSON 哈希，数组顺序保留；脚本哈希按原始 UTF-8 字节计算。没有时间戳或随机 ID，固定输入得到固定报告。

## 源场景和对白

E1 只支持可明确核对完整对白的有限文本格式，不把任意自然语言剧本猜成结构化来源：

```text
【场景】夜晚的候车室
【动作】林夏握着车票，看向门口。
林夏：你还会回来吗？
周衡：会。我答应你。
```

完整剧本可以有多个场景，`sceneSpans` 必须按 S1、S2…连续覆盖全文，选中范围必须恰好一个；边界不能截断标题或 CRLF。范围采用 JavaScript UTF-16 字符偏移 `[start, end)`。选中场景只接受场景标题、`【动作】` 行、空行和 `说话人：正文` 行。其他格式报 `source_format_unsupported`，等待显式适配，不修改原文。

`sourceDialogue` 必须按原文顺序覆盖选中场景的每条对白，包含整行的准确偏移、说话人、正文与冻结角色 key。LF、CRLF、单独 CR 的原文都保留。所有说话人必须已登记冻结身份；同名角色靠显式 key 区分，`null` 不能代替身份。旁白也需要明确登记；未定义的非角色音轨留待后续契约处理。

每条源对白必须在补充镜头中出现恰好一次，原文、人物及顺序完全相同；漏句、增句、换标点、重复和调序均拒收。可见角色索引与补充镜头角色必须一致，镜头不能引入冻结表外的人物。对自由文本中的叙事内容和角色描述只保留原样供人工阅读，程序不能证明画面动作语义没有改编。

## 校验与差异

- 源文本、三部分 JSON、字段长度、角色/镜头数量和深度都有上限。每部分 JSON 最多 262,144 UTF-8 字节、深度 16、节点 10,000；CLI 整个文件最多 1 MiB。函数拒绝 Proxy、getter、toJSON、自定义对象和循环等非 JSON 输入，不执行其回调。
- 分镜及详细镜头索引必须连续且逐项一致，最后一镜标志准确。最多 8 镜，单镜人工计划时长为 2–10 秒；它不是媒体实测时长。目标与合计秒数均展示供复核，不自动伸缩或补齐。
- 机位索引、镜头分组、父机位与父镜头归属必须一致；唯一根为机位 0，第一播放镜头属于根。悬空、自引用、多根和循环都拒收。父镜头可以在播放顺序的后面，视觉生成依赖与播放顺序分别保留。
- 严格校验后，再用仅在内存中的局部坐标投影复用既有拆解字段与安全检查。这个投影不会输出或保存。单场景总时长 2–4 秒只豁免旧验证器面向整集的 5 秒最小值，不获得整集完成资格。原有拆解验证器仅收窄参数类型，运行规则不变。
- 上游首尾帧、运动描述和机位树保存在隔离报告内，绝不塞入现有 `camera` 字符串。候选 `audio_desc` 不能替代逐句对白来源；两者语义一致性需人工比较。

每份领域报告都保留四项缺口：`semantic_review_required`、`single_scene_write_not_implemented`、`planned_duration_not_measured`、`frozen_metadata_not_live_verified`。不支持的源格式另加 `source_format_adapter_required`。目标时长、竖屏构图和风格的实际实现也属于人工语义评审，Schema 通过不表示达标。

**所有结果始终 `writeAllowed:false`。** `ready_for_review` 只表示结构校验通过，可以人工比对。报告不是 `ads.script-breakdown.output.v1`，不能传给现有整集替换保存。该保存会归档整集旧场景和镜头；单场景安全写入、持久化和审核接口必须在 E2 单独设计并验证。

## 离线边界与验证

评估器只依赖 contracts、Node 内置哈希和既有纯校验函数，没有 Provider/DB/SDK 依赖。CLI 在加载评估器前安装网络防线，拒绝 fetch、网络内置模块、undici、子进程和 worker 等入口；即使尝试被捕获，最终也返回阻断。Node Permission Model 另限制为文件只读，不授予写入、子进程和扩展权限。Node 的该权限模式本身不保证禁网：网络防线是受信工具的回归保护，不是执行任意恶意 JavaScript 的安全沙箱，输入仅为 JSON。

针对性验收覆盖完整对白/身份、严格字段、冻结来源、机位图、后播放父镜头、三种换行、确定性、不可变输入与所有拒收路径；网络 spy 验证成功、失败、缺输入均为零调用。命令行测试使用独立进程，覆盖默认样本、带空格路径、缺文件、坏 JSON、超限、缺构建/补齐字段和网络入口拦截。`pnpm verify` 包含命令行测试。

```sh
corepack pnpm --filter @ai-drama/domain test -- vimax-evaluation.spec.ts
node --test scripts/vimax-evaluation/run.test.mjs
```

没有运行上游 ViMax，也未证明真实供应商兼容性、分镜质量、调用数量或费用。没有新增 HTTP、数据库字段、迁移、运行开关或页面；系列媒体仍关闭，系列文本的 15 / 19 / 96 次公式和历史授权保持原义。后续 E2 应先解决局部写入、扩展字段的持久化、预算、幂等、发送前重检和审核/STALE，再考虑真实调用。
