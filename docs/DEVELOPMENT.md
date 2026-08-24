# Translator for Zotero 开发指南

用户安装和使用说明见 [README.md](../README.md)，版本变化见 [CHANGELOG.md](../CHANGELOG.md)。本项目是无 npm 依赖的 Zotero 9.x PDF Reader 插件，正式运行源码位于 `plugin/`。

## 开发环境

需要 Git、Node.js 20+、PowerShell 和 Zotero 9.x。插件脚本直接由 Zotero 加载，不需要 `npm install`。

```powershell
git clone https://github.com/Kumiko-kmk/Translator-for-Zotero.git
Set-Location Translator-for-Zotero
```

插件 ID 为 `reader-selection-replacer-test@local.kumiko`，目标语言固定为 `zh-CN`。API Key 保存在 Zotero/Firefox Login Manager，译文缓存保存在 Zotero 数据目录的 SQLite 中；不要把密钥写入源码、日志或提交记录。

## 代码分层

```text
bootstrap.js
  → core.js
  → page-text-index / selection-block / front-matter-extractor
  → content-segments
  → translation-service
  → reader-target-locator / overlay-layout / overlay-renderer
  → reader-overlay
  → provider-panel / translation-workflows
  → app-controller
```

- `bootstrap.js`：Zotero 生命周期和固定加载顺序。
- `core.js`：公共常量、Provider 元数据、本地化和几何工具。
- `page-text-index.js`、`selection-block.js`、`front-matter-extractor.js`、`reader-target-locator.js`：PDF 文字索引、选区整理、首页标题/摘要识别和坐标定位。
- `content-segments.js`：统一标题、摘要和选区的翻译分段。
- `translation-service.js`：六个 Provider、凭据、请求、错误处理和 SQLite 缓存。
- `overlay-layout.js`、`overlay-renderer.js`、`reader-overlay.js`：译文排版、DOM 覆盖、页级切换和三页渲染窗口。
- `provider-panel.js`、`translation-workflows.js`、`app-controller.js`：侧栏交互、翻译任务和插件级状态协调。

新增或移动模块时，同时更新 `bootstrap.js` 的加载顺序和 `tools/build_xpi.ps1` 的固定打包清单。内部插件 ID 和旧 CSS/全局别名用于兼容已安装实例，不要仅为改名而删除。

## 检查与构建

修改前查看状态，并运行 JavaScript 语法检查：

```powershell
git status -sb
Get-ChildItem plugin -Filter *.js | ForEach-Object { node --check $_.FullName }
git diff --check
```

使用唯一支持的构建入口：

```powershell
.\tools\build_xpi.ps1
```

脚本从 `plugin/manifest.json` 读取版本，校验插件 ID、Zotero 兼容范围和固定文件清单，生成 `dist/Translator-for-Zotero-<version>.xpi`。文档、日志、测试文件和临时文件不会打入 XPI。不要手工压缩源码目录或编辑生成的 XPI。

## Zotero 验收

安装刚生成的 XPI 并重启 Zotero，至少检查：

1. 右侧栏、Provider 选择、API Key 保存/验证和免密 Provider。
2. 标题/摘要自动翻译、重试和缓存命中。
3. 单栏、双栏、多行和跨页选区翻译。
4. 译文选择、复制、删除缓存后恢复原文，以及顶部/底部原文切换。
5. 缩放、滚动和长文档性能；覆盖层只保留当前页及前后各一页。
6. 无效 Key、断网、超时、限流和手动重试。

PDF 必须带可复制文字层；扫描件需要先通过外部工具 OCR。复杂公式、表格、脚注和浮动文本可能影响定位，插件不支持整页正文翻译、EPUB 或第二 Reader 视图。

## 发布

发布前更新版本号、README 和 CHANGELOG，完成语法检查、XPI 构建、`git diff --check` 及 Zotero 人工验收。只提交本次范围，推送分支后创建 PR；Release 附件使用构建脚本生成的 XPI，并记录 SHA-256。
