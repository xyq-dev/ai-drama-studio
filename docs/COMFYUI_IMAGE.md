# 红果 ComfyUI 分镜图片接入

红果网页通过自身 API 完成报价、确认和提交。现有 Worker 直接连接管理员允许的 ComfyUI 实例，复用原有 Job、Attempt、Outbox、加密收据和对象存储路由。旧图片供应商继续可用。ComfyUI 首期提供文生图和单参考图生图。视频生成使用各自已有的入口。

## 工作流与依赖

| 工作流 | 可变输入 | 依赖与结果 |
| --- | --- | --- |
| `sd15-txt2img` v1 | 正向提示词、预设尺寸、服务端随机 seed | `CheckpointLoaderSimple`、`CLIPTextEncode`、`EmptyLatentImage`、`KSampler`、`VAEDecode`、`SaveImage` |
| `sd15-img2img` v1 | 同上，加一张当前项目已有的受管 PNG 资产 | 增加 `LoadImage`、`ImageScale` 和 `VAEEncode`。先按目标比例居中裁切，固定去噪强度 0.65。 |

API 格式模板在 `packages/providers/src/comfyui-workflows.ts`。两种模板均输出节点 `9` 的一张 PNG，尺寸为 512×512、512×768、768×512、576×1024 或 1024×576。预设尺寸同时限制生成的像素数。服务端冻结模板版本和哈希、checkpoint 标识、seed、输入参数与参考图资产版本及哈希。由管理员选择已核验的 SD 1.5 兼容 `.safetensors` 文件 basename。确认 checkpoint 来源、许可和文件 SHA-256，升级模型文件时使用新 basename 并变更配置版本，保留旧任务需要的模型标识和对应模板。

模板采用内置推理节点，参照 [ComfyUI API 示例](https://github.com/Comfy-Org/ComfyUI/blob/master/script_examples/basic_api_example.py)、[img2img 工作流](https://github.com/Comfy-Org/workflow_templates/blob/main/site/knowledge/concepts/img2img.md) 和 [内置节点](https://github.com/Comfy-Org/ComfyUI/blob/master/nodes.py)。接口参照 [ComfyUI 自托管路由](https://docs.comfy.org/development/comfyui-server/comms_routes)。模板真实推理仍待验证，人物一致性和图像质量需使用项目样本人工审查。

## Hermes 接入步骤

以下是待执行步骤。目标实例、测试额度和环境由操作者指定，生产启用需另有授权。

1. 在已授权的独立算力环境准备 ComfyUI 和已审核 checkpoint。保持私网或受控反代，确认 API 与 Worker 进程能访问。运行进程分别使用自己的现有工作目录与服务身份。
2. 在 API 和 Worker 的受保护环境中保存一致的配置，先保持 `COMFYUI_IMAGE_ENABLED=false`。沿用 [真实媒体运行手册](./REAL_MEDIA_RUNBOOK.md) 的站点登录、收据密钥和存储路由。缺少所需配置会关闭 ComfyUI 报价。

   | 配置 | 值 |
   | --- | --- |
   | `COMFYUI_BASE_URL` | 受控 ComfyUI 源站，包含协议及可选端口。 |
   | `COMFYUI_ALLOWED_ORIGINS` | 逗号分隔的精确源站允许列表，须包含上述地址。 |
   | `COMFYUI_API_KEY` | 可选，仅用于要求 Bearer 的受控反代。注入进程环境。 |
   | `COMFYUI_CHECKPOINT` | 已审核、实例中实际可用的 SD 1.5 兼容 checkpoint basename。 |
   | `COMFYUI_PRICE_IMAGE_ESTIMATE` | 操作者确认的每张自托管资源估算（CNY 正数）。真实费用保持未知。 |
   | `COMFYUI_CREDENTIAL_VERSION` | 默认 `v1`，轮换时使用新版本。需要时保留 `COMFYUI_PREVIOUS_API_KEY` 与 `COMFYUI_PREVIOUS_CREDENTIAL_VERSION`。 |
   | `COMFYUI_TARGETED_CANCELLATION` | 默认 `false`。只有核验部署版本的 `POST /api/jobs/{prompt_id}/cancel` 对单个请求生效并返回确切结果后才启用。 |

3. 在现有管理员控制台的「模型配置 → ComfyUI 图片生成」执行连接检测，或运行 `corepack pnpm --filter @ai-drama/api comfyui:check`。该检查只请求 `/system_stats` 和 `/object_info/{node}`。分别报告未配置、实例不可达、缺失节点或模型、依赖就绪。生成关闭时仍可检测。
4. 核对目标库的现有 real-media 草案状态。持久化选用需要额外审查并在获准的目标库单独安装 `packages/database/prisma/drafts/20261113000100_comfyui_shot_image_selection.sql`。默认迁移与启动不会安装它。未安装时仍可生成及预览，持久选用显示不可用。
5. 在获准环境打开 `COMFYUI_IMAGE_ENABLED=true`，先运行 `corepack pnpm --filter @ai-drama/api real-media:provision` 查看计划。获准 provisioning 后再执行该 CLI 的 `--execute`。核对仅添加预期的 `comfyui:image.generate` 提供方，原默认图片配置按原设置解析。生产环境仍需原有生产授权。
6. 在已批准场景和有效镜头下分别提交一次文生图和参考图任务。重新进入镜头核对原任务和素材，检查两张图真实格式、尺寸、对象存储与持久选用。暂停新生成用 `COMFYUI_IMAGE_ENABLED=false`，保留原实例、凭据和收据以恢复已接受任务。

## 任务边界

- 提交前记录发送意图。收到 `prompt_id` 后只查询原任务。`/history/{prompt_id}` 提供结果，`/queue` 区分排队和运行。无可验证阶段显示进度暂不可用；本版使用轮询恢复。
- 提交结果不明时进入 UNKNOWN，保留已有的重新报价风险确认规则。取图或入库失败会继续从同一结果恢复。图片字节、尺寸、哈希和 Asset 关系完整持久后，任务才成功。
- 结果按工作区、项目和镜头版本选用。手动选用保存指针，候选仍可重新预览，生成新候选保留当前选用。原来源失效后需重新选用。
- 未外发的排队任务沿用现有取消。外部任务仅在实例启用经核验的定向能力时请求取消；收到确切确认后才标记取消。未启用该能力时仍可查看原任务。
- 独立的 `services/comfyui-adapter` 保留早期健康检查用途；真实执行由现有 Worker 负责。
- ComfyUI 输入目录会留下 `ads-comfyui-v1-<attempt>.png`，输出保存到 `output/ads-comfyui-v1/`。由管理员管理存留时间，保证原任务的恢复窗口内仍可读取，避免共享实例的文件被提前清除。
