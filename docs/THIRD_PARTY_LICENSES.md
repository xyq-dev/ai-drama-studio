# 第三方许可边界

本表是 V1 架构登记，不是法律意见或依赖清单。许可、模型权重、第三方节点和云 API 条款必须在实际引入的精确 tag/commit/发布包上由法务或负责人复核。不得将“代码许可”推断为“模型权重或输出的商业许可”。核验日期：2026-09-23。

| 项目 | 用途与计划采用方式 | 当前许可状态 | 商用结论 | 复制代码 / 独立服务 | 风险与后续核验 |
| --- | --- | --- | --- | --- | --- |
| Huobao Drama / `chatfire-AI/huobao-drama` | 只研究产品流程与 UX 取舍 | 当前文档未保存固定 commit、LICENSE 文本或许可证校验记录 | **不作为本项目商用代码来源** | 不复制；不部署 | 核验精确仓库 LICENSE、品牌、依赖和素材许可。 |
| MoneyPrinterTurbo / `harry0703/MoneyPrinterTurbo` | 参考自动化视频管线的产品思路 | 当前文档无固定 tag/commit 的 LICENSE 证据 | 待精确版本核验后才判断 | 不复制；不作为服务 | 依赖、模型、素材与外部 API 独立评估；代码许可不覆盖它们。 |
| NarratoAI / `linyqh/NarratoAI` | 参考旁白、字幕和编辑能力边界 | 当前文档无 canonical repo、commit 与 LICENSE 证据 | 待核验 | 不复制；不作为服务 | 固定 canonical repo、commit 与 LICENSE 后再判断。 |
| ComfyUI / `Comfy-Org/ComfyUI` | 可选的本地图片/视频工作流执行面 | 当前文档未保存精确发行版、自定义节点或其许可证证据 | 仅作为**独立服务**候选；不得将其代码链接/复制进专有 Core/Web | 不复制；独立进程/网络边界 | 代码许可、节点许可、模型权重和部署分发模式均待法务复核。 |
| Wan2.2 / `Wan-Video/Wan2.2` | 可选本地视频模型，经 Provider Adapter 进入 | 当前文档无可确认的代码或权重许可条款 | **待核验，不作为已获商用批准** | 不复制实现；作为可替换模型/服务 | 代码、模型权重、衍生模型、地域和输出条款分别复核。 |
| FFmpeg | Python 媒体服务的转码/合成后端 | 当前文档未固定实际 build、configure flags 或依赖许可证 | 仅在选定构建和依赖后确定 | 作为独立媒体服务依赖；不复制源码 | 生成 SBOM、保存 configure flags，并对每一依赖复核。 |

来源线索只用于后续取证：Huobao README（https://github.com/chatfire-AI/huobao-drama），MoneyPrinterTurbo README（https://github.com/harry0703/MoneyPrinterTurbo），NarratoAI README（https://github.com/linyqh/NarratoAI），Wan2.2（https://github.com/Wan-Video/Wan2.2），FFmpeg 法律页（https://ffmpeg.org/legal.html）。本轮没有读取或验证这些外部页面；链接不是许可证证据。在没有精确版本、LICENSE 文本、模型权重和实际构建证据前，任何“待核验”都不是授权。
