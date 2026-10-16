# 一个真实镜头的媒体试接

状态：接入方案和独立工具；真实供应商验收待执行。基线为 `main@a7a62ba81e75b2b867be8045e1752a4f00b8a80f`。本轮与 PR #68 的编剧检查、角色面板修复分开开发。

## 本轮决定

选择阿里云百炼北京地域，先生成一个原创人物、单个连续镜头、5 秒竖屏视频，配一句中文旁白，再调用项目已有的 Python FFmpeg 合成器。

| 步骤 | 模型 / 工具 | 固定约束 |
| --- | --- | --- |
| 首帧 | `qwen-image-3.0` | 1 张，720×1280，固定 seed，保留生成水印 |
| 图生视频 | `wan2.6-i2v-flash` | 首帧来自上一步，720P、5 秒、`audio=false`、单镜头 |
| 旁白 | `qwen3-tts-flash` | 预置 `Cherry` 音色，中文、短句 |
| 合成 | 现有 `media_worker.compose_cli` | 输出 1080×1920、25fps、H.264/AAC MP4 |

第一轮选择这个组合，是为了用一个平台完成图片、视频、配音，并复用项目已有的百炼接入经验；不代表已比较画质并证明它优于其他模型。模型 ID 固定写入运行快照，但稳定别名和 seed 不保证跨日期逐字节复现。

镜头样例：成年原创人物在书房发现桌上的一封信，镜头缓慢推进。旁白“原来，真相一直在这里。”不要求人物开口。第一轮不做声音克隆、对口型、背景音乐、字幕烧录或多镜头角色一致性。

## 接口与费用依据

以下官方页面在 2026-10-14（北京时间）核对，账号下实际可用模型、开通状态和配额尚未验证：

