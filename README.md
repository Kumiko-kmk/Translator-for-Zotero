# Zotero 阅读器英文正文中文覆盖翻译插件

当前交付是一个独立的 Zotero 9 插件：复用 Zotero 阅读器的段落文本和页面坐标，
筛选英文正文后按顺序调用 DeepSeek，并把中文译文覆盖在原段落位置。它不依赖下面的
Python 桌面 Demo；API Key 和译文缓存都只保存在本机。

- 插件源码：`zotero-reader-highlighter/`
- XPI：`dist/reader-text-highlighter-0.7.8.xpi`
- 使用方法：在 Zotero 的“工具 → 插件”中选择“从文件安装插件”，安装后重新打开
  Zotero，按首次提示验证 DeepSeek API Key。打开英文 PDF 后会自动从第 1 页开始按顺序翻译，
  阅读器右侧“论文助手”可暂停、重试、清缓存、更换密钥和查看诊断正文预览。翻译保留四路并发，
   但始终先请求并显示前面的段落；空译文、缺失译文和格式异常响应会自动重试最多三次。诊断区还可导出原始
   Zotero 分段 JSON，用于复现双栏、跨栏和跨页段落重建问题。正文译文保持原顶部/底部坐标、使用更宽行距并首行缩进两格；表格仅翻译表题，表格内容不进入请求。

插件排除页眉页脚、页码、出版元数据、标题、图表、公式、表格和参考文献。覆盖层只
改变当前阅读显示，不创建批注或修改 PDF；扫描版 PDF 需要先 OCR。当前版本针对本机
Zotero 9.0.6 构建和校验。

---

# 旧版 PDF → DeepSeek 论文理解 Demo

这是一个聚焦于论文预处理的 Windows 桌面 Demo。核心不是 Zotero 管理、检索或聊天，
而是把版面复杂的 PDF 转换成适合 DeepSeek 理解的高质量、可追踪分段，再逐段生成
结构化内容并汇总成论文级理解。

## 核心流水线

```text
本地 PDF
  → 读取页面、文本块、坐标、字号和图片数量
  → 恢复双栏阅读顺序
  → 清理重复页眉、页脚和页码
  → 修复 ﬁ 等连字和跨行断词
  → 识别父章节、子章节和页码范围
  → 将正文按最多 5 段/约 2600 字符拆批，并以四并发翻译
  → DeepSeek 独立理解每个分段并立即落库
  → 使用全部逐段结果生成全文汇总
```

处理过程保留三层可审查数据：

1. 清洗后的每页文本，以及被移除的边缘文本；
2. 识别出的章节结构；
3. 真正发送给 DeepSeek 的最终分段。

界面中央内嵌逐页 PDF 阅读器。它使用与预处理相同的页面坐标，将保留下来的文本块
以半透明黄色荧光笔覆盖显示；重复页眉、页脚和被过滤的脚注不会高亮。高亮是独立的
显示层，不会向原 PDF 写入批注。选择左侧页面、章节、分段或右侧逐段理解结果时，
阅读器会跳到对应起始页。

## 已针对真实例文优化

默认真实回归样本是：

```text
C:\Users\Kumiko\Downloads\Deep Sparse Rectifier Neural Networks.pdf
```

该论文是 9 页双栏 AISTATS 版式，包含：

- 首页跨栏标题和作者信息；
- 左右栏正文；
- 重复论文标题或作者页眉；
- 底部印刷页码；
- `ﬁ`、`ﬀ` 等 PDF 连字；
- `bi-` / `ologically` 一类跨行断词；
- 多级章节、公式、脚注和参考文献。

当前预处理会正确提取标题 `Deep Sparse Rectifier Neural Networks`，保留首页标题，
删除后续重复页眉和页码，先输出完整左栏再输出右栏，并识别包括
`2 Background`、`3 Deep Rectifier Networks`、`4 Experimental Study` 和
`References` 在内的章节结构。

## DeepSeek 两阶段理解

每个分段单独生成：

- 分段摘要；
- 该段在论文中的作用；
- 关键点；
- 方法；
- 数据与结果；
- 核心概念；
- 带页码和原文的证据；
- 上下文不足或不确定项。

