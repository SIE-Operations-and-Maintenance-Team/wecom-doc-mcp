<div align="center">

# 📄 wecom-doc-mcp

**让 AI 助手实时读取企业微信文档**

[![MCP](https://img.shields.io/badge/MCP-兼容-blue?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJ3aGl0ZSI+PHBhdGggZD0iTTEyIDJMMiA3bDEwIDUgMTAtNS0xMC01ek0yIDE3bDEwIDUgMTAtNS0xMC01LTEwIDV6TTIgMTJsMTAgNSAxMC01LTEwLTUtMTAgNXoiLz48L3N2Zz4=)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/Node.js-≥18-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/许可证-MIT-yellow?style=for-the-badge)](LICENSE)

<br/>

<p>
  <img src="https://img.shields.io/badge/企业微信-文档-07C160?style=flat-square&logo=wechat&logoColor=white" />
  <img src="https://img.shields.io/badge/Claude_Code-就绪-D97706?style=flat-square" />
  <img src="https://img.shields.io/badge/Cookie-认证-red?style=flat-square&logo=cookiecutter&logoColor=white" />
</p>

[English](README.md) · [中文](#-为什么需要)

</div>

---

## 🤔 为什么需要

> 企业微信文档藏在 SSO 登录墙后面，AI 助手根本打不开。

这个 MCP Server 就是桥梁：你提供一次浏览器 Cookie，后续所有文档请求自动带上认证，抓取页面并转为 Markdown 返回。

```
💬 "帮我看下这个文档: https://doc.weixin.qq.com/doc/w3_xxx"
         │
         ▼
   ┌─────────────┐     🍪      ┌──────────────┐     📝     ┌──────────┐
   │ Claude Code  │ ──Cookie──▶ │  MCP Server   │ ──HTML──▶ │ Markdown │
   └─────────────┘             └──────────────┘            └──────────┘
```

## 🛠️ 提供的工具

| 工具                    | 说明                         |
|:--------------------- |:-------------------------- |
| 📖 `fetch_wecom_doc`  | 传入文档 URL → 返回 Markdown 内容  |
| 🍪 `set_wecom_cookie` | 保存 Cookie 到本地（`chmod 600`） |
| ✅ `check_wecom_auth`  | 检查已保存的 Cookie 是否有效         |

## 🚀 快速开始

### 第一步 — 安装

```bash
git clone https://github.com/SIE-Operations-and-Maintenance-Team/wecom-doc-mcp.git
cd wecom-doc-mcp
npm install
```

### 第二步 — 注册到 Claude Code

在 `~/.mcp.json` 中添加：

```json
{
  "mcpServers": {
    "wecom-doc": {
      "command": "npx",
      "args": ["tsx", "<clone到本地的路径>/wecom-doc-mcp/src/index.ts"]
    }
  }
}
```

### 第三步 — 获取 Cookie 🍪

```
1. 🌐  浏览器打开 doc.weixin.qq.com → 登录
2. 🔧  F12 打开开发者工具 → Network 标签
3. 📋  点击任意请求 → 复制 Cookie 请求头的值
```

示例：

> 在 Network 面板中，点击主文档请求 → 切到「标头」tab → 找到「请求标头」中的 `Cookie:` 行 → 复制整行值

### 第四步 — 开始使用

```text
你:     帮我设置企业微信 Cookie: <粘贴>
Claude: ✅ Cookie 已保存

你:     帮我看下这个文档: https://doc.weixin.qq.com/doc/w3_xxx
Claude: # 文档标题
        这是文档的内容...
```

## 📐 工作原理

```
                          wecom-doc-mcp
                    ┌─────────────────────┐
                    │                     │
  fetch_wecom_doc ──┤  📡 /dop-api/opendoc│
        │           │  调用企业微信内部 API  │
        │           │  获取文档 JSON 数据   │──── 📝 Markdown
        │           │                     │
        │           │  🧹 cleanDocText    │
        │           │  清理 HYPERLINK 标记  │
        │           │  转为可读纯文本       │
        │           │                     │
        │           │  📄 兜底: cheerio    │
        │           │  API 失败时解析 HTML  │
        │           └─────────────────────┘
        │
  set_wecom_cookie ─── 💾 ~/.claude/wecom-doc-mcp/.env (权限 600)
        │
  check_wecom_auth ─── 🏥 /dop-api/opendoc → clientVars.isLogin?
```

## 🔐 Cookie 认证方式

两种方式，随你选：

| 方式     | 用法                                                     | 场景          |
|:------ |:------------------------------------------------------ |:----------- |
| 💾 持久化 | `set_wecom_cookie` → 存入 `~/.claude/wecom-doc-mcp/.env` | 设置一次，一直用到过期 |
| ⚡ 单次传入 | 调用 `fetch_wecom_doc` 时传 `cookie` 参数                    | 临时覆盖        |

> 🔒 Cookie 文件在项目目录之外 — 不会被 git 提交，不会被共享，`chmod 600` 仅本人可读。

## 📑 支持的文档类型

| 类型      | URL 路径         | 状态  |
|:------- |:-------------- |:---:|
| 📝 文档   | `/doc/`        | ✅ 已验证 |
| 📊 表格   | `/sheet/`      | ✅ 已验证 |
| 🎞️ 幻灯片 | `/slide/`      | 🔧 无专用解析 |
| 🧠 脑图   | `/mind/`       | ✅ 已验证 |
| 🔀 流程图  | `/flowchart/`  | 🔧 无专用解析 |
| 📋 智能表格 | `/smartsheet/` | ✅ 已验证 |

- ✅ 已验证：有真实文档实测通过。表格（4 个页签）、智能表格（15 个工作表 / 2103 行）、
  文档（2 篇）为本轮实测；脑图为原作者验证（本轮仅补了渲染单元测试，未改动取数逻辑）。
- 🧪 已实现，待样例验证：代码路径已实现且有合成用例覆盖，但手上没有该类型的真实文档可跑，
  未经实测；若接口结构与预期不符会明确报错。
- 🔧 无专用解析：接口返回的正文结构未探明，工具会退化为「提取页面 HTML 并标注来源」，
  并剥掉工具栏等界面节点；不会再把界面文字当成正文返回。
  如需补齐，提供一条该类型的文档链接即可。

**表格**（`src/sheet.ts`）：单元格数据不落在文档正文接口里，而是
`collab_client_vars.initialAttributedText.text[0].related_sheet`，编码为
base64 + zlib + protobuf，按工作表输出 Markdown 表格。

- URL 带 `tab=<sheetId>` 时读取该工作表（会透传给接口），否则读取默认页签；
- 默认最多输出 100 行数据，超出部分写明省略了多少行；读大表用 `rowStart` / `rowEnd`
  指定数据行区间（1 基，不含表头），参数非数字或越界都会明确提示；
- 表头行之前的内容（模板标题、下拉选项定义）单独列出，不混进数据行；
- 日期列的原始值是 Excel 日期序列号（如 `46303` = 2026-10-08）。

**智能表格**（`src/smartsheet.ts`）：与表格不是同一套数据，而是**明文 JSON**，
放在 `text[0].workbook`（工作表/仪表盘/表单清单）与 `text[0].smartsheet` 里。

- 列名带类型标注（如 `状态(单选)`、`开始时间(日期)`），单选/人员解析为候选项名称，
  日期由毫秒时间戳转成本地日期，数字·公式显示计算结果；无法解析的类型标注 `[未解析的类型N]`；
- 一次请求只返回一个工作表的数据，要读别的工作表必须在链接里带 `tab=<工作表id>`，
  否则明确报错并提示；
- 行序取视图定义（与界面显示顺序一致），无视图定义的表单类工作表退回数据自身顺序；
- 跳过的空行数会在输出里写明。

其它可复跑验证（脚本放在本地临时目录，未随仓库提交）：`verify-sheet.ts`
（表格解析）、`verify-fixes.ts`（列映射与范围处理）、`verify-varint.ts`（大整数边界）、
`verify-smartsheet.ts`（智能表格，用真实响应）、`verify-mind.ts`（脑图渲染）、
`verify-e2e.ts`（需真实 Cookie，覆盖多页签、真实文档、真实智能表格、参数校验、
错误提示、防 Cookie 外泄；复制到项目根目录后 `npx tsx verify-e2e.ts`）。

## 📦 技术栈

| 依赖                          | 用途                 |
|:--------------------------- |:------------------ |
| `@modelcontextprotocol/sdk` | MCP 协议实现           |
| `cheerio`                   | HTML 解析            |
| `turndown`                  | HTML → Markdown 转换 |
| `tsx`                       | TypeScript 运行时     |

## 📄 许可证

MIT

---

<div align="center">
  <sub>为被企业文档淹没的团队而生 ❤️</sub>
</div>
