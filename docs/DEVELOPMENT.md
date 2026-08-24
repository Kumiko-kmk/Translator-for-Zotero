# 🛠️ Translator for Zotero 开发与维护指南

用户安装、Provider 说明和架构总览见 [README.md](../README.md)，版本变化见 [CHANGELOG.md](../CHANGELOG.md)。本文档记录当前代码的模块边界、状态所有权、构建方法和 Zotero 人工验收重点。

## 🎯 产品边界

- 🦊 运行环境：Zotero 9.0–9.* 内置 PDF Reader 普通主视图。
- 🧩 插件 ID：`reader-selection-replacer-test@local.kumiko`。
- 📝 自动入口：父条目的 `title` 与 `abstractNote`。
- ✂️ 手动入口：用户主动选择的 PDF 正文，保留 Reader 提供的字符位置和坐标事实。
- 🌏 目标语言：固定为 `zh-CN`。
- 🌐 Provider：Qwen、DeepSeek、Gemini、Bing、Tencent Transmart、CNKI。
- 🚫 不支持：OCR、整页正文翻译、EPUB、第二 Reader 视图、翻译历史管理和批量导出。

标题/摘要允许自动定位和翻译；正文必须通过用户选区进入流程。不要把旧版本已删除的整页 `page-body` 翻译链路重新引入。

## 🧰 开发环境

需要 Git、Node.js 20+、PowerShell 和 Zotero 9.x。插件 JavaScript 由 Zotero 直接加载，没有 npm 依赖，不需要 `npm install`。

```powershell
git clone https://github.com/Kumiko-kmk/Translator-for-Zotero.git
Set-Location Translator-for-Zotero
```

⚠️ API Key 必须通过 Zotero/Firefox Login Manager 保存，不得进入源码、测试夹具、日志、截图、SQLite 缓存或提交记录。成功译文只缓存于 Zotero 数据目录的 SQLite 数据库。

## 🚦 模块加载顺序

`plugin/bootstrap.js` 使用 `Services.scriptloader.loadSubScript()` 按以下顺序把脚本加载到同一个 Zotero 全局环境：

| 顺序 | 模块 | 主要职责 |
| ---: | --- | --- |
| 1 | `core.js` | 插件常量、版本、Provider UI 元数据、本地化和几何工具 |
| 2 | `page-text-index.js` | PDF.js 页面字符、视觉行、坐标与视口变换索引 |
| 3 | `selection-block.js` | Reader 选区扩展、跨页和单/双栏段落整理 |
| 4 | `front-matter-extractor.js` | 首页标题/摘要候选、阅读顺序、页眉页脚和版面过滤 |
| 5 | `content-segments.js` | 把标题、摘要和选区统一为翻译 Segment |
| 6 | `translation-service.js` | Provider Registry、凭据、请求校验、错误规范化和 SQLite 缓存 |
| 7 | `reader-target-locator.js` | 读取父条目元数据并将标题/摘要匹配到 PDF 坐标 |
| 8 | `overlay-layout.js` | 覆盖块分组、译文分配、字号/行距测量和布局缓存 |
| 9 | `overlay-renderer.js` | 创建覆盖 DOM、渲染状态、原文切换、选择复制和删除按钮 |
| 10 | `reader-overlay.js` | Reader 状态、覆盖记录、事件、当前页 ± 1 页窗口和增量重绘 |
| 11 | `provider-panel.js` | Provider 卡片、Key 配置、首次使用提示、预览和复制交互 |
| 12 | `translation-workflows.js` | 自动/选区翻译、重试、预览、状态和删除译文缓存 |
| 13 | `app-controller.js` | 插件级状态、Reader/Item Pane 监听和控制器组合 |

新增模块时必须同步更新：

1. `plugin/bootstrap.js` 的 `TRANSLATOR_MODULES` 顺序；
2. `tools/build_xpi.ps1` 的固定 `$packageFiles` 清单；
3. 本文档和 README 的模块说明；
4. 相关图标、FTL 字符串和人工验收步骤。

## 🧩 方法集合与状态所有权

当前代码保留旧的全局入口，同时使用方法集合组合职责：

- `provider-panel.js` 和 `translation-workflows.js` 导出方法集合，由 `app-controller.js` 通过 `Object.assign()` 组合；
- `overlay-layout.js` 和 `overlay-renderer.js` 导出方法集合，由 `reader-overlay.js` 组合；
- `app-controller.js` 是插件级协调器，不应重新堆入 PDF 定位、排版或 HTTP 细节。

### 🧠 `app-controller.js` 持有的状态

- `activeProviderID`、`providerStates`：当前模型和各 Provider 验证状态；
- `panelStates`：已渲染的 Item Pane 面板；
- `autoSessions`：每个 Reader 的标题/摘要任务；
- `selectionSessions`：每个 Reader 的手动选区任务；
- `latestTranslationPreviews`：最近一次原文/译文预览，仅内存保存；
- `startingReaders`、`readerListenersRegistered`：避免 Reader 重复初始化和重复绑定；
- `firstModelSelectionNoticePromise`：避免首次使用弹窗重复打开。

