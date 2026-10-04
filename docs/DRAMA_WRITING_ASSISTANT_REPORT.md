# 编剧助手报告

本轮接入了创作方法、候选导入和草稿采纳。尚未接通网页一键模型生成，没有发生付费调用。

## 现场

| 项 | 值 |
| --- | --- |
| 目录 | `D:\Projects\ai-drama-studio-writing-assistant` |
| 分支 | `feat/drama-writing-assistant` |
| 起点 | `a5651f7ebd5c0c65acc1410a067eb02c61d9b269`（`feat/commercial-creator-ui` 的审查修复） |
| 实现提交 | `aae87269183e38ed5ee9a7e26d91aa24eba17b7a` |
| PR #42 | 仍为 Draft，未合并。本分支的 Draft PR 以 `feat/commercial-creator-ui` 为 base |

主仓库的千问试接分支和证据目录没有被修改。没有 reset、clean、stash，也没有改 `main`。

## 上游

固定版本 0.8.1，commit `c2426e03c0e7722bebcc6a488b6658dc38c65ac3`。许可是 MIT，全文在 `third_party/drama-skills/LICENSE`。读取文件、哈希和本项目改编位置见 `docs/DRAMA_SKILLS_SOURCE.md`。

上游 Markdown 剧本被改编成 `ads.writing.story-plan.v1` 与 `ads.writing.episode-draft.v1`。这是本项目的候选格式。创作建议不是平台审核规则。

## 操作流程

网页提示“本轮通过外部 AI 创作，网页不会自动调用模型。”没有“正在生成”或“生成成功”。

故事策划：在故事编辑区打开“编剧助手”，填写本次要求，准备并复制指令，粘贴手写 JSON，校验后查看候选正文和差异，再点“采纳到草稿”。编辑区出现整理后的正文，并提示还要用原来的“保存新版本”。

单集写作：打开第 1 集，确认已加载的故事与分集材料，再走同一套准备、导入、对比和采纳。候选必须是第 1 集。

截图（手写候选，不是模型结果；浏览器检查使用了 API 替身）：

- 故事桌面，采纳前的差异：`docs/writing-assistant-shots/story-desktop-diff.png`
- 故事桌面，采纳后的草稿：`docs/writing-assistant-shots/story-desktop.png`
- 故事 390px：`docs/writing-assistant-shots/story-390.png`
- 单集桌面，采纳前的差异：`docs/writing-assistant-shots/episode-desktop-diff.png`
- 单集桌面，采纳后的草稿：`docs/writing-assistant-shots/episode-desktop.png`
- 单集 390px：`docs/writing-assistant-shots/episode-390.png`

## 草稿与并发

采纳只调用原来的草稿记录，保留准备指令时的 If-Match，不自动 POST。导入和预览不改编辑正文，也不发写请求。正文在准备指令之后被改过时，采纳被拦住，候选保留。文件读取期间切换集、卸载后再打开原来的集，迟到结果不会写入新对象。折叠助手不会清掉编辑草稿。助手记录使用 `ads-writing:`，与 `ads-draft:` 分开。存储失败只提示，不先清编辑草稿。

这些行为由 `apps/web/src/components/writing-assistant.spec.tsx` 和 `packages/domain/src/writing-assistant.spec.ts` 覆盖。

## 验证

| 方式 | 结果 |
| --- | --- |
| contracts / domain / web 定向测试 | 通过。候选是手写夹具，并标明不是模型结果 |
| `pnpm verify` | 通过 |
| `git diff --check` | 通过 |
| 既有 harness | 没有改验收入口，未重跑 |
| 真实浏览器 | Chromium 打开本 worktree 的页面，桌面 1440 与 390px。完成打开助手、复制指令、导入、查看差异、采纳到草稿。期间 POST 次数为 0。本机 API 未参与，请求由测试替身应答 |
| 真实 API | 隔离工作流 [Writing assistant API](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37188059393)，提交 `aae8726`。路径是导入、按冻结的 If-Match 保存、重放幂等键、重读 revision，且审核状态保持 DRAFT。不调用模型。本机没有 Docker，这条没有在本机执行。工作流状态见下方 |

真实 API 工作流状态：run `37188059393` 已成功。步骤 “Import, adopt, save, and reread without a model” 的结论是 success。这是实现提交 `aae8726` 的结果。

## 未执行与遗留

- 网页不能一键调用模型。没有模型 API Key 时，指令、导入和采纳仍可使用。
- 没有付费调用，没有替换 `MockTextAdapter`，没有合入千问客户端。
- 没有新 Migration，没有改 API、Worker、数据库、审核状态机或媒体生成。
- 复制失败时指令正文仍可选；这条由组件测试覆盖。浏览器这次授予了剪贴板权限，复制成功。
- 检查用的 Chromium 是英文界面，文件按钮显示 “Choose File”。旁边的文字是“导入 UTF-8 JSON”。
