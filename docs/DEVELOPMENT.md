# Translator for Zotero 开发与交接

本文档用于在另一台电脑上继续开发和发布 Translator for Zotero。用户使用说明位于仓库根目录 [README.md](../README.md)，架构与模块交接见 [HANDOFF.md](HANDOFF.md)，版本变化见 [CHANGELOG.md](../CHANGELOG.md)。

## 产品边界

- 运行环境：Zotero `9.0`–`9.*` 内置 PDF Reader。
- 正式源码：`plugin/`。
- 插件 ID：`reader-selection-replacer-test@local.kumiko`。
- 支持：标题/摘要自动翻译、手动选区翻译、可复制译文、按页切换原文/译文。
- 不支持：整页正文翻译、OCR、EPUB、第二阅读器视图和翻译历史管理。
- Provider：千问 `qwen-mt-plus`、DeepSeek `deepseek-v4-flash`、Gemini
  `gemini-2.5-flash`，以及实验性的 Bing、Tencent Transmart、CNKI 免密钥网页接口；
  目标语言为 `zh-CN`。

Gemini 使用需要 API Key 的官方 Gemini API。Bing、Tencent Transmart 和 CNKI 使用
网页或内部接口，不是对应厂商承诺稳定性的公开开发者 API；这三个接口不需要用户
API Key，但可能受到限流、验证码、地区网络和接口变更影响。Provider 失败时不自动
切换其他服务，调用方应让用户手动重试或选择其他 Provider。API Key 应通过 Zotero
登录管理器保存，不要写入源码、测试夹具或提交记录。

侧栏提供六个 Provider 的三列模型卡片。新安装或没有有效偏好时显示“未选择模型”，
不会自动发起翻译；用户选择 Provider 后才会执行翻译。Qwen、DeepSeek 和 Gemini
显示 API Key 配置区，Bing、Tencent Transmart 和 CNKI 不显示密钥配置区。

模型选择面板只保留 Provider 区域折叠；未选择 Provider 时当前模型栏显示“选择翻译模型”，选择后只显示模型英文名。窄栏仍保持三列，极窄时隐藏卡片文字
并只保留图标。卡片使用 `plugin/icons/` 中随 XPI 打包的高清本地图标，不再渲染中文说明。卡片使用图标主色作为背景，无额外图标边框；图标浮在左侧，英文模型名位于右侧。

内部插件 ID 和部分 CSS/本地化标识仍保留历史名称，这是为了兼容已经安装的插件实例，不应仅为“看起来更整齐”而修改。

## 新电脑准备

安装以下工具：

- Git；
- Node.js 20 或更高版本；
- PowerShell 7 或 Windows PowerShell；
- Zotero 9.x，用于人工验收；
- GitHub CLI，可选，用于发布流程。

```powershell
git clone https://github.com/Kumiko-kmk/Translator-for-Zotero.git
Set-Location Translator-for-Zotero
```

插件 JavaScript 不依赖 npm 包，因此无需执行 `npm install`。

## 目录与职责

| 路径 | 职责 |
| --- | --- |
| `plugin/bootstrap.js` | Zotero Bootstrap 生命周期与模块加载顺序 |
| `plugin/core.js` | 插件常量、Provider UI 元数据、本地化及位置通用工具 |
| `plugin/app-controller.js` | 应用状态、Reader 监听、侧栏注册和各控制器组合 |
| `plugin/front-matter-extractor.js` | 首页标题/摘要、视觉行、单双栏和段落分析 |
| `plugin/reader-target-locator.js` | 父条目元数据读取及标题/摘要目标定位 |
| `plugin/page-text-index.js` | PDF 页面文字索引、坐标投影和视口缩放转换 |
| `plugin/selection-block.js` | 选区跨页、单双栏分组和段落边界分析 |
| `plugin/content-segments.js` | 标题、摘要与选区文本的统一分段对象 |
| `plugin/translation-service.js` | Provider、密钥、请求、校验和翻译缓存 |
| `plugin/overlay-layout.js` | 覆盖块几何分组、译文分配、字号和行距测量 |
| `plugin/overlay-renderer.js` | 覆盖层 DOM、原文/译文切换和状态渲染 |
| `plugin/reader-overlay.js` | 覆盖层状态、页面窗口、事件绑定和增量重绘 |
| `plugin/provider-panel.js` | Provider 卡片、密钥配置、结果预览和复制交互 |
| `plugin/translation-workflows.js` | 标题/摘要自动翻译及手动选区翻译工作流 |
| `plugin/manifest.json` | 发布版本、插件 ID 和 Zotero 兼容范围的唯一来源 |
| `plugin/icons/`、`plugin/locale/` | 插件图标与中英文界面字符串 |
| `tools/build_xpi.ps1` | 唯一受支持的 XPI 构建与验包入口 |
| `docs/HANDOFF.md` | 运行架构、模块依赖、状态所有权与维护边界 |
| `docs/images/` | GitHub README 图示，不打入 XPI |

发布二进制不提交进 Git。`dist/` 是本地临时输出目录，正式附件只发布到 GitHub Releases。

## 数据与安全