### 🧱 `reader-overlay.js` 持有的状态

`SelectionReplacerOverlay.states` 按 Reader 保存覆盖记录、页级显示模式、事件监听器、当前渲染记录和布局缓存。关闭 Reader、切换 PDF、切换 Provider 或插件 `shutdown()` 时必须取消任务、解除监听并清理对应状态。

## 🔄 两条主要数据流

### 📰 标题与摘要自动翻译

```text
Zotero parent title / abstractNote
  → ReaderMetadataLoader
  → ReaderTargetLocator + ReaderFrontMatterExtractor
  → ContentSegments.fromTargets()
  → TranslationCoordinator.translateSegments()
  → SegmentTranslationCache / 当前 Provider
  → SelectionReplacerOverlay
  → TranslatorOverlayLayout + TranslatorOverlayRenderer
```

只有匹配置信度和版面条件足够的目标才进入翻译。开始新任务时清空旧预览；成功或命中缓存的结果写入当前 Reader 的内存预览。

### ✂️ 用户选区翻译

```text
Reader selection text + position
  → ReaderSelectionBlock.create()
  → ContentSegments.fromSelectionBlock()
  → TranslationCoordinator.translateSegments()
  → SelectionReplacerOverlay
  → 当前页及前后各一页的译文覆盖层
```

选区的原始 `position` 是定位事实来源。分段、翻译和排版可以补充结构，但不能用模糊全文搜索替换已经取得的 Reader 坐标。

## 🌐 Provider、凭据与缓存

| Provider | 模型 | `credentialMode` | 关键约束 |
| --- | --- | --- | --- |
| Qwen | `qwen-mt-plus` | `api-key` | 单 Segment 请求，使用翻译专用语言映射 |
| DeepSeek | `deepseek-v4-flash` | `api-key` | JSON 结构校验，失败保留错误码 |
| Gemini | `gemini-2.5-flash` | `api-key` | 官方 API，单 Segment 请求 |
| Bing | `bing-edge` | `none` | 网页接口，普通文本上限约 2000 字符 |
| Tencent Transmart | `transmart-web` | `none` | 网页接口，普通文本上限约 2000 字符 |
| CNKI | `cnki-web` | `none` | Token 生命周期管理，普通文本上限约 800 字符 |

`TranslationProviderRegistry` 为每个 Provider 保存独立的 model spec、凭据客户端、翻译客户端和请求选项。Provider 失败后不自动降级，调用方应显示明确状态并等待用户重试。

### 🗄️ Segment 缓存不变量

- 状态只有 `cached`、`translated`、`failed`、`skipped`；
- 只有 `cached`/`translated` 且译文非空时，才进入成功覆盖层和预览；
- 缓存键必须继续包含 library、attachment、Segment kind、position signature、source hash、source/target language、Provider、model 和 prompt version；
- `SegmentTranslationCache.remove()` 只删除精确匹配的单段记录；
- 删除成功后，`removeTranslationSegment()` 同步移除内存覆盖记录、更新预览和 Reader 状态；
- API Key 不得出现在 SQLite、日志、源码、截图或 Git 历史中。

## 🖼️ 覆盖层与性能约束

- 📄 只常驻当前页及前后各一页覆盖层；
- 🔄 原文/译文切换走 CSS 快速路径，不重新发起翻译；
- 📐 覆盖块同时约束水平和垂直溢出，字号与行距联合调整；
- 📏 测量节点使用真实内容高度，不得恢复为 `height: 100%`；
- 🧮 布局签名不变时复用测量和坐标缓存；
- 🖱️ 译文保持 `user-select: text`，控制按钮和删除按钮不能混入复制文本；
- 🗑️ 删除按钮只对成功且非空的翻译显示，显示原文时隐藏；
- 🔍 缩放、旋转、页面挂载变化后，必须使受影响的坐标和布局缓存失效；
- 🚫 不要恢复整页 `page-body`、`translatePage()`、页面翻译 session 或 `extractPage()` 请求链。

## 🧪 检查与构建

修改前先确认工作树：

```powershell
git status -sb
```

## 🧪 自动化测试

测试脚本位于 `tests/`，使用 Node.js 内置测试运行器。测试通过 VM 沙箱模拟 Zotero 运行时、PDF 页面和 HTTP 请求，不依赖真实翻译服务或本机 Zotero 配置。

```powershell
node --test tests/*.test.js
node --test --test-reporter=spec tests/*.test.js
```

当前测试重点包括：

