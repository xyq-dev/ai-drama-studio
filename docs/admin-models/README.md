# 管理员模型配置截图与证据

本目录的截图和 `browser-evidence.json` 来自 GitHub Actions **Admin model settings** 工作流（PR #64）：

- 源码提交：`11a8c92853344d6774f2656831503d54ece557d5`（模型选择器界面，含 PR #64 审查修复）
- 运行：run `38070134781`，artifact `admin-model-settings-evidence`
- 环境：`ubuntu-24.04`，Node 24.21.0，Playwright Chromium，Noto CJK 字体
- 脚本：`scripts/admin-models-browser-acceptance.mjs`（`ADMIN_MODELS_BROWSER_ACCEPTANCE=local-temporary-storage`）

测试链路：真实浏览器 → 生产构建的 Next（页面代理）→ Nest 站点登录与管理员控制器 → 临时加密配置文件。

范围：
- 不连接应用数据库，不请求任何模型供应商（`modelCalls: 0`）。
- 登录密码为每次运行生成的测试值，供应商密钥是固定的假字符串；两者都不写入证据，脚本也会断言接口回读和浏览器存储中不出现它们。截图不含真实密钥、会话 Cookie 或令牌。
- 这是管理后台的界面与保存流程验收，不是供应商验收。截图里的模型只表示能被选择并保存，不代表账户已开通或模型已被真实调用。

截图：
- 桌面 1440px：`desktop-login.png`、`desktop-models-empty.png`、`desktop-model-picker.png`（键盘选择候选、通过高级设置添加自定义 ID、选择默认模型；同一运行还检查了在搜索框按 Enter 不会提交表单）、`desktop-models-saved.png`
- 手机 390px：`mobile-models-saved.png`、`mobile-openai.png`（只显示 OpenAI 自己的候选，已选模型但尚未选择默认模型）、`mobile-login.png`

每张截图都检查过无横向溢出（`scroll` = `width`）。旧的文本输入框截图已被本次运行的截图替换。
