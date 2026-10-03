# M4_THREE_EPISODE_SAMPLE_REPORT

## 目录、分支与 SHA

- 工作目录：`D:\Projects\ai-drama-studio`
- 目标分支：`feat/m4-three-episode-sample`
- 起点：`c187f08011dba61060ed7c37a84b764fd11a1f32`（`origin/feat/m4-project-cost-summary`，含已验收源码 `174a6bd564ca77d03241eef13de30271acf4c3ff`）
- 功能验收 SHA：`a92bafb4d6f0647f666ef3fb78bde003e1856b37`
- 390px 验收 SHA：`15b76676e487a9a4550f0f80e228f4195e046bce`
- 报告 SHA：见本文件提交
- `origin/main` 保持 `6548ffe07f54a03ac2c5547d7b724cb329af5932`
- `origin/feat/m4-project-cost-summary` 保持 `c187f08011dba61060ed7c37a84b764fd11a1f32`

## 修改原因与影响范围

同一个项目需要三集技术样片：4×15 秒、5×15 秒、6×15 秒。现有 Mock 视频只有 1 秒，不能靠拉伸、循环或放宽 30 镜、90 秒、64 MiB、渲染超时和并发来凑时长。

因此只扩展 `POST /shot-revisions/:revisionId/generate-video` 的可选 `fixtureId`，取值仅 `sample-15s-a-v1` 与 `sample-15s-b-v1`。不传该字段时，普通 1 秒视频的快照、请求 ID 和输出字节保持不变。图片、配音、字幕、音乐不接受 `fixtureId`。

样片开关 `M4_MOCK_SAMPLE_VIDEO_ENABLED` 默认关闭，生产环境强制关闭。创建、Worker 执行和恢复同时要求该开关、现有 AV 开关、绝对 Mock 对象目录和既有配置。内容读取、合成、审核和导出仍走现有 AV 与对象目录规则，不因开关关闭撤销已生成资产。

影响范围：contracts 中的样片描述与请求身份，providers 中的两份固定 MP4，API/Worker 的视频生成与恢复，合成资格的严格样片分支，以及隔离验收。未改 Python 渲染、渲染 profile、账本规则、历史补账、M2 草稿或 1 秒视频 fixture。

Migration=NO。未新增 Migration，未执行 DROP SCHEMA，未重置既有库。

## 固定样片

两份文件在本机用 ffmpeg `N-116507-gbcf08c1171-20240801`、libx264（成片标记 Lavc61.11.100）和 `C:\Windows\Fonts\arial.ttf`（Arial）离线生成后提交。底色分别为 `0x1A4FBF` 与 `0xC45A12`，画面持续显示 MOCK A / MOCK B，并用帧号和 pts 让首、中、尾可辨。无音轨，无真实人物、商用素材或模型输出。生成命令和探测记录在 `packages/providers/fixtures/sample-video-generation.txt`。

CI 用固定的 ffmpeg `7:6.1.1-3ubuntu5` 探测并完整解码已提交文件，`regenerated=false`。

| fixtureId | 字节 | SHA-256 | 探测 |
| --- | --- | --- | --- |
| sample-15s-a-v1 | 28643 | `4f46bf904a42c7d3acd0cda9d37ccaa2de71dda095a6f91a83c211d5d48f04e7` | 180×320，H.264，yuv420p，5 fps，75 帧，15.000000 秒，无音轨 |
| sample-15s-b-v1 | 28392 | `21f1c5ac372b71337e2a615e3994fdbf812aa79b7a7dc0a88c6de13401e8e60f` | 同上 |

冻结 schema 为 `m4.mock.sample-video.v1`。请求 ID 为 `mock-media|sample-sync-v1|video.generate|<fixtureId>|<jobId>:<attemptNo>`。描述在 contracts，二进制在 providers。domain 只依赖 contracts。

## 三集成片

独立项目 `f3b01833-73a3-4ef3-b637-7a0ac93197e5`，标题与正文为技术验收样片。同一故事下三集剧本已审核，场景与镜头为 CURRENT。15 个逻辑镜头各自生成 VIDEO Asset。每集第 1 个镜头另走现有 Mock 配音、音乐和字幕；它们仍是短静音和固定字幕，不是朗读或音乐质量验收。

顺序：第 1 集 A、B、A、B；第 2 集 B、A、B、A、B；第 3 集 A、B、A、B、A、B。全部单镜成片先批准，再由浏览器走现有预检、多镜合成、批准和下载。故障与开关负例在另一项目 `fe364dcf-f8e4-476d-a7c1-bbd9ff2d4974`，没有改写这三集的最终状态。

输出为 1080×1920。Chrome 以 16 倍速实际播放到 ended，解码帧数与 25 fps 时长一致。ffprobe、Asset 与浏览器时长差均为 0 ms，业务 90 秒上限未放宽。

| 集 | 镜头 | 目标 | Asset / 下载 SHA-256 | 字节 | 集级合成 |
| --- | --- | --- | --- | --- | --- |
| 1 | 4 | 60000 ms | `465e48daf93f92ba903772d68740564e687719ca512b3bf3fd9116aa9c50b2c1` | 878798 | Job `a09807dd-b263-40c7-85a9-fadad97a35e1`，attempt `c80ae2b5-ba2f-4d5e-8a26-08cccab8d964`，15148 ms |
| 2 | 5 | 75000 ms | `d2c6a547095ed222f624102b2fd3d37f64bbd95370e148f3d7e629012c452d7d` | 1095004 | Job `23a4e984-d0a0-4139-ab54-d9ffe9f4e616`，attempt `038fba0f-3c17-4cbf-be7f-fbd478b91c80`，18178 ms |
| 3 | 6 | 90000 ms | `1d54551c83212a072ff64eeb4c85306389e4fc46c31493a4a28a6ce6ed067e54` | 1312728 | Job `cc32feac-dc18-4319-94ea-af67e5a4088d`，attempt `8b4ee075-10ea-44ae-a3e2-4bb89d170532`，21213 ms |

