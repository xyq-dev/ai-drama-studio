# Repo Engineer brief — push `feat/grokbot-native-drama-tools` (extend #103)

更新：2026-11-03（Asia/Shanghai）。Executor **无** `gh`/`git push` 凭据；请代推并更新 Draft PR #103。

## 目标

- 分支：`feat/grokbot-native-drama-tools`
- PR：https://github.com/xyq-dev/ai-drama-studio/pull/103 （Draft 保持 Draft 即可，或按主人意愿 Ready）
- Base：`main`（已含 #102 @ `83b61e5`）
- **禁止** force-push、prod 部署、业务库 SQL、`real-media:provision --execute`、付费 generate

## 本批相对 remote `686467b` 的新增

| 路径 | 改动 |
| --- | --- |
| `scripts/grokbot-native-tools/store.mjs` | approveScript / setCharacters / setStoryboard / approveScene / voicePlan；status.stage 至 voice_plan |
| `scripts/grokbot-native-tools/cli.mjs` | 对应子命令；live 拒绝 approve/voice |
| `scripts/grokbot-native-tools/cli.test.mjs` | 全环 + repro + live refuse（10 passed） |
| `scripts/grokbot-native-tools/fixtures/moban-che-anhao/` | script/characters/scene + `repro.sh` |
| `docs/GROKBOT_NATIVE_TOOLS.md` | 扩展命令与复现说明 |
| `docs/FIRST_REAL_SHORT_ONE_SHOT.md` | 真片启动一次批（SSH / drafts / 费用上限） |
| `docs/PUSH_BRIEF_NATIVE_TOOLS.md` | 本 brief |
| `docs/REAL_PRODUCTION_COMPLETION_PROGRESS.md` | 进度注记 |
| `grokbot-skills/ai-drama-native-tools/SKILL.md` | Skill 草案同步 |

## 建议操作

```sh
cd <checkout>
git fetch origin
git checkout feat/grokbot-native-drama-tools
# 若 box commit 已在别处：cherry-pick 或 patch apply
git pull --ff-only origin feat/grokbot-native-drama-tools   # tip was 686467b
# apply/commit if needed, then:
node scripts/grokbot-native-tools/cli.test.mjs   # expect 10 passed
git push origin HEAD:feat/grokbot-native-drama-tools
# PR #103 自动更新；勿 force
```

## 验收口述

本地 `ADS_LOCAL_STORE=… bash …/fixtures/moban-che-anhao/repro.sh` → `stage=voice_plan`，`plannedTtsCalls=4`，无付费调用。
