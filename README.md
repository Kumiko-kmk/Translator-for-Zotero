# Translator for Zotero

[![Release](https://img.shields.io/github/v/release/Kumiko-kmk/Translator-for-Zotero?display_name=tag&sort=semver)](https://github.com/Kumiko-kmk/Translator-for-Zotero/releases/latest)
[![Zotero](https://img.shields.io/badge/Zotero-9.x-CC2936?logo=zotero&logoColor=white)](https://www.zotero.org/)

在 Zotero 内置 PDF Reader 中翻译论文标题、摘要和用户选中的正文，并直接选择、复制中文译文。

当前版本：`2.0.0` · 支持 Zotero `9.x`、带文字层的 PDF、简体中文译文。

[下载安装包](https://github.com/Kumiko-kmk/Translator-for-Zotero/releases/latest) · [开发与构建](docs/DEVELOPMENT.md) · [版本记录](CHANGELOG.md) · [提交问题](https://github.com/Kumiko-kmk/Translator-for-Zotero/issues)

## 功能

- 自动定位并翻译 Zotero 父条目的标题和摘要。
- 翻译用户在 PDF 中选中的段落，支持单栏、双栏和跨页选区。
- 在原版面位置显示可选择、可复制的译文，并可按页切换原文/译文。
- 支持 Qwen、DeepSeek、Gemini、Bing、Tencent Transmart 和 CNKI。
- API Key 保存在 Zotero/Firefox Login Manager，成功译文缓存在本地 SQLite。

## 安装

1. 从 [GitHub Releases](https://github.com/Kumiko-kmk/Translator-for-Zotero/releases/latest) 下载 `Translator-for-Zotero-*.xpi`。
2. 在 Zotero 的 `工具 → 插件` 中安装 XPI。
3. 完全退出并重新启动 Zotero。
4. 打开带可复制文字层的 PDF，在右侧栏找到 **Translator for Zotero**。

不要解压或手工重新压缩 XPI。插件只支持 Zotero 9.x。

## 使用

### 标题和摘要

打开带父条目的 PDF 后，插件会读取 `title` 和 `abstractNote`，并在第一页定位对应区域。定位或翻译失败时，可在侧栏重试。

### 正文选区

1. 在 PDF 中拖选英文正文。
2. 在选区弹窗点击“翻译”。
3. 等待译文覆盖原文后即可选择和复制。
4. 需要核对时，使用页面顶部或底部按钮切换原文/译文。

尽量不要一次跨越左右栏，也不要把页眉、页码、公式或表格混入选区。扫描版 PDF 需要先添加 OCR 文字层。

## Provider 与隐私

Qwen、DeepSeek、Gemini 需要 API Key；Bing、Tencent Transmart、CNKI 不需要 Key，但可能受网络、限流或接口变化影响。Provider 的密钥、模型和缓存相互隔离。

插件只发送当前请求中的标题、摘要或选区文本，不上传整个 PDF，也不修改原文件。使用未发表论文或敏感资料前，请确认允许发送到第三方服务；价格、额度和速率限制以服务商政策为准。

## 当前限制

- 目标语言固定为简体中文。
- 不包含 OCR，不支持 EPUB、第二 Reader 视图或整页正文翻译。
- 复杂公式、表格、脚注和浮动文本框可能影响定位。
- 当前没有翻译历史、导出或批量管理页面。

## 架构与开发

数据流为：PDF 文字层 → 页面/选区分析 → 内容分段 → Provider 与本地缓存 → 可复制覆盖层。运行源码位于 `plugin/`，唯一支持的 XPI 构建入口是 `tools/build_xpi.ps1`。

```powershell
Get-ChildItem plugin -Filter *.js | ForEach-Object { node --check $_.FullName }
.\tools\build_xpi.ps1
```

构建产物写入被忽略的 `dist/`，正式安装包只通过 GitHub Releases 分发。模块职责、构建和人工验收见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 反馈

提交 Issue 时请附 Zotero 版本、操作系统、PDF 单栏/双栏信息、复现步骤和已隐藏敏感信息的截图。不要上传论文全文、真实 API Key 或原始日志。