- 📄 文本提取：PDF 矩形投影、四种旋转、投影缓存、视口故障、标题/摘要/正文边界和跨页定位；
- 🧩 文本解析：语言识别、元数据段、单栏/双栏选区、显式与几何段落断点、DeepSeek JSON/选择单元校验和缓存封装；
- 🌐 网络通信：六个 Provider 的请求协议、鉴权、HTTP/网络重试、文本分片、CNKI Token 缓存、验证码和 TranslationCoordinator 结果。

详见 [`tests/README.md`](../tests/README.md)。测试文件不会被 `tools/build_xpi.ps1` 打入 XPI。

### ✅ JavaScript 语法检查

```powershell
Get-ChildItem plugin -Filter *.js | ForEach-Object { node --check $_.FullName }
```

### 📦 固定 XPI 构建

```powershell
.\tools\build_xpi.ps1
```

脚本会：

1. 从 `plugin/manifest.json` 读取版本；
2. 核对 `core.js` 中的 `PLUGIN_VERSION`；
3. 验证插件 ID、更新地址和 Zotero 兼容范围；
4. 只打包 `$packageFiles` 中的运行脚本、图标和 FTL；
5. 验证 XPI 根目录、文件数量、路径分隔符和 manifest；
6. 原子替换 `dist/Translator-for-Zotero-<version>.xpi`；
7. 输出文件大小和 SHA-256。

不要手工压缩源码、不要编辑生成的 XPI，也不要把 README、开发文档、日志或临时文件加入包内。

### 🔎 提交前检查

```powershell
git diff --check
git status -sb
```

## ✅ Zotero 人工验收

安装刚构建的 XPI 并完全重启 Zotero，至少覆盖以下场景：

1. 👋 第一次点击模型卡片显示须知，确认按钮延迟解锁，关闭/`Esc` 可结束且不重复弹出；
2. 🎛️ 六个 Provider 卡片、未选择模型状态、Key 保存/验证和免密 Provider；
3. 📰 标题和摘要自动定位、独立重试、全部重试和缓存命中；
4. ✂️ 单栏、双栏、多行、跨页和包含片段的选区翻译；
5. 🖱️ 译文选择、复制、页面顶部/底部原文切换；
6. 🗑️ 删除单段译文，确认缓存删除、覆盖移除、预览刷新和原文恢复；
7. 📐 缩放、旋转、连续滚动和长文档，确认仅三页覆盖层常驻且无明显卡顿；
8. 🌐 无效 Key、断网、空响应、超时、429、验证码和手动重试；
9. 📄 没有文字层、复杂表格、公式、脚注、页眉页码和双栏边界等异常版面。

## 🧯 故障排查

| 现象 | 优先检查 |
| --- | --- |
| 侧栏不出现 | 完全重启 Zotero、查看 Error Console、确认 Reader/Item Pane 注册重试完成 |
| Provider 卡片不工作 | 当前模型是否为空、Key 是否保存/验证、Provider 状态和网络是否正常 |
| 选区没有覆盖 | PDF 是否有文字层、选区是否跨栏、原始 `position` 和页面缩放是否有效 |
| 译文选不中 | 页面是否处于显示译文状态，覆盖文本的 `user-select` 是否仍为 `text` |
| 删除按钮失败 | Segment/attachment/model 信息是否完整，SQLite 是否可用，查看 Reader 状态和日志 |
| 覆盖块溢出 | 检查真实内容高度、字号/行距测量、布局签名和缩放后的缓存失效 |
| 滚动卡顿 | 检查是否重新引入全量重绘、全页扫描或超过三页常驻覆盖层 |
| XPI 无法安装 | 使用固定构建脚本、确认 manifest 在 XPI 根目录并完全重启 Zotero |

## 🚢 发布检查

1. 更新 `plugin/manifest.json`、`plugin/core.js`、README 和 CHANGELOG 的版本信息；
2. 运行全部 `plugin/*.js` 语法检查；
3. 运行 `tools/build_xpi.ps1`，记录 XPI 大小和 SHA-256；
4. 运行 `git diff --check`，确认只提交本次范围；
5. 在 Zotero 中完成 Provider、自动翻译、选区、复制、切换、删除和缩放验收；
6. 推送发布分支并创建 PR，审阅通过后再合并到 `main`；
7. 从合并后的 `main` 创建标签和 GitHub Release，上传对应 XPI；
8. 从 Release 下载 XPI 再安装一次，完成最终验收。

## 🧱 维护原则

请尽量保持以下单向数据流：

```text
定位 → 分段 → 翻译/缓存 → 布局 → 渲染 → Reader 交互
```

新增功能应放在对应模块中：定位逻辑不要复制到 Provider，HTTP 细节不要放进渲染器，排版测量不要通过隐式 DOM 查询反向修改应用状态。内部插件 ID、旧 CSS 名称和 `SelectionReplacerTest` 兼容别名不能仅为“看起来更整齐”而删除。
