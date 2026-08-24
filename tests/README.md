# 🧪 自动化测试

本目录使用 Node.js 内置测试运行器，不依赖 Zotero、真实 PDF、真实网络或第三方测试框架。Zotero 全局对象、偏好设置、登录凭据、页面视口和 HTTP 请求均由 `helpers.js` 创建的 VM 沙箱提供；网络用例只返回本地 mock 响应。

## ▶️ 运行方式

在仓库根目录执行：

`powershell
node --test tests/*.test.js
`

也可以使用更易读的 spec 报告：

`powershell
node --test --test-reporter=spec tests/*.test.js
`

## 🧭 覆盖范围

| 脚本 | 重点 |
| --- | --- |
| `text-extraction.test.js` | PDF 矩形投影、0/90/180/270 度旋转、缓存、视口故障、标题/摘要/正文边界、跨页定位、选区位置归一化 |
| `text-parsing.test.js` | 中英文检测、元数据段结构化、单栏/双栏分组、显式段落断点、几何断点、DeepSeek JSON 校验、选择单元和缓存封装 |
| `network-communication.test.js` | Provider 注册、DeepSeek/Qwen/Gemini/Bing/Transmart/CNKI 请求协议、鉴权、重试、分片、Token 缓存、验证码和协调器结果 |

## 🛡️ 测试边界

- 不调用真实翻译服务，避免泄露密钥、网络波动和供应商配额影响结果。
- 不依赖本机 Zotero 配置、SQLite 文件或浏览器 DOM。
- 每个测试通过独立 VM 上下文加载插件模块，避免全局状态在用例间串联。
- 测试脚本属于开发验证资产，不会被 `tools/build_xpi.ps1` 打进 XPI。