三集成片均为 ACTIVE + APPROVED。审核哈希等于成片 SHA-256。来源清单的 Job、attempt、15000 ms 分段和依赖边与数据库一致。每个 15 秒分段的首、中、尾抽帧颜色符合 A/B 顺序，三段帧哈希彼此不同。最终 MP4 经 ffmpeg 完整解码。390px 横向溢出为 0。

## 恢复、成本与只读窗口

样片恢复发生在真实 Worker 上：Job `794a8ae7-ed94-44a2-b5c2-0ed635f37543`，attempt `416157f2-94bc-459f-8e1d-041c16177922`，请求 ID `mock-media|sample-sync-v1|video.generate|sample-15s-b-v1|794a8ae7-ed94-44a2-b5c2-0ed635f37543:1`，Asset `2aeed46a-0ad6-4e13-92ee-d775ad1eb35a`，一条 ACTUAL USD 0。原 attempt 与请求未变。本次没有测量 Worker submit 次数。

开关关闭后，已绑定样片 Job `ffbb7c7e-0a3f-485f-89aa-c9665158be23` 以 `MOCK_MEDIA_NOT_CONFIGURED` 结束，没有 Asset 或成本。随后普通视频 Job `332cbde6-14cb-4a64-b55c-dc4e6d5ad8a4` 仍以 1 秒成片成功。

该样片项目账本为 24 行 ACTUAL USD `0.00000000`。15 次单镜合成和 3 次集级合成共 18 次本地编码没有账本行，页面沿用“本地编码等成本尚未计量”的既有说明。这不是完整生产成本。

交付读取窗口内，三份 MP4、三份 JSON 清单和成本 GET 没有改变十张业务表的指纹：

| 表 | 行数 | 指纹 |
| --- | --- | --- |
| generation_job | 161 | `cc643f9f35d2ee1de02aa03c81a3c4f4c58d6ac55c283cb37b95028f86184c57` |
| job_attempt | 165 | `c7b97f990bebab342bf00050e6227bb8583b1bfa910949e630f8c0aaec078a8c` |
| workflow_run | 161 | `e6c078d296f9e70cb4a3c69d2e86c9898899ce55c946e10e576b20d854ae3f9a` |
| asset | 157 | `3ac4f10c5e7ecc50c2df1ac452922c875561548ca7587d62432950c4d32d3484` |
| cost_ledger | 87 | `d1be71c2ab4f79a6a7f6b94885cba90829d29626daf29fd442142b97defc4df1` |
| dispatch_outbox | 156 | `54df4c5bfe2b402ba2714c5f4df88aca30127ec247c267ad15b4c0c6c26efd0b` |
| domain_event | 1395 | `d325ebaaa858a4b74d92286c8d3fa31e68d29567b8a7ac345681eb809177e8af` |
| asset_dependency | 90 | `567dae308bf7bea4a3b450e4cc9ee1e808cd292d01011642215039369493f9e3` |
| asset_revision_dependency | 333 | `d30402389f7de80c9e8a5b2fbd01b1576e1122301195239c3fca970bae9824af` |
| idempotency_record | 529 | `3d25acfab80ed489c4252836028c80d10ce5240cfdccd5125ccbbf4a6b8718a1` |

## 模拟测试与真实执行

定向测试在进程内检查 1 秒视频兼容、冻结快照、请求身份、全新 adapter 的 inspect/resolve、对象写入失败后的原 attempt、损坏内容、开关和合成资格伪装。它们不代替真实渲染。

390px 验收把测量移到页面就绪之后。视口保持 390×844。第 3 集目标 Asset `6483feff-f25a-4243-a012-8143d4f99457` 的卡片为 ACTIVE + APPROVED，下载 MP4 与来源清单按钮具有正尺寸边界框，video 的 `readyState` 为 4，尺寸 1080×1920，时长 90000 ms。随后测得横向溢出 0，并截取整页 `docs/m4-three-episode-sample-390.png`（390×1518）。页面未出现上述元素时，等待会超时并使阶段失败。

![第3集 390px 已加载成片](m4-three-episode-sample-390.png)

真实闭环是 GitHub Actions run `37098825112` attempt 1，job `111134146403`，HEAD `15b76676e487a9a4550f0f80e228f4195e046bce`。隔离库 `m3av_37098825112a1` 在迁移前 `public_tables=0`，随后只应用已有 migration。Worker、FFmpeg 6.1.1 和 Chrome 完成合成、播放、抽帧、完整解码与下载。证据包 artifact `11265915715` / `m4-three-episode-sample-e2e-evidence`，13654252 字节，SHA-256 `469759f3396ebeb3ae1439f96c710a47ddf24ec69f44beab843f9a381b7ab9a1`。

52 个必需阶段全部 passed。无 skipped、failed、fatal、restore 或 cleanup 失败。compose down 退出码 0。

## 未执行项与剩余边界

未测量样片 Worker 的 submit 次数。未开放普通用户可见的 fixture 选择器。样片开关在生产环境保持关闭。未接入真实 Provider、付费模型或 ComfyUI，未做时间拉伸、循环凑时长、任意上传或外部 URL。账本只记录 Mock ACTUAL 0；本地编码未计量，完整生产成本仍未知。

三集长时技术样片闭环通过。
