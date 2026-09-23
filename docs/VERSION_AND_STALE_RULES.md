# 版本与 STALE 规则

## 版本化对象与来源快照

必须版本化：故事、剧本、角色设定、镜头、生成请求/尝试、图片/视频/音频/字幕/合成/导出资产。场景和地点的结构性编辑也创建新有效版本或不可变结构快照，避免历史镜头失去语义。`Project.current_*` 仅指向选定版本。

每个派生对象的来源 revision/Asset 由 `ArtifactDependency` 行保存（类型、ID、revision_no/内容哈希），不使用 JSONB 代替这些关系。创建时保存完整输入快照、`inputHash`、`promptVersion`、`seed`、Provider/模型能力参数和工作流模板版本。旧资产永久保留为历史版本，除非独立保留策略清理从未完成且未引用的临时对象。

## inputHash 与可复现性

`inputHash = SHA-256(canonicalJSON({kind, inputSchemaVersion, provider, model, modelVersion, sourceRevisionRefs, sourceAssetContentHashes, promptTemplateId, promptVersion, workflowVersion, renderedPrompt, normalizedModelParameters, seed, outputSpec}))`。canonical JSON 使用固定 UTF-8、对象键字典序、标准化 Unicode/换行、明确 null、无浮点显示歧义；密钥和短期 URL 不参与哈希。

`promptVersion` 是不可变模板版本，如 `shot-video@3`；同时存 `rendered_prompt`（脱敏后）与变量快照。Provider 生成/返回的 seed 原样存为字符串；若无 seed，记录 `null` 和 `seedSupported=false`，不得伪称可复现。`sourceAssetIds` 以有序数组存储，另记录每个资产的 content hash，防止仅 ID 相同而内容被错误复用。

## STALE 传播与复用

上游新版本被选为当前版本时，系统从显式来源边向下遍历，把仍引用旧版本的非历史派生对象标为 `STALE`，记录 `stale_reason` 和 `stale_from_ref`。标记是事务性的、幂等的、范围限定到 Project；不会删除资产、取消已完成 job 或改写成本。审核批准的是某版本而非逻辑实体，新的修订默认 `DRAFT`。

可复用条件：资产输入来源都与当前选定版本匹配、资产 `ACTIVE`、审核要求仍满足、输出规格匹配、无策略/Provider 约束冲突且 `inputHash` 相同。视觉无关的元数据（项目标题、标签）不传播 STALE。审核、脚本、角色外貌、场景语义、镜头内容/时长/运镜、音频文本和合成顺序均会按来源边传播；最终导出永不复用 STALE 输入。

## 三个完整例子

### 1. 修改剧本对白

编辑 Episode 2 的台词会创建 `ScriptRevision 2`，不改 `ScriptRevision 1`。选择 v2 后，引用 v1 的相关 Scene、ShotRevision、配音、字幕、受影响镜头视频、Episode 2 合成和全剧导出变为 STALE；未引用该台词的镜头可由显式依赖分析保持可用。用户审核 v2 后，只重生受影响镜头的分镜/配音/字幕/视频并重合成；旧版本仍可查阅和比较。

### 2. 修改角色外貌

创建 `CharacterRevision 3` 并选择为当前。所有引用角色 v2 的参考图、含该角色的镜头图片/视频、受影响的合成与导出标记 STALE；不含该角色的镜头不受影响。新参考图和每个受影响镜头有新的 inputHash/job/asset，旧图片和成本只读保留。

### 3. 修改单个镜头运镜

编辑 Shot 17 创建 `ShotRevision 4`，仅使该镜头的图片、视频及其依赖音频/字幕（若镜头时长或台词改变）STALE。Shot 1–16、18 及其资产不变。Episode 合成与全剧导出因片段清单包含 Shot 17 v3 而 STALE；用户重生 Shot 17 v4 并重新合成即可。

## 项目回滚

回滚是把 `current_*_revision_id` 移回一个可审计的历史修订、重新计算受影响来源边并生成新的 STALE 事件；不是恢复覆盖或删除新版本。若选择的历史版本已 APPROVED，可在审计记录中引用既有批准；否则必须重新审核。回滚后的任何导出仍须使用当前、已批准、非 STALE 的完整输入集。

## 审查后失效算法与并发规则（本节优先）

`STALE` 是派生 revision 或 Asset 的业务可用性状态，不是对象存储状态，也不是删除标记；完整枚举为 `ACTIVE, STALE, SUPERSEDED, FAILED, DELETED`，定义见领域模型。它由 `ArtifactDependency` 中的显式来源边判定，不能由“当前项目内容看起来相近”猜测。一个对象只有在所有必需来源仍是当前、已批准、`ACTIVE` 且其输入快照的 `inputHash`、输出规格、Provider/模型策略仍匹配时可复用；Provider 或模型不同绝不命中同一缓存。用户显式“重新生成”会创建新的 workflow/job、生成新的随机 seed 并设置 `bypassCache=true`，即使计算出相同哈希也不复用；非显式请求先按范围和 inputHash 查找可复用 Asset。随机 seed 在创建 job 前以加密安全随机数生成、十进制字符串持久化；Provider 不支持时记录 `null` 与 `seedSupported=false`。

伪代码如下（`root` 是刚被当前指针替换的旧 revision，或被替换的 Asset）：

```text
transaction:
  lock aggregate row and verify expected version / If-Match
  create immutable new revision; update the sole current_revision_id pointer
  queue = dependencies where source = root and dependent.status not in (DELETED, FAILED)
  while queue not empty:
    edge = queue.pop()
    if dependent is already STALE: continue
    set dependent.status = STALE; record stale_reason and stale_from_edge_id
    invalidate approval only if that approval covered the changed content
    append committed domain event record
    queue += dependencies where source = dependent
  commit
```

实现使用同一事务内的递归 SQL 或有界批量图遍历，并限制在 `(workspace_id, project_id)`，使用已访问集合与行锁。若超过配置的批次上限，事务创建持久化 `STALE_RECALCULATION` WorkflowRun 并将根标记为传播未完成；导出和生成门槛拒绝该根，直至后续事务完成。任何失败回滚当前指针改动，不能留下静默的部分传播。并发编辑使用聚合 `version`/`If-Match` 条件更新，只能从新读取的状态重试。重算具幂等性：它从不可变引用重建依赖，只补写必要的 `STALE`，不会在未重新验证全部输入与审核门前自动激活对象。

具体边界：剧本对白变更只沿涉及该对白的 Scene/ShotRevision、其配音、字幕、视频、合成和导出边传播；角色参考图只在它仍被新镜头版本显式引用时复用，角色外貌变更只影响引用旧 `CharacterRevision` 的镜头图片/视频及下游合成/导出；单镜头运镜仅影响该镜头图片/视频，音频/字幕仅在台词、时长或音频输入改变时失效，随后使包含该镜头的合成/导出失效。未引用的角色、镜头或资产不失效。
