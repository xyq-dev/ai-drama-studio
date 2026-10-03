# M3 AV 审查修复执行单

【执行工具：Cursor｜模型：Grok 4.6 High Fast】

本轮直接修复、验证、选择性提交并普通 push `feat/m3-av-workbench`。授权沿用已有 feature 开发流程，无需再次请求确认。源码审查基线为 `444d23f043cedc5df7a973ae00fabb141192a122`；先 fetch，在包含该源码与本执行单的 feature 最新提交上继续。不要退回旧 SHA、修改 main 或丢弃既有改动。

阅读 `docs/M3_AV_CODEX_REVIEW.md` 及 `docs/M3_AV_CODEX_REVIEW_EVIDENCE.json`，本轮收敛四个已重放的问题。

## 1. 永久恢复失败进入终态

- 让 AV 正常执行和恢复使用一致的错误分类。依据稳定错误码区分 `REVIEW_REQUIRED`、`NOT_FOUND`、`COST_CONFLICT` 与暂时错误；确定性的快照 / output / accounting 校验失败也必须收敛。不能只增加几个错误消息正则来识别数据库错误。
- 永久错误 fail 原 attempt、retryable=false，不提交有效 Asset / cost；连续 reconcile 不再重复 inspect / put / 提交，不新建 attempt，不再次 submit。保持原来源 / capability / providerRequestId。
- `STALE_RECALCULATION_PENDING`、暂时磁盘 / 数据库失败在已 attach 请求后保留恢复能力，不误判永久失败或重复外部提交。
- 与取消、`JOB_TERMINAL`、`ATTEMPT_SUPERSEDED` 的竞争遵守既有状态机，不重开终态、不失败一个较新的 attempt。不要吞掉真正的未知运行时故障。
- 回归覆盖 VIDEO 与 TTS：上述永久错误、暂时失败后成功、重复 reconcile、取消 / 终态或 superseded 竞争；检查 submit 次数、原 attempt、对象写入 / Asset / cost 次数。若测试用替身，明确是模拟验证。

## 2. 恢复遵守图片与 AV 各自开关

- 将明确的每类 enable 配置传入 recovery，和 dispatch 共用同一语义。不能以存在 MOCK_OBJECT_DIR 或启用了图片推断 AV 已启用；也不能用 AV 开关间接开启图片。
- 已绑定请求的旧 RUNNING 视频 / 配音，在 AV=false 时不得 inspect / resolveOutput / put / complete Asset / cost。按既有配置缺失失败语义，将该原 attempt 明确置为不可重试的配置失败；取消请求沿用合法取消规则。禁止把任务永久留在 RUNNING。
- 当前 recovery 仅在对象目录存在时创建；无有效目录时也要保留仅做配置失败 / 取消收尾的路径，不 inspect、不写对象。可以由现有 reconciler 承担，不为了收尾构造非法 LocalMockObjects。
- 反向组合 image=false、AV=true 也必须只恢复 AV。构造函数与调用方使用显式配置，不能给 recovery 增加默认全开。
- 测试直接覆盖 startQueueRuntime 的接线，而非只测试手动构造 recovery。至少覆盖 image=true/AV=false、image=false/AV=true、均关闭，以及生产 / 默认关闭 / 无有效目录的已有保护。确认旧图片正常恢复仍兼容。

## 3. 提交提示绑定媒体与 revision 请求身份

- revision 切换清除该活动区域的三类 notice / acceptError；对提交响应、错误、finally 与提交后的 refresh 结果做 revision 世代 / 请求身份校验。只比较 revision 字符串不能防住 A→B→A 的迟到响应。
- 老请求不能改新 revision 的提示、busy、pending key 或错误；已受理老任务仍可以触发安全的任务查询，由已有读取防过期机制处理。三类媒体的 202 与写入失败事实各自独立。
- 保持写入本身失败时同一请求可复用原幂等键；换 revision / seed / 媒体种类使用新键。迟到成功不能清除新请求的 pending key。
- 挂载交互测试覆盖旧 revision 的迟到 202 / 写入失败 / 后续查询失败、A→B→A、已有提示后切换，以及新请求状态不被旧响应清理。保持 M2 草稿、原 If-Match、409 与显式 null 恢复。

## 4. 重新查询不伪造其它渠道受理

- requery 接收正确的 channel / 请求身份，或展示不带受理事实的公共查询错误。只能为实际已受理且身份相符的渠道保留“已受理结果有效”。
- 图片 / 视频 / 配音的重新查询失败与成功不能串写另一渠道的受理提示。只有公共列表查询失败时，使用媒体中性文案。
- 三类参数化交互测试：仅一个渠道 POST 202→初次查询失败→重新查询又失败；其它未提交渠道没有受理提示。重新查询只 GET，不再次 POST，也不把 202 写成成功。

## 范围与验证

本轮保持固定 1552 字节 H.264 / 1644 字节静音 WAV、零美元 ACTUAL、LocalMockObjects、开关默认 false、生产禁用、同源全量 GET 200 / HEAD 空 body / 忽略 Range。无需 Migration、MinIO、FFmpeg 运行时、ComfyUI、真实模型、媒体手工 retry 或新架构。预览重试是非阻断改进，可以后续处理。

先跑改动相关 test / lint / typecheck，再在 Node 24.21.0、pnpm 10.17.0 下跑 `pnpm verify`，不关闭 engine 检查。测试应能在原审查源码上暴露问题、在修复后验证行为，不能仅断言新 helper 自身。

本机缺实际服务时完成模拟验证与普通 push；不重试 Windows 1809 Docker 安装，不重置任何既有数据库，不在本轮执行 Migration / provision。Codex 在修复 SHA 审查通过后使用独立新建隔离数据库做真实 API / Worker / 同源播放与 390px 验收。

## Git 与交付

1. 核实 `D:\Projects\ai-drama-studio` 的实际 status / branch / HEAD，保留所有原有未提交文件；不 reset、clean、stash 或覆盖。fetch 后核实源码祖先和本执行单，不从 main 开始。
2. 修改本轮有关源码、回归测试与报告。更新 `docs/M3_AV_WORKBENCH_IMPLEMENTATION_REPORT.md`，新增或更新 `docs/M3_AV_REVIEW_FIX_REPORT.md`，如实区分模拟与真实验证。
3. 检查通过后选择性 commit，并普通 push 当前 feature，随后 fetch 核验 HEAD 与 origin。不要 main、force push、PR、merge、应用 pack 或 deploy。
4. 返回 `M3_AV_REVIEW_FIX_REPORT`：目录 / 分支 / 起点 / 最终 SHA、四项修复行为、实际命令 / exit / 测试数、真实与未执行项、GitHub 提交链接及远端核验。直接实施，不只返回计划或要求用户重复授权。
