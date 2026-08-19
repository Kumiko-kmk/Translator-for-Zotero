# Translator for Zotero 开发交接手册

本文档用于把项目迁移到另一台电脑并继续开发、测试和发布。当前正式插件版本为 `1.2.0`，仓库地址为 <https://github.com/Kumiko-kmk/Translator-for-Zotero>。

## 1. 当前产品边界

- 运行环境：Zotero `9.0` 至 `9.*` 的内置 PDF Reader。
- 正式插件目录：`zotero-reader-selection-replacer-test/`。
- 插件 ID：`reader-selection-replacer-test@local.kumiko`。
- 支持：自动翻译首页标题与摘要、手动选区翻译、译文选择与复制、按页切换原文/译文。
- 不支持：整页正文翻译、OCR、EPUB、第二阅读器视图、翻译历史管理和自动 Provider 回退。
- Provider：千问 `qwen-mt-plus` 与 DeepSeek `deepseek-v4-flash`；目标语言固定为 `zh-CN`。

`zotero-reader-extraction-test/`、`zotero-reader-highlighter/` 及其测试属于早期原型。除非专门维护历史原型，不要把新功能写入这些目录，也不要把它们打入正式 XPI。

## 2. 新电脑准备

推荐安装：

- Git；
- PowerShell 7（Windows 自带 Windows PowerShell 也可执行当前打包脚本）；
- Node.js 20 或更高版本，用于 JavaScript 语法和单元测试；
- Python 3.11 或更高版本，用于仓库完整 `pytest`；
- Zotero 9.x，用于最终人工验收。

克隆并创建 Python 环境：

