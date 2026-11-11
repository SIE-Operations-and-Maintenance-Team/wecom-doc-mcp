// 文件名: index.ts
// 创建版本: v1.0
// 最后更新: v1.4
// 改动历史:
//   v1.0 (2026-04-24): 初始创建，企业微信文档 MCP Server
//   v1.1 (2026-04-24): 修复登录检测误判，改用 /dop-api/opendoc 接口抓取文档正文
//   v1.2 (2026-04-24): 支持脑图(mind)类型，递归提取树形节点为 Markdown
//   v1.3 (2026-10-16): 支持表格(sheet)类型，单元格解析交给 sheet.ts；
//                      支持智能表格(smartsheet)：另一种明文 JSON 结构，解析在 smartsheet.ts
//                      （原先把两者当作同源结构，经真实样例验证后纠正）；
//                      修正 check_wecom_auth 的误判（原先用主页状态码，恒为 3xx）；
//                      新增 rowStart/rowEnd 用于分段读取大表格，非法值报错而不是静默忽略；
//                      URL 里带 tab 时透传给接口（不传只会拿到默认页签的数据）；
//                      URL 校验改为严格比对主机名与协议，避免把 Cookie 发往第三方域名；
//                      blankpage 带标题时提示“文档存在但接口取不到内容”，不再一律说无权限；
//                      所有请求加 30s 超时；
//                      HTML 兜底剥掉界面节点并标注来源，非 doc 类型的通用正文提取同样标注来源；
//                      类型判定统一取顶层与 clientVars 两处 padType；
//                      脑图渲染抽到 mind.ts，未渲染的子主题容器会标注数量
//   v1.4 (2026-10-19): 统一支持图片输出：文档 drawing、表格图片单元格、智能表格单元格、
//                      脑图节点中的图片均转为 Markdown 图片链接（逻辑在 images.ts）

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { decodeSheet, renderSheetMarkdown } from "./sheet.js";
import { renderMindTree } from "./mind.js";
import { decodeSmartsheet } from "./smartsheet.js";
import { extractImageUrls, imageMarkdown } from "./images.js";

// v1.0 - Cookie 存储路径
const CONFIG_DIR = join(homedir(), ".claude", "wecom-doc-mcp");
const ENV_FILE = join(CONFIG_DIR, ".env");

// v1.0 - Turndown 实例，HTML 转 Markdown
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