- [Qwen 图像 API](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)：使用异步 `image-generation/generation`，不是旧的图像合成地址。保存 `task_id` 后查询结果。
- [Wan 首帧视频 API](https://help.aliyun.com/zh/model-studio/legacy-image-to-video-api-reference/)：使用异步 `video-generation/video-synthesis`；首帧支持 data URL，本轮不需要先开 OSS Bucket。必须显式设置无声和 720P，避免采用较贵默认参数。
- [Qwen TTS API](https://help.aliyun.com/zh/model-studio/qwen-tts-api)：同步请求返回音频下载地址；无法假定能按请求 ID 找回丢失的回执。
- [模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)：北京图片输出 0.18 元/张；所选无声视频 0.15 元/秒；所选 TTS 0.8 元/万计费字符。汉字按 2 个计费字符计，其他字符通常按 1 个计。
- [系统音色](https://help.aliyun.com/zh/model-studio/multimodal-timbre-list)：首轮使用预置音色，不创建个人音色。

一个成功镜头的模型费用估算约 **0.93 元**，不抵扣不确定的免费额度，不含存储、网络和本地计算。工具的预算参数只是基于价格快照的本地提交门槛，不是云账号消费硬上限。API 的 usage 是用量，不是已结算金额；`actualCost` 保持未知，以云账单核对。首次建议只批准 1 次运行，估算门槛 2 元；不要并行开多个目录自动重做。

API 固定为北京 `https://dashscope.aliyuncs.com`。官方表示该现有域名仍可用；本轮不开放自定义服务地址，也不假定项目现有文字模型密钥已经开通媒体模型。正式生产前再落实业务空间专属域名、数据留存、商用条款与配额。

## 工具边界

代码只位于 `scripts/real-media-pilot/`，不修改 Web、API、Worker、数据库、旧提示词或原合成器。素材保存在仓库外，既不注册成业务 Asset，也不伪装成 Mock 素材。

现有产品需要后续单独完成这些接入点：

| 代码位置 | 已核验的限制 | 正式接入工作 |
| --- | --- | --- |
| `apps/worker/src/runtime/start-runtime.ts` | 媒体入口硬接 Mock | 路由到真实媒体适配器 |
| `packages/database/src/runtime-store.ts` | 等待外部结果的查询排除媒体任务 | 持久化提交意图、外部 ID、轮询与恢复 |
| `apps/worker/src/runtime/mock-av-generation.ts` | 预先计算 Mock 请求 ID | 处理“远端受理、本地未获 ID”的未知状态 |
| `packages/domain/src/compose-preflight.ts` / `compose-render.ts` | 只接受 Mock 存储和 Mock 请求标识 | 通用持久素材与来源验证 |
| `apps/worker/src/runtime/compose-job.ts` | 源素材上限 1 MiB，并依赖 Mock 目录 | 真实对象存储、受控下载、合理大小限制 |

因此，**独立工具生成了 MP4，也不等于网页制作链已经接通**。生产中的 Mock 禁用规则应继续保留。

## 恢复和验收规则

- 图片和视频每阶段最多提交一次。有任务 ID 就只查询；任务和结果链接有有效期，应及时下载。
- 提交前原子记录意图。同一目录只能由一个进程运行。POST 超时、断连或崩溃可能已经扣费，无任务 ID 时保留未知状态并停止，不能靠重发“修复”。
- 没有依据宣称供应商提供幂等提交。TTS 同步回执丢失同样停止，不自动重做。
- 已保存的素材按 SHA-256 验证后复用；换提示词或修改素材不能冒用旧运行。
- 结果下载不携带 API 密钥，只访问允许的官方 OSS 主机，限制大小；文档中的 HTTP OSS 地址只升级成 HTTPS。凭据、签名下载 URL、原始错误响应不进入公开证据。
- 合成前检查配音时长。原合成器会截断过长音频，所以工具先拦截，不允许把半句话当成成功结果。
- FFmpeg 探测和解码通过只能证明技术格式。需要人实际看画面、听完整旁白，确认主体、动作、无明显畸变和无截字。证据默认 `visualReview: pending`。

本轮无 Migration、无部署、不合并 PR #68。离线契约测试使用手写供应商响应，合成测试使用本机合成的测试图像/视频/音频；这些结果不能标为“真实 AI 生成通过”。

## 执行方式

需要 Python 3.10+，`ffmpeg`、`ffprobe` 在 PATH 中，FFmpeg 含 libx264 编码器。先使用离线 plan 检查配置和估算。真实 run 还需要北京百炼密钥、媒体模型可用资格以及明确的费用授权。密钥只放本地进程环境变量 `DASHSCOPE_API_KEY`，不要粘贴到聊天、命令历史或提交入库。

使用独立终端和独立检出目录，不切换 Claude Code 正在工作的主目录分支。以下 Windows PowerShell 命令仅准备代码，不调用模型。目标目录已存在时先检查，不覆盖：

```powershell
git -C D:\Projects\ai-drama-studio fetch origin
git -C D:\Projects\ai-drama-studio worktree add --detach D:\Projects\ai-drama-media-pilot origin/feat/real-media-pilot
Set-Location D:\Projects\ai-drama-media-pilot
python scripts/real-media-pilot/pilot.py plan
```

无参数执行也等价于 `plan`，只打印配置与费用估算，不创建远端任务。默认旁白的保守估算为 0.93176 元；工具将所有码点均按两个计费字符预估，所以标点也有余量。

用户确认模型开通和本次费用后，在本地输入密钥（输入内容不显示，不把密钥写进命令历史），运行一次：

```powershell
$pilotSecret = Read-Host "百炼北京 API Key" -AsSecureString
$env:DASHSCOPE_API_KEY = [System.Net.NetworkCredential]::new("", $pilotSecret).Password
try {
    python scripts/real-media-pilot/pilot.py run --output D:\Projects\ai-drama-media-runs\shot-001 --allow-paid --max-estimated-cny 2
} finally {
    Remove-Item Env:\DASHSCOPE_API_KEY -ErrorAction SilentlyContinue
    $pilotSecret.Dispose()
}
```

输出目录必须是仓库外的新目录。运行完成后查看其中 `output.mp4`、`narration.txt` 与 `evidence.json`，按上文验收标准看画面、听配音。素材和运行状态不要提交入库。

中断后仍使用原目录：

```powershell
python scripts/real-media-pilot/pilot.py resume --output D:\Projects\ai-drama-media-runs\shot-001
```

未完成的外部任务查询需要先重新设置同一账号、同一地域密钥；上面的 `finally` 会清除密钥。不带付费参数的 `resume` 可以查询已有任务、复用已完成素材和继续本地合成，但不会提交尚未开始的下一阶段。要继续该运行中尚未开始的阶段，才给 `resume` 加 `--allow-paid --max-estimated-cny 2`，总估算仍按整次运行计算。

出现 UNKNOWN 时不要换目录自动重做，先按已存的任务或请求编号核对控制台。发现 `run.lock` 时先确认原进程已结束；工具不自动抢锁。进程崩溃恢复有保护，供应商没有提交幂等承诺，操作系统/磁盘故障也不等于可以无条件重发。

## 离线验证

```text
python -m unittest discover -s scripts/real-media-pilot -p test_pilot.py -v
python -m unittest discover -s scripts/real-media-pilot -p test_compose_smoke.py -v
```

第一组使用注入的测试响应，不连接供应商。第二组需要本地 FFmpeg，生成测试图、运动画面和正弦波音频，验证工具完整流程、已有合成器以及完成后的零请求恢复；没有真实人物图、模型视频或人声效果证据。独立 GitHub workflow 只运行这些离线检查，不配置模型密钥。

本轮本地验证：Python 3.12.14、FFmpeg 6.1.1，29 项协议/恢复测试与 2 项合成测试全部通过；工作流 YAML 与 Python 语法检查通过。未调用真实模型，未执行 Windows 本机试跑，未运行整个业务仓库的 Node 测试。Windows 兼容性由独立工作流中的对应任务继续核验，不能用 Linux 结果替代。