```powershell
git clone https://github.com/Kumiko-kmk/Translator-for-Zotero.git
Set-Location Translator-for-Zotero
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

macOS/Linux 激活命令改为 `source .venv/bin/activate`。正式插件的 JavaScript 测试不依赖 npm 包，因此不需要执行 `npm install`。

## 3. 代码结构

| 路径 | 职责 |
| --- | --- |
| `zotero-reader-selection-replacer-test/bootstrap.js` | 插件生命周期、侧栏、PDF 选区捕获、段落匹配、覆盖层、分页显示状态和排版 |
| `zotero-reader-selection-replacer-test/page-data-body-extractor.js` | 首页正文边界、标题/摘要区域、单双栏视觉行和段落分析 |
| `zotero-reader-selection-replacer-test/content-segments.js` | 标题、摘要和选区文本的统一分段对象 |
| `zotero-reader-selection-replacer-test/translation-service.js` | Provider 配置、密钥存储、请求、结果校验和分段缓存 |
| `zotero-reader-selection-replacer-test/manifest.json` | 唯一的发布版本来源、插件 ID 和 Zotero 兼容范围 |
| `zotero-reader-selection-replacer-test/locale/` | 中英文界面字符串 |
| `tests/test_reader_selection_replacer_*.js` | 正式插件的无网络 JavaScript 回归测试 |
| `tests/test_reader_selection_replacer_test_plugin.py` | 源码/XPI 清单、版本及安全约束测试 |
| `tools/build_reader_selection_replacer_test_xpi.ps1` | 唯一受支持的 XPI 构建与验包入口 |
| `dist/` | 发布安装包；顶层只保留当前版本，`archive/` 保存有明确说明的历史故障样本 |

关键数据约定：

- API Key 通过 Zotero/Firefox Login Manager 保存，不写入仓库或 SQLite 翻译缓存。
- 成功译文缓存文件名为 `paper-assistant-segment-translations.sqlite`，按 Provider、模型、提示词版本、原文及目标语言隔离。
- PDF 位置依赖文字层字符坐标。扫描件必须先 OCR，但插件本身不执行 OCR。
- 1.2.0 已完整移除整页翻译的 `page-body`、页面任务和 `extractPage()` 请求链；不要从旧构建产物复制这些代码回来。

## 4. 本地开发与测试

修改前运行 `git status --short`，确认哪些改动属于当前任务。不要用 `git reset --hard` 或覆盖用户未提交的文件。

JavaScript 语法检查：

```powershell
node --check zotero-reader-selection-replacer-test/bootstrap.js
node --check zotero-reader-selection-replacer-test/content-segments.js
node --check zotero-reader-selection-replacer-test/translation-service.js
node --check zotero-reader-selection-replacer-test/page-data-body-extractor.js
```

正式插件 Node 回归测试：

```powershell
node tests/test_reader_selection_replacer_translation.js
node tests/test_reader_selection_replacer_bootstrap.js
node tests/test_reader_selection_replacer_front_matter.js
```

完整 Python 回归：

```powershell
python -m pytest
```

测试不应调用真实翻译 API。涉及千问或 DeepSeek 的测试使用伪请求。PDF 实物测试在本地样本不存在时可能显示 `skipped`，这不等同于失败。

## 5. 排版与性能约束

选区译文排版必须同时满足：

- 不发生水平或垂直溢出；
- 保留首行缩进、连续段落末行语义和单双栏拆分；
- 文本节点使用真实内容高度测量，不能重新设置 `height: 100%`；
- 字号与行距联合调整，目标高度利用率约为 `95%`，正常接受 `90%` 至 `98%`；
- 单块首次排版最多 8 次 DOM 测量；布局签名未变化时命中缓存，不重新测量；
- 覆盖层只挂载当前页及前后各一页，同页滚动不重排；
- 显示原文/显示译文通过 CSS 快速切换，不触发文字重测。

人工检查高覆盖块时，应同时观察“没有大块空白”和“末行未越出块底部”。不能仅靠增大字号解决，因为长译文会溢出；也不能用固定高度伪造利用率。

## 6. 固定打包流程

只在仓库根目录运行：

```powershell
.\tools\build_reader_selection_replacer_test_xpi.ps1
```

脚本从 `manifest.json` 读取版本并验证：

- `manifest.json` 与 `bootstrap.js` 版本一致；
- 插件 ID 和 Zotero `9.0` 至 `9.*` 兼容声明正确；
- 根目录结构和固定文件清单完全匹配；
- 临时包通过校验后才原子替换正式 XPI；
- 输出文件大小和 SHA-256。

1.2.0 的预期产物是：

```text
dist/Translator-for-Zotero-1.2.0.xpi
```

不要手工压缩、不要传入独立版本号、不要修改生成后的 XPI。验包时可运行：

```powershell
python -m pytest tests/test_reader_selection_replacer_test_plugin.py
Get-FileHash dist/Translator-for-Zotero-1.2.0.xpi -Algorithm SHA256
```

## 7. Zotero 人工验收

1. 完全退出 Zotero，确认任务管理器中没有残留进程。
2. 在 `工具 -> 插件` 中拖入当前 XPI，重启 Zotero。
3. 打开含文字层的单栏与双栏英文论文。
4. 检查右侧栏可见，千问/DeepSeek 密钥可分别保存和验证。
5. 检查标题和摘要自动翻译，失败时可单独重试。
6. 分别翻译完整段落、段落中段、跨多行选区和双栏选区。
7. 检查译文可拖选复制，复制内容不包含按钮或 P1/P2 标签。
8. 从页面顶部和底部切换原文/译文，确认两处状态同步。
9. 检查高覆盖块的译文接近填满但不溢出；缩放后重新排版正确。
10. 连续滚动长文档，确认活动覆盖层不超过三页且没有明显卡顿。
11. 断网、无效 Key、超时和重试路径都应给出可恢复状态。

## 8. 版本与 GitHub 发布

发布新版本时，按以下顺序操作：

1. 同时更新 `manifest.json`、`bootstrap.js`、README 和版本断言。
2. 运行全部语法检查、Node 测试和 `pytest`。
3. 用固定脚本生成 XPI，并记录 SHA-256。
4. 检查 `git status` 与 `git diff --check`，只暂存本次发布文件。
5. 推送发布分支并创建 PR，等待检查通过后合并到 `main`。
6. 从合并后的 `main` 创建带注释标签，例如 `v1.2.0`。
7. 创建 GitHub Release，将对应 XPI 作为附件上传并在说明中列出主要变更和 SHA-256。
8. 在另一台机器下载 Release 附件再次安装，完成最终烟雾测试。

常用命令示例：

```powershell
git status --short
git diff --check
git add <明确的文件列表>
git commit -m "release: Translator for Zotero 1.2.0"
git push -u origin <release-branch>
gh pr create --base main --head <release-branch>
gh pr checks <pr-number> --watch
gh pr merge <pr-number> --merge --delete-branch
git tag -a v1.2.0 -m "Translator for Zotero 1.2.0"
git push origin v1.2.0
gh release create v1.2.0 dist/Translator-for-Zotero-1.2.0.xpi
```

## 9. 故障排查

- **XPI 无法安装**：确认使用固定脚本，XPI 根目录直接含 `manifest.json`/`bootstrap.js`，版本与 `strict_min_version`/`strict_max_version` 正确，并完全重启 Zotero。
- **侧栏不出现**：查看 Zotero Error Console，确认插件启动完成；冷启动注册已有重试，但损坏的旧安装状态仍需先完成卸载并重启。
- **无法选中文字**：先确认 PDF 是否有可复制文字层；扫描件需要外部 OCR。
- **译文选不中**：确认页面当前处于“显示译文”，覆盖文本的 `user-select` 为 `text`，底层原文只应在原文模式接收鼠标事件。
- **覆盖块上部拥挤、下部空白**：检查测量节点是否被恢复成 `height: 100%`，以及排版缓存签名是否在缩放后正确失效。
- **滚动卡顿**：检查是否又引入定时全量重绘、全页记录扫描或超过三页的常驻覆盖层。
- **翻译失败**：先检查 Provider、API Key、账户额度、地域端点和网络，再进行手动重试；不要在日志或 Issue 中粘贴真实密钥。

## 10. 交接完成标准

另一台电脑能够从全新克隆开始，独立完成依赖安装、全部测试、XPI 构建、Zotero 安装和至少一次伪/测试密钥翻译，即视为开发环境交接完成。交接时同时提供：目标提交哈希、Release 地址、XPI SHA-256、已知限制和未完成 Issue。