// v1.0 - 从配置文件读取 Cookie
function loadCookieFromFile(): string | null {
  try {
    if (!existsSync(ENV_FILE)) return null;
    const content = readFileSync(ENV_FILE, "utf-8");
    const match = content.match(/^WECOM_COOKIE=(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

// v1.0 - 保存 Cookie 到配置文件
function saveCookieToFile(cookie: string): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(ENV_FILE, `WECOM_COOKIE=${cookie}\n`, "utf-8");
  chmodSync(ENV_FILE, 0o600);
}

// v1.0 - 获取有效 Cookie（参数优先，否则读配置文件）
function getEffectiveCookie(paramCookie?: string): string | null {
  return paramCookie?.trim() || loadCookieFromFile();
}

// v1.0 - 通用请求头
function buildHeaders(cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: "https://doc.weixin.qq.com/",
  };
}

// v1.0 - 从 URL 提取文档 ID
function extractDocId(url: string): string | null {
  const patterns = [
    /\/doc\/([A-Za-z0-9_-]+)/,
    /\/sheet\/([A-Za-z0-9_-]+)/,
    /\/slide\/([A-Za-z0-9_-]+)/,
    /\/mind\/([A-Za-z0-9_-]+)/,
    /\/flowchart\/([A-Za-z0-9_-]+)/,
    /\/smartsheet\/([A-Za-z0-9_-]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// v1.1 - 清理文档原始文本中的 HYPERLINK 标记，转为 Markdown 链接
function cleanDocText(raw: string): string {
  // v1.1 - 匹配所有 HYPERLINK 模式，提取 URL 转为 Markdown 链接
  let text = raw.replace(
    /\x13?HYPERLINK\s+(https?:\/\/\S+)[^\x13一-鿿\n]*/g,
    (_, url) => `[链接](${url})`
  );
  // v1.1 - 清理残留 \x13 控制字符
  text = text.replace(/\x13/g, "");
  // v1.1 - 将 \r 转为换行
  text = text.replace(/\r/g, "\n");
  // v1.1 - 清理多余空行
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// v1.3 - 表格读取选项
interface FetchOptions
{
  rowStart?: number;
  rowEnd?: number;
}

// v1.3 - 请求超时：没有超时的话上游不响应会一直挂住 MCP 调用
const REQUEST_TIMEOUT_MS = 30000;

// v1.3 - 解析可选的数字参数，非法值直接报错而不是静默忽略
function parseOptionalNumber(value: unknown, name: string): number | undefined
{
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
  {
    throw new Error(`${name} 必须是数字，收到 ${JSON.stringify(value)}`);
  }
  return Math.floor(value);
}

// v1.1 - 通过 /dop-api/opendoc 接口抓取文档内容
async function fetchWecomDoc(
  url: string,
  cookie: string,
  options: FetchOptions = {}
): Promise<string> {
  const headers = buildHeaders(cookie);
  const padId = extractDocId(url);

  if (!padId) {
    throw new Error("无法从 URL 中提取文档 ID");
  }

  // v1.3 - URL 带 tab 时透传给接口：不传只会返回默认页签的数据，指定页签的内容根本不会出现在响应里
  let tabId: string | undefined;
  try {
    tabId = new URL(url).searchParams.get("tab") ?? undefined;
  } catch {
    tabId = undefined;
  }

  // v1.1 - 调用 opendoc API 获取文档数据
  const apiUrl =
    `https://doc.weixin.qq.com/dop-api/opendoc?normal=1&noEscape=1&outformat=1&id=${padId}` +
    (tabId ? `&tab=${encodeURIComponent(tabId)}` : "");
  const apiResp = await fetch(apiUrl, {
    headers: {
      ...headers,
      Accept: "application/json, text/plain, */*",
      Referer: url,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!apiResp.ok) {
    if (apiResp.status === 401 || apiResp.status === 403) {
      throw new Error(
        `认证失败 (${apiResp.status})，Cookie 可能已过期，请使用 set_wecom_cookie 更新`
      );
    }
    throw new Error(`API 请求失败: HTTP ${apiResp.status} ${apiResp.statusText}`);
  }

  const data = await apiResp.json() as any;

  // v1.3 - 类型判定统一放在分支之前：顶层与 clientVars 里都可能带 padType，两处口径必须一致
  const bodyPadType = String(data?.padType ?? data?.clientVars?.padType ?? "");

  // v1.3 - 接口对无权限/不存在的文档也返回 200 + padType=blankpage，需要区分三种情况：
  //        isLogin=false 是 Cookie 失效；带标题说明文档存在（只是本接口取不到内容，如部分智能表格）；
  //        标题也为空才是真的不存在或无权限。
  if (data?.clientVars?.isLogin === false) {
    throw new Error(
      "Cookie 已失效，请使用 set_wecom_cookie 更新 Cookie（接口返回未登录状态）"
    );
  }
  if (bodyPadType === "blankpage") {
    const knownTitle = String(data?.clientVars?.padTitle ?? data?.clientVars?.title ?? "");
    throw new Error(
      knownTitle
        ? `文档「${knownTitle}」存在且可访问，但当前接口取不到内容（例如部分智能表格需要通过客户端打开）。已识别类型：${bodyPadType}`
        : "文档不存在或当前账号无访问权限（接口返回空白页；请确认链接有效、且该文档已授权给当前登录账号）"
    );
  }

  // v1.3 - 智能表格：与表格不是同一套数据（明文 JSON，见 smartsheet.ts），单独分支
  if (bodyPadType === "smartsheet") {
    const table = decodeSmartsheet(data, tabId);
    return renderSheetMarkdown(table, {
      rowStart: options.rowStart,
      rowEnd: options.rowEnd,
    });
  }

  // v1.3 - 表格：单元格不在 commands 里，改由 sheet.ts 解析 related_sheet。
  //        id 形如 s3_xxx 的文档会被客户端从 /sheet/ 改写为 /smartsheet/，
  //        所以 id 命中该形态且接口没给类型时也按表格尝试解析。
  if (bodyPadType === "sheet" || (!bodyPadType && /^s\d_/.test(padId))) {
    const table = decodeSheet(data, tabId);
    return renderSheetMarkdown(table, {
      rowStart: options.rowStart,
      rowEnd: options.rowEnd,
    });
  }

  // v1.1 - 提取标题
  const title =
    data?.clientVars?.padTitle ||
    data?.clientVars?.initialTitle ||
    data?.clientVars?.title ||
    "未知标题";

  // v1.1 - 提取文档正文
  let docText = "";
  // v1.3 - 正文提取失败的原因要留下来，不能吞掉：否则调用方不知道为何退化成抓页面
  let commandError: string | null = null;

  // v1.2 - 脑图类型：递归提取树形节点（渲染逻辑在 mind.ts，便于单独验证）
  const textArr = data?.clientVars?.collab_client_vars?.initialAttributedText?.text;
  if (bodyPadType === "mind" && textArr?.[0]?.content?.[0]?.rootTopic) {
    return renderMindTree(textArr[0].content[0].rootTopic);
  }

  try {
    const commands =
      data?.clientVars?.collab_client_vars?.initialAttributedText?.text?.[0]?.commands;
    if (commands && commands.length > 0) {
      // v1.4 - 先收集正文与图片位置：文档图片的 bi/ei 是正文里的字符偏移，
      //        直接追加会把所有图片堆到文末，这里按偏移插回对应位置。
      let baseText: string | null = null;
      let baseOffset = 0;
      let textMutationCount = 0;
      const extraText: string[] = [];
      const imageGroups = new Map<number, string[]>();

      for (const cmd of commands) {
        if (!cmd.mutations) continue;
        for (const m of cmd.mutations) {
          if (m.s && typeof m.s === "string" && m.s !== "") {
            textMutationCount++;
            if (m.ty === "is" && baseText === null) {
              baseText = m.s;
              baseOffset = typeof m.bi === "number" ? m.bi : 0;
            } else {
              extraText.push(m.s);
            }
          }
          // v1.4 - 文档图片：ty=mp / mt=drawing，地址在 drawing...blip.embed
          const drawing = m?.pr?.drawing ?? (m?.mt === "drawing" ? m?.pr : undefined);
          if (drawing) {
            const imageUrls = extractImageUrls(drawing);
            if (imageUrls.length > 0) {
              const pos = typeof m.bi === "number" ? m.bi : Number.MAX_SAFE_INTEGER;
              const marks = imageGroups.get(pos) ?? [];
              marks.push(...imageUrls.map((url) => imageMarkdown(url)));
              imageGroups.set(pos, marks);
            }
          }
        }
      }

      if (baseText !== null && textMutationCount === 1 && imageGroups.size > 0) {
        // 从后往前替换，前面的插入不会影响后面的偏移；同一位置的图片合并后一次插入
        let merged = baseText;
        for (const [pos, marks] of [...imageGroups.entries()].sort((a, b) => b[0] - a[0])) {
          const relative = pos - baseOffset;
          const block = `\n\n${marks.join("\n\n")}\n\n`;
          if (relative < 0 || relative > merged.length) {
            merged += block;
            continue;
          }
          // 图片占位符是 \b（部分文档是 \uFFFC），替换掉；否则按插入点插入
          const placeholder = merged[relative];
          const end = placeholder === "\b" || placeholder === "\uFFFC" ? relative + 1 : relative;
          merged = merged.slice(0, relative) + block + merged.slice(end);
        }
        docText = merged + extraText.join("");
      } else {
        docText = (baseText ?? "") + extraText.join("");
        if (imageGroups.size > 0) {
          const allMarks = [...imageGroups.values()].flat();
          docText += `\n\n${allMarks.join("\n\n")}\n\n`;
        }
      }
    }
  } catch (e: any) {
    commandError = e?.message ? String(e.message) : String(e);
  }

  if (!docText) {
    // v1.3 - 兜底：从 HTML 页面提取。页面 HTML 里混有工具栏、菜单等界面文字，
    //        因此先剥掉界面节点，并在结果前明确标注来源与类型，避免被当成正文。
    return await fallbackFromHtml(url, headers, title, bodyPadType, commandError);
  }

  // v1.1 - 清理控制标记
  const cleanedText = cleanDocText(docText);

  // v1.3 - 非文档类型走到通用正文提取时加一行来源说明，避免把通用提取结果当成专用解析的产物
  const genericNote =
    bodyPadType && bodyPadType !== "doc"
      ? `> 说明：文档类型 ${bodyPadType} 无专用解析，以下内容按通用正文规则提取，可能不完整。\n\n`
      : "";

  return `# ${title}\n\n${genericNote}${cleanedText}`;
}

// v1.3 - HTML 兜底提取：剥掉界面节点，并说明内容来源，取不到正文时明确报出类型
async function fallbackFromHtml(
  url: string,
  headers: Record<string, string>,
  title: string,
  padType: string,
  commandError: string | null
): Promise<string> {
  const pageResp = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const html = await pageResp.text();
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer, noscript, link, meta").remove();
  // 工具栏/菜单/提示层等界面节点：留着只会变成一眼看不懂的碎片文字
  $(
    ".toolbar, [role='toolbar'], [role='menubar'], [role='menu'], [role='navigation'], " +
      "[aria-hidden='true'], .pc-toolbar, .pc-header-toolbar, .menu-bar, .formula-bar, " +
      ".pc-tab, .sheet-tab, .tooltip, .popover, .toast, [class*='toolbar'], [id*='toolbar']"
  ).remove();
  const bodyHtml = $("body").html() || html;
  const markdown = turndown.turndown(bodyHtml).replace(/\n{3,}/g, "\n\n").trim();

  const typeLabel = padType || "未知";
  const reason = commandError
    ? `\n> 说明：接口正文提取时报错（${commandError}），已退化为页面文本。`
    : "";
  const header =
    `> ⚠️ 文档类型 ${typeLabel} 没有专用解析实现，以下内容取自页面 HTML，可能混有界面文字或缺失正文。\n` +
    `> 如需支持该类型，请提供该文档链接以便按其接口结构补充解析。${reason}`;

  // 兜底结果过短时基本等同于没取到正文，直接说清楚，不糊一篇工具栏碎片给调用方
  if (markdown.length < 40) {
    return `# ${title}\n\n${header}\n未从页面中取到可读正文（文档类型：${typeLabel}）。`;
  }
  return `# ${title}\n\n${header}\n${markdown}`;
}

// v1.3 - 探测用文档 ID：不存在的 ID 也能返回登录态，因此无需依赖真实文档
const AUTH_PROBE_PAD_ID = "e3_00000000000000000000000000";

// v1.3 - 检查 Cookie 有效性。
//        原实现请求首页并判断 status === 200，但首页带 redirect: "manual" 时返回 3xx，
//        导致有效 Cookie 也被判为失效；改为读 opendoc 的 clientVars.isLogin。
async function checkAuth(cookie: string): Promise<boolean> {
  try {
    const resp = await fetch(
      `https://doc.weixin.qq.com/dop-api/opendoc?normal=1&noEscape=1&outformat=1&id=${AUTH_PROBE_PAD_ID}`,
      {
        headers: {
          ...buildHeaders(cookie),
          Accept: "application/json, text/plain, */*",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (!resp.ok) return false;
    const data = await resp.json() as any;
    return data?.clientVars?.isLogin === true;
  } catch {
    return false;
  }
}

// v1.0 - MCP Server 初始化
const server = new Server(
  { name: "wecom-doc", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "企业微信文档读取工具。使用前需要先通过 set_wecom_cookie 设置 Cookie，" +
      "或在 ~/.claude/wecom-doc-mcp/.env 中配置 WECOM_COOKIE。" +
      "Cookie 获取方式：在浏览器中登录 doc.weixin.qq.com，打开开发者工具 → Network → " +
      "复制任意请求的 Cookie 请求头值。",
  }
);

// v1.0 - 注册工具列表
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "fetch_wecom_doc",
      description:
        "抓取企业微信文档内容并转为 Markdown。" +
        "文档(doc)、脑图(mind)、表格(sheet)有专用解析，智能表格(smartsheet)按表格同源结构解析；" +
        "文档、表格、智能表格和脑图中的图片会输出为 Markdown 图片链接；" +
        "表格按工作表返回 Markdown 表格，默认最多输出 100 行数据，" +
        "行数较多时用 rowStart/rowEnd 指定数据行区间（1 基，不含表头，表头行之后计起）；" +
        "幻灯片、流程图等类型暂无专用解析，会返回页面文本并标注来源。",
      inputSchema: {
        type: "object" as const,
        properties: {
          url: {
            type: "string",
            description: "企业微信文档链接，如 https://doc.weixin.qq.com/doc/xxx",
          },
          cookie: {
            type: "string",
            description: "可选，临时 Cookie。不传则使用已保存的 Cookie",
          },
          rowStart: {
            type: "number",
            description: "可选，仅表格有效：起始数据行号（1 基，不含表头）",
          },
          rowEnd: {
            type: "number",
            description: "可选，仅表格有效：结束数据行号（含）",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "set_wecom_cookie",
      description:
        "保存企业微信 Cookie 到本地配置文件，后续请求自动使用。" +
        "Cookie 获取：浏览器登录 doc.weixin.qq.com → F12 → Network → 复制 Cookie 头。",
      inputSchema: {
        type: "object" as const,
        properties: {
          cookie: {
            type: "string",
            description: "完整的 Cookie 字符串",
          },
        },
        required: ["cookie"],
      },
    },
    {
      name: "check_wecom_auth",
      description: "检查当前保存的 Cookie 是否仍然有效",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ],
}));

// v1.0 - 工具调用处理
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "fetch_wecom_doc": {
      const url = args?.url as string;
      if (!url) {
        return { content: [{ type: "text", text: "错误：缺少 url 参数" }] };
      }
      // v1.3 - 必须校验主机名与协议，不能用 includes：像 https://evil.com/doc/e3_xxx?doc.weixin.qq.com
      //        这类地址能骗过子串判断，而兜底抓取会带着 Cookie 请求该地址，等于把凭据发给第三方
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        return { content: [{ type: "text", text: "错误：URL 格式不正确" }] };
      }
      if (target.protocol !== "https:" || target.hostname !== "doc.weixin.qq.com") {
        return {
          content: [
            {
              type: "text",
              text:
                "错误：URL 必须是 https://doc.weixin.qq.com 下的文档链接" +
                `（当前为 ${target.protocol}//${target.hostname}）。` +
                "为免 Cookie 泄露，不向其它域名发送请求。",
            },
          ],
        };
      }
      const cookie = getEffectiveCookie(args?.cookie as string | undefined);
      if (!cookie) {
        return {
          content: [
            {
              type: "text",
              text: "错误：未找到 Cookie。请先使用 set_wecom_cookie 设置，或在调用时传入 cookie 参数。\n\n" +
                "获取方式：浏览器登录 doc.weixin.qq.com → F12 → Network → 复制任意请求的 Cookie 头",
            },
          ],
        };
      }
      let options: FetchOptions;
      try {
        options = {
          rowStart: parseOptionalNumber(args?.rowStart, "rowStart"),
          rowEnd: parseOptionalNumber(args?.rowEnd, "rowEnd"),
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `参数错误：${e.message}` }],
        };
      }

      try {
        const markdown = await fetchWecomDoc(url, cookie, options);
        return { content: [{ type: "text", text: markdown }] };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `抓取失败：${e.message}` }],
        };
      }
    }

    case "set_wecom_cookie": {
      const cookie = args?.cookie as string;
      if (!cookie) {
        return { content: [{ type: "text", text: "错误：缺少 cookie 参数" }] };
      }
      saveCookieToFile(cookie);
      return {
        content: [
          {
            type: "text",
            text: `Cookie 已保存到 ${ENV_FILE}（权限 600）。后续调用 fetch_wecom_doc 将自动使用此 Cookie。`,
          },
        ],
      };
    }

    case "check_wecom_auth": {
      const cookie = loadCookieFromFile();
      if (!cookie) {
        return {
          content: [
            {
              type: "text",
              text: "未找到已保存的 Cookie，请先使用 set_wecom_cookie 设置。",
            },
          ],
        };
      }
      const valid = await checkAuth(cookie);
      return {
        content: [
          {
            type: "text",
            text: valid
              ? "Cookie 有效，可以正常访问企业微信文档。"
              : "Cookie 已失效或无法连接，请重新获取并使用 set_wecom_cookie 更新。",
          },
        ],
      };
    }

    default:
      return { content: [{ type: "text", text: `未知工具: ${name}` }] };
  }
});

// v1.0 - 启动 server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// v1.0 - 防止未捕获异常导致进程退出
process.on("unhandledRejection", (err) => {
  console.error("[wecom-doc-mcp] unhandledRejection:", err);
});

main().catch((err) => {
  console.error("[wecom-doc-mcp] 启动失败:", err);
  process.exit(1);
});
