# 真片启动一次批（短清单）

更新：2026-11-03（Asia/Shanghai）。样片目标：《末班车暗号》双角色 4 句中文对白 → 真实 TTS 试听 →（后续）字幕合成导出。  
**本文件可勾选授权；勾选前禁止付费 generate / provision `--execute` / 业务库 SQL。**

详细条款仍见 `docs/FIRST_REAL_SHORT_AUTH_PACKET.md`。本地已到 `voice_plan` 的证据：`scripts/grokbot-native-tools/fixtures/moban-che-anhao/`。

## A. 服务器只读（需 SSH 或等价只读通道）

- [ ] 主机与登录方式（填）：`________________`
- [ ] 运行 SHA（`drama.playhubs.cn` 实际）：`________________`
- [ ] API / Worker 进程在跑；`GET /api/v1/health/ready` postgres/redis/对象存储 ok
- [ ] 中文字幕字体路径存在（填）：`________________`
- [ ] FFmpeg 可用
- [ ] 真实媒体 / speech 开关当前值（只读记录，不改）：`________________`
- [ ] 回退版本/镜像标签（填）：`________________`

## B. 业务库 drafts（只审阅，本提示不授权执行）

目标库（填）：`________________`（staging / 指定测试库；非生产除非另批）

| 草案文件（仓库内精确路径） | 已审阅 | 允许执行 |
| --- | --- | --- |
| （填 draft SQL #1） | [ ] | [ ] |
| （填 draft SQL #2） | [ ] | [ ] |
| （填 draft SQL #3） | [ ] | [ ] |

- [ ] `real-media:provision` **plan** 已跑（无 `--execute`）
- [ ] 另文授权后才允许：`real-media:provision --execute`（写 ProviderConfiguration）

备份/恢复：`________________`

## C. 费用上限（一场四句，一次外部合成）

先前「最多 4 次百炼逐句提交、建议预留 12 次」的试点已取消。ElevenLabs `eleven_v4` 把《末班车暗号》整场作为一次 text-to-dialogue。单价键是 `ELEVENLABS_TTS_PRICE_CHARACTER`（USD/字），不是 `ELEVENLABS_MEDIA_PRICE_MUSIC_SECOND`。`pcm_44100` / `wav_44100` 需要 Pro 及以上，账号拒绝时不降级。

| 项 | 填写 |
| --- | --- |
| 币种 | USD |
| 外部 TTS 次数 | 1（同一幂等键的重试不算新提交；UNKNOWN 不自动重发） |
| 字符单价 `ELEVENLABS_TTS_PRICE_CHARACTER` | `______` |
| 本场费用上限 | `______` |
| 图片/视频是否本轮启用 | 否 / 是（若是另填上限）`______` |
| 文本模型本轮是否启用 | 否（样片已有人工稿）/ 是 `______` |
| 超出即停 | [ ] 同意 |

本地 `voice-plan`：《末班车暗号》`dialogueLines=4`，`plannedTtsCalls=1`。

## D. 人工门（Bot 不代批）

- [ ] 剧本 APPROVED（本地已可用 CLI 记录 actor）
- [ ] 场景/分镜 APPROVED
- [ ] 每句试听后**人工选用**声音候选
- [ ] 成片主观画面/听感最终确认人：`________________`

## E. 一次批结论

- [ ] **批准真片启动**（A 只读完成 + B 执行范围已勾 + C 数字已填 + D 确认）
- [ ] 暂缓；缺口：`________________`

签名/日期：`________________`（Asia/Shanghai）