所有分段完成后，再生成：

- 一句话总结；
- 研究问题和背景；
- 方法路线、数据集与实验设计；
- 主要发现；
- 贡献、局限和未来工作；
- 章节摘要；
- 全文级页码证据。

DeepSeek 返回值使用 Pydantic 校验。JSON 校验失败会重试一次。每次原始响应保存在
`logs/`。某一分段失败时，之前已经成功的分段不会重复调用；点击“重新处理”会从失败
位置继续。已完成论文点击该按钮则重新执行整条流水线。

## 无 API Key 模式

没有 API Key 时自动使用确定性的 Mock 客户端，但仍会完整执行：

- PDF 提取；
- 版面预处理；
- 章节识别；
- 分段；
- 每段独立调用；
- 每段结果落库；
- 全文汇总。

Mock 明确标注为离线验证结果，不冒充论文真实理解。

## Windows 运行

需要 Python 3.11 或更高版本。

```powershell
cd E:\Kumiko\pythonProject\Zotero
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
python run.py
```

程序使用新的 `data/pdf_understanding.db`。旧版生成的
`data/paper_assistant.db` 不会再被读取，可以在确认不需要历史数据后手动删除。

## DeepSeek 配置

可编辑 `.env`：

```dotenv
DEEPSEEK_API_KEY=your-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
APP_DATABASE_PATH=data/pdf_understanding.db
APP_LOG_DIR=logs
```

也可从界面右上角“模型设置”保存，重启应用后生效。API Key 不写入源代码。

## 界面

界面采用三栏布局：

1. **左栏**：处理流程，以及逐页、逐章节、最终模型分段的预处理预览；
2. **中栏**：PDF 阅读器、翻页与缩放、识别文本块黄色高亮；
3. **右栏**：每个分段的结构化 DeepSeek 结果，以及全文汇总。

## 测试

```powershell
.\.venv\Scripts\python.exe -m pytest
```

真实论文路径可覆盖：

```powershell
$env:TEST_PDF_PATH = "D:\papers\another-paper.pdf"
.\.venv\Scripts\python.exe -m pytest
```

当前 12 项测试重点覆盖：

- 合成双栏 PDF 的左右栏顺序和页眉页码清理；
- 真实 9 页例文的标题、页数、断词修复和章节结构；
- 章节内分段、大小上限和参考文献排除；
- 每个分段只调用一次理解客户端；
- 逐段结果全部落库后才执行全文汇总；
- 中途失败后复用已完成分段；
- 文件 SHA256 去重；
- 精简后的八张数据库表；
- 三栏 PySide6 界面启动、PDF 页面渲染和文本块高亮。

若默认真实样本不存在，对应回归用例会跳过，其余合成 PDF 测试仍可运行。

## 项目结构

```text
.
├── paper_assistant/
│   ├── ai.py               # DeepSeek/Mock 逐段理解与全文汇总
│   ├── config.py           # .env 与路径配置
│   ├── database.py         # 八张核心 SQLite 表
│   ├── main.py             # 桌面入口
│   ├── models.py           # 页面、章节、分段及理解结果模型
│   ├── pdf_processing.py   # 版面提取、双栏排序、清洗和章节识别
│   ├── pipeline.py         # 后台流水线、去重、失败续跑
│   ├── segmentation.py     # 章节内模型分段
│   ├── pdf_viewer.py       # PDF 页面渲染、翻页缩放和坐标高亮层
│   └── ui.py               # 左侧预处理、中间阅读器、右侧 DS 结果
├── tests/
│   ├── test_pdf_processing.py
│   ├── test_pipeline.py
│   ├── test_ai.py
│   ├── test_database.py
│   └── test_ui_smoke.py
├── .env.example
├── requirements.txt
└── run.py
```

## 已删除的旧功能

本次重构已删除 Zotero Adapter、HTTP 事件 API、全文检索、Embedding、论文问答、
研究方向相关度评分及其 UI、数据库表、依赖和测试，使代码与测试资源集中在 PDF
预处理和 DeepSeek 分段理解主链路。