- API Key 通过 Zotero/Firefox Login Manager 保存，不进入源码和翻译数据库。
- 成功译文缓存在 Zotero 数据目录的 `paper-assistant-segment-translations.sqlite`。
- 缓存按 Provider、模型、提示词版本、原文和目标语言隔离。
- PDF 必须带文字层；扫描件需先由外部工具 OCR。

## 开发检查

修改前先确认工作树：

```powershell
git status -sb
```

JavaScript 语法检查：

```powershell
Get-ChildItem plugin -Filter *.js | ForEach-Object { node --check $_.FullName }
```

完成语法检查后，使用固定构建脚本生成 XPI，再通过 Zotero 人工验收运行效果。

## 排版与性能约束

选区译文必须同时满足：

- 水平和垂直均不溢出；
- 保留首行缩进、连续段落末行语义和单双栏拆分；
- 文本节点以真实内容高度测量，不能设置回 `height: 100%`；
- 字号与行距联合调整，目标高度利用率约 `95%`，正常接受区间为 `90%`–`98%`；
- 单块首次排版最多 8 次 DOM 测量，布局签名不变时命中缓存；
- 覆盖层仅挂载当前页及前后各一页；
- 原文/译文切换使用 CSS 快速路径，不重新测量文字。

1.2.0 已完整移除 `page-body`、`translatePage()`、页面翻译 session 和 `extractPage()` 整页请求链。不要从旧提交或旧 XPI 复制这些实现回来。

## 固定构建流程

在仓库根目录运行：

```powershell
.\tools\build_xpi.ps1
```

脚本会：

1. 从 `plugin/manifest.json` 读取版本；
2. 核对 `core.js` 内版本；
3. 验证插件 ID、更新地址和 Zotero 兼容范围；
4. 仅打包固定运行文件，不包含 README、测试、截图或临时文件；
5. 检查 XPI 根目录和文件清单；
6. 临时包通过验证后原子替换正式产物；
7. 输出大小和 SHA-256。

产物路径：

```text
dist/Translator-for-Zotero-<manifest-version>.xpi
```

不要手工压缩源码目录、不要向脚本传入另一套版本号，也不要编辑生成后的 XPI。

## Zotero 人工验收

1. 完全退出 Zotero，确认没有残留进程。
2. 从 `dist/` 安装刚构建的 XPI 并重启 Zotero。
3. 打开带文字层的单栏与双栏英文论文。
4. 检查右侧栏、Provider 切换、密钥保存和验证。
5. 检查标题与摘要自动翻译和独立重试。
6. 翻译完整段落、段落片段、多行选区和双栏选区。
7. 检查译文可选择复制，按钮和 P1/P2 标签不进入复制内容。
8. 从页面顶部与底部切换原文/译文，确认状态同步。
9. 检查高覆盖块接近填满但不溢出，缩放后重新排版正确。
10. 连续滚动长文档，确认只有三页覆盖层常驻且无明显卡顿。
11. 验证断网、无效 Key、超时和手动重试路径。

## 发布流程

1. 更新 `plugin/manifest.json`、`plugin/core.js`、README、CHANGELOG 和版本断言。
2. 运行全部 JavaScript 语法检查。
3. 使用 `tools/build_xpi.ps1` 生成 XPI 并记录 SHA-256。
4. 检查 `git status`、`git diff --check`，只提交本次范围。
5. 推送发布分支，创建 PR，人工检查后合并到 `main`。
6. 从合并后的 `main` 创建带注释标签，例如 `v2.0.0`。
7. 创建 GitHub Release，将 `dist/` 中对应 XPI 作为附件上传。
8. 从 Release 下载附件再次安装，完成最终人工验收。

```powershell
git status -sb
git diff --check
git add <明确文件列表>
git commit -m "release: Translator for Zotero x.y.z"
git push -u origin <release-branch>
gh pr create --base main --head <release-branch>
gh pr merge <pr-number> --merge --delete-branch
git switch main
git pull --ff-only origin main
git tag -a vx.y.z -m "Translator for Zotero x.y.z"
git push origin vx.y.z
gh release create vx.y.z dist/Translator-for-Zotero-x.y.z.xpi
```

## 故障排查

- **XPI 无法安装**：确认使用固定脚本、XPI 根目录含 `manifest.json`/`bootstrap.js`，并完全重启 Zotero。
- **侧栏不出现**：查看 Zotero Error Console；确认插件启动和侧栏注册重试完成。
- **无法选择 PDF 文本**：PDF 缺少可复制文字层，需要先 OCR。
- **译文选不中**：确认页面处于“显示译文”，覆盖文本的 `user-select` 为 `text`。
- **覆盖块上部拥挤、下部空白**：检查测量节点是否误设为 `height: 100%`，以及缩放后缓存是否失效。
- **滚动卡顿**：检查是否重新引入定时全量重绘、全页记录扫描或超过三页的常驻覆盖层。
- **翻译失败**：检查 Provider、API Key、账户额度、地域端点和网络，再手动重试。

## 交接完成标准

另一台电脑能够从全新克隆开始，完成基础语法检查、XPI 构建、Zotero 安装和至少一次人工翻译验收，即视为环境交接完成。交接时同时提供目标提交、Release 地址、XPI SHA-256、已知限制和未完成 Issue。
