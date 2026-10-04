# drama-skills 来源清单

本文件记录本轮实际读取并改编的上游材料。运行时不会从 GitHub 下载 latest，也不会执行上游安装脚本。

| 项 | 值 |
| --- | --- |
| 上游 | https://github.com/zenstory-ai/drama-skills |
| VERSION | 0.8.1 |
| commit | c2426e03c0e7722bebcc6a488b6658dc38c65ac3 |
| 许可 | MIT，版权声明见 `third_party/drama-skills/LICENSE` |
| 版权 | Copyright (c) 2026 drama-skills contributors |

完整 MIT 许可文本已按该提交的 `LICENSE` 原样保存。这些创作建议不是 AI Drama Studio 的平台审核规则，也不会自动给出 APPROVED 或 CURRENT。

## 读取的文件与 SHA-256

| 文件 | SHA-256 |
| --- | --- |
| LICENSE | 840bdb5ba503ca4397f5a6049e6e8da182330f83bb70006d5656d7dd00674e9b |
| skills/short-drama-develop/SKILL.md | ef05a00f6ba8735547c785655b0e52d9bdca3aa1d7396e51900a0c9fc4ce3953 |
| skills/short-drama-develop/references/story-craft.md | b15a911cb6418b87edc7a40cf439b63c8301fba0830f9dd9325a65efd3e21259 |
| skills/short-drama-develop/references/episode-design.md | 4e404b4de7d1c7c3687bfbfd0ceeb1cdf9bbbac4a74f60167ebed61585964b57 |
| skills/short-drama-write/SKILL.md | da55f07db5d92ec63192fc7510fc52cc0e7f5142050155c8d5945a02eb82e111 |
| skills/short-drama-write/references/screenplay-format.md | 809b6033554899224c387d548aad096cfe469930fe0c0d713bfde732841a1dfa |
| skills/short-drama-write/references/dialogue-craft.md | c67a0487e56d2e2b30ae13ff76a140d3629da5ddb76809c81e73ed521e6387d2 |
| skills/short-drama-review/references/rubric-story-script.md | f0cc27d7446f06751262dd69e7c9d6cb4f04d72f1186e8721a22cbf996dc5928 |

没有导入上游示例小说、图片、视频或品牌素材，也没有引入 Toonflow。

## 本项目的改编

上游故事开发使用创作简报、故事引擎和 `episode-map.jsonl`。上游单集写作使用 Markdown 剧本：集标题 `# EP001`，场景标题 `## EP001-SC001`，对白 `角色：台词`，声音标记如 `[SFX]`。审查量表只被当作创作自检问题，不接成平台审核。

本项目改成两种 JSON 候选，再整理成现有编辑器的 `content.text`：

| 候选 | 实现 |
| --- | --- |
| `ads.writing.story-plan.v1` | `packages/contracts/src/writing-assistant.ts` |
| `ads.writing.episode-draft.v1` | `packages/contracts/src/writing-assistant.ts` |
| 指令、校验、格式化、采纳条件 | `packages/domain/src/writing-assistant.ts` |
| 工作台入口与草稿采纳 | `apps/web/src/components/writing-assistant.tsx`，故事和分集剧本编辑区 |

这是本项目的候选契约，不是上游原生交付格式。
