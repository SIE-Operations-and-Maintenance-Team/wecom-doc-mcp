<div align="center">

# 📄 wecom-doc-mcp

**Let AI read your Enterprise WeChat docs — in real time.**

[![MCP](https://img.shields.io/badge/MCP-Compatible-blue?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJ3aGl0ZSI+PHBhdGggZD0iTTEyIDJMMiA3bDEwIDUgMTAtNS0xMC01ek0yIDE3bDEwIDUgMTAtNS0xMC01LTEwIDV6TTIgMTJsMTAgNSAxMC01LTEwLTUtMTAgNXoiLz48L3N2Zz4=)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/Node.js-≥18-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](LICENSE)

<br/>

<p>
  <img src="https://img.shields.io/badge/企业微信-文档-07C160?style=flat-square&logo=wechat&logoColor=white" />
  <img src="https://img.shields.io/badge/Claude_Code-Ready-D97706?style=flat-square" />
  <img src="https://img.shields.io/badge/Cookie-Auth-red?style=flat-square&logo=cookiecutter&logoColor=white" />
</p>

[English](#-why) · [中文](README_CN.md)

</div>

---

## 🤔 Why

> Enterprise WeChat documents sit behind SSO. AI assistants can't access them.

This MCP server bridges the gap: provide your browser cookie once, and the server handles authenticated fetching + HTML-to-Markdown conversion on every request.

```
💬 "帮我看下这个文档: https://doc.weixin.qq.com/doc/w3_xxx"
         │
         ▼
   ┌─────────────┐     🍪      ┌──────────────┐     📝     ┌──────────┐
   │ Claude Code  │ ──Cookie──▶ │  MCP Server   │ ──HTML──▶ │ Markdown │
   └─────────────┘             └──────────────┘            └──────────┘
```

## 🛠️ Tools

| Tool | Description |
|:-----|:------------|
| 📖 `fetch_wecom_doc` | Fetch a document by URL → return Markdown |
| 🍪 `set_wecom_cookie` | Save cookie locally (`chmod 600`) |
| ✅ `check_wecom_auth` | Verify if saved cookie is still valid |

## 🚀 Quick Start

### Step 1 — Install

```bash
git clone https://github.com/SIE-Operations-and-Maintenance-Team/wecom-doc-mcp.git
cd wecom-doc-mcp
npm install
```

### Step 2 — Register with Claude Code

Add to `~/.mcp.json`:

```json
{
  "mcpServers": {
    "wecom-doc": {
      "command": "npx",
      "args": ["tsx", "/path/to/wecom-doc-mcp/src/index.ts"]
    }
  }
}
```

### Step 3 — Get Your Cookie 🍪

```
1. 🌐  Open doc.weixin.qq.com → log in
2. 🔧  F12 → Network tab
3. 📋  Click any request → copy the Cookie header value
```

### Step 4 — Use It

```text
You:    帮我设置企业微信 Cookie: <paste>
Claude: ✅ Cookie 已保存

You:    帮我看下这个文档: https://doc.weixin.qq.com/doc/w3_xxx
Claude: # 文档标题
        这是文档的内容...
```

## 📐 Architecture

```
                          wecom-doc-mcp
                    ┌─────────────────────┐
                    │                     │
  fetch_wecom_doc ──┤  📡 /dop-api/opendoc│
        │           │  Call WeChat's       │
        │           │  internal API for    │──── 📝 Markdown
        │           │  document JSON data  │
        │           │                     │
        │           │  🧹 cleanDocText    │
        │           │  Strip HYPERLINK     │
        │           │  markup → clean text │
        │           │                     │
        │           │  📄 Fallback:       │
        │           │  cheerio + turndown  │
        │           └─────────────────────┘
        │
  set_wecom_cookie ─── 💾 ~/.claude/wecom-doc-mcp/.env (mode 600)
        │
  check_wecom_auth ─── 🏥 /dop-api/opendoc → clientVars.isLogin?
```

## 🔐 Cookie Auth

Two modes, your choice:

| Mode | How | When |
|:-----|:----|:-----|
| 💾 Persistent | `set_wecom_cookie` → saved to `~/.claude/wecom-doc-mcp/.env` | Set once, use forever (until expiry) |
| ⚡ Per-request | Pass `cookie` param to `fetch_wecom_doc` | Override on the fly |

> 🔒 Cookie file lives outside the project directory — never committed, never shared, `chmod 600`.

## 📑 Supported Document Types

| Type | URL Pattern | Status |
|:-----|:------------|:------:|
| 📝 Documents | `/doc/` | ✅ Verified |
| 📊 Spreadsheets | `/sheet/` | ✅ Verified |
| 🎞️ Slides | `/slide/` | 🔧 No dedicated parser |
| 🧠 Mind Maps | `/mind/` | ✅ Verified |
| 🔀 Flowcharts | `/flowchart/` | 🔧 No dedicated parser |
| 📋 Smart Sheets | `/smartsheet/` | ✅ Verified |

- ✅ Verified: exercised against real documents. Spreadsheets (4 worksheet tabs), smart sheets
  (15 worksheets / 2103 rows) and documents (2 files) were verified in this round; mind maps were
  verified by the original author (this round only added rendering unit tests, the fetching logic
  is unchanged).
- 🧪 Implemented, needs a sample: code path implemented and covered by synthetic cases, but no
  real document of this type was available; a payload mismatch raises a clear error.
- 🔧 No dedicated parser: the payload shape is unknown, so the tool falls back to extracting the
  page HTML, strips toolbar/menu nodes, and labels the result as page text.

**Spreadsheets** (`src/sheet.ts`): cells are not part of the document-text payload but live in
`collab_client_vars.initialAttributedText.text[0].related_sheet` as
base64 + zlib + protobuf, rendered as one Markdown table per worksheet.

- `tab=<sheetId>` in the URL selects the worksheet (forwarded to the API); otherwise the default tab is read;
- at most 100 data rows per call by default, with an explicit note of how many were omitted;
  use `rowStart` / `rowEnd` (1-based, header excluded) — non-numeric or out-of-range values are reported;
- rows above the header (template title, dropdown option definitions) are listed separately;
- date cells hold Excel serial numbers (e.g. `46303` = 2026-10-08).

**Smart Sheets** (`src/smartsheet.ts`): a different payload — plain JSON in `text[0].workbook`
(sheets, dashboards, forms) and `text[0].smartsheet`.

- Column names carry their type (e.g. `状态(单选)`, `开始时间(日期)`); single-select/person columns
  resolve to option names; dates are converted from millisecond timestamps to local dates;
  number/formula columns show the computed result; unsupported shapes are marked `[未解析的类型N]`;
- one request returns a single worksheet — other worksheets need `tab=<sheetId>` in the link,
  otherwise the tool fails with an explicit message;
- row order follows the view definition (matching the UI); form-backed worksheets fall back to the
  payload's own order; skipped empty rows are reported.

Re-runnable checks (scripts kept in a local temp directory, not committed): `verify-sheet.ts`,
`verify-fixes.ts`, `verify-varint.ts`, `verify-smartsheet.ts` (real responses), `verify-mind.ts`,
and `verify-e2e.ts` (needs a live cookie; covers worksheets, real documents, real smart sheets,
parameter validation, error messages, and cookie leak prevention — copy it into the project root
and run `npx tsx verify-e2e.ts`).

## 📦 Tech Stack

| Dependency | Purpose |
|:-----------|:--------|
| `@modelcontextprotocol/sdk` | MCP protocol implementation |
| `cheerio` | HTML parsing |
| `turndown` | HTML → Markdown conversion |
| `tsx` | TypeScript runtime |

## 📄 License

MIT

---

<div align="center">
  <sub>Built with ❤️ for teams drowning in enterprise docs</sub>
</div>
