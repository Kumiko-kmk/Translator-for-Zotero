# Translator for Zotero

Translator for Zotero 是面向 Zotero 9.x 内置 PDF Reader 的论文翻译插件。当前版本为 `1.2.0`。

它支持：

- 自动识别并翻译论文首页的标题和摘要；
- 翻译用户在 PDF 中手动选中的英文段落；
- 在原文版面上显示可选择、可复制的简体中文译文；
- 在页面顶部或底部统一切换该页的原文与译文；
- 分别配置千问与 DeepSeek，并在本机安全保存密钥和翻译缓存。

1.2.0 已移除可靠性不足的整页正文翻译功能。公式、表格、图片、脚注等复杂内容建议通过精确手动选区控制发送范围。

## 安装

从 GitHub Releases 下载 `Translator-for-Zotero-1.2.0.xpi`，在 Zotero 中打开 `工具 -> 插件`，把 XPI 拖入窗口后完全重启 Zotero。

完整的安装、模型配置、使用方法、隐私说明和故障排查见 [插件使用说明](zotero-reader-selection-replacer-test/README.md)。

## 开发与构建

正式插件源码位于 `zotero-reader-selection-replacer-test/`。仓库根目录执行：

```powershell
node tests/test_reader_selection_replacer_translation.js
node tests/test_reader_selection_replacer_bootstrap.js
node tests/test_reader_selection_replacer_front_matter.js
python -m pytest
.\tools\build_reader_selection_replacer_test_xpi.ps1
```

构建脚本会读取 `manifest.json` 的版本，校验 Zotero 兼容声明与固定文件清单，并生成：

```text
dist/Translator-for-Zotero-1.2.0.xpi
```

跨电脑环境准备、架构说明、测试矩阵、人工验收和 GitHub 发布步骤见 [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md)。

## 当前限制

- 仅支持 Zotero `9.0` 至 `9.*`；
- PDF 必须包含可复制的文字层，插件不提供 OCR；
- 目标语言固定为简体中文；
- 不支持整页正文翻译、EPUB、第二阅读器视图和翻译历史管理；
- API 服务的价格、额度、地域和速率限制以服务商最新规则为准。

## 隐私

插件只向当前选择的翻译 Provider 发送本次需要翻译的标题、摘要或选区文本，不上传整个 PDF。请勿在代码、日志、截图或 Issue 中提交真实 API Key。
