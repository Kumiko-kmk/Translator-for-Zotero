# Paper Assistant Reader Extraction Test 0.10.2

这是独立的 Zotero 9 正文提取测试插件，只验证正文段落识别和黄色覆盖层，不包含翻译、模型或网络请求。

## 唯一提取流程

`Zotero getPageData 字符 → 视觉行 → 单/双栏阅读顺序 → 正文段落 → 黄色覆盖层`

- 逐页调用 `PDFViewerApplication.pdfDocument.getPageData({ pageIndex })`。
- 使用字符的 `rect/inlineRect`、`viewBox`、换行提示、空格和旋转信息重建视觉行。
- PDF 坐标转换为顶部向下坐标用于版面分析；导出和高亮始终保留 Zotero 原始 PDF 矩形。
- `lineBreakAfter` 和 `paragraphBreakAfter` 仅作为弱提示，不直接决定段落或阅读顺序。
- 页面按通栏区域和稳定中央沟槽识别单栏、双栏及混合布局。

## 正文范围

只保留首个正文章节与终止章节之间的自然语言段落：

- 正文从 Introduction、Background、Methods、引言、绪论等标题之后开始。
- 论文标题、作者、单位、摘要和章节标题不输出。
- 小数、测量值或单位开头的换行（如 `0.25 m while...`）按正文处理，不作为章节编号。
- 遇到 References、Bibliography、Acknowledgements、Funding、Appendix、参考文献、致谢等章节时停止。
- 无法可靠确定正文起点时明确失败，避免把首页信息误作正文。

## 非正文排除

- 独立公式必须同时具有数学符号、多基线、居中或公式编号等多项证据；正文中的变量、希腊字母、单位和行内公式保留。
- 表格必须形成至少三行、多个稳定列起点的二维区域；确认后连同表题和表注排除。
- 图片本身不会产生字符；稀疏图片标签和高置信图注排除。
- `Fig. 11 shows...` 等正常字号、连续自然语言正文保留。
- 重复页眉页脚、独立页码、脚注和出版信息排除。
- 边界情况正文优先：证据不足时保留，并记录到 `retainedAmbiguities`。

## 导出诊断

导出 schema 为 `reader-text-extraction-test.v10`，主要字段包括：

- `raw`：正文文本、源字符/行 ID、合并原因和 `position.fragments`。
- `bodyBoundary`：正文起止位置及识别依据。
- `layoutDiagnostics`：每页区域、栏数、沟槽和阅读顺序。
- `exclusions`：按非正文原因汇总的计数和有限样本。
- `retainedAmbiguities`：因证据不足而保留的疑似非正文行。
- `characterConservation`：输入、保留、排除、断词转换、未归属和重复字符数量。

独立 XPI 仅包含 `manifest.json`、`README.md`、`bootstrap.js` 和 `page-data-body-extractor.js`。插件不调用其他文本来源、朗读接口、DOM 文本层、OCR、模型、网络服务或翻译功能。

## 0.10.2 调试增强

- `Fig./Figure + 编号` 开头的行会结合自然语言谓语和上一正文行的连续性判断；像 `Fig. 6. These results evidence...` 这样的正文不会再仅因行首形式被当作图注删除。
- 每个保留正文段落显示两条边界标记：蓝线表示段落开始，红线表示段落结束。边界线只用于测试观察，不写入导出的正文文本。
