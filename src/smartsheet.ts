// 文件名: smartsheet.ts
// 创建版本: v1.0
// 最后更新: v1.1
// 改动历史:
//   v1.0 (2026-10-16): 初版，随 index.ts v1.3 引入 padType=smartsheet 智能表格解析
//   v1.1 (2026-10-19): 单元格中的图片 URL 输出为 Markdown 图片链接
// 引入版本: index.ts v1.4（新增 padType=smartsheet 智能表格解析）
// 说明: 智能表格与普通表格不是同一套数据：它不是 protobuf，而是**明文 JSON**，
//       放在 clientVars.collab_client_vars.initialAttributedText.text[0]：
//         workbook   : [{id,name,type,...}]                       工作表清单（含仪表盘/表单）
//         smartsheet : [[{t:3005, c:{1:sheetId, 3:{3:字段定义, 4:[视图]}}},
//                        {t:3028, c:{1:sheetId, 2:{1:{行id:{1:{字段id:单元格}}}}}}]]
//         字段定义: {字段id: {"30":列名, "31":类型号, <类型号>: 该类型的配置}}
//           类型号 1=文本 2=数字 4=日期 7=人员 17=单选 19=数字·公式
//           单选/人员的候选项在 字段定义[类型号]["3"] = [{1:id,2:名称,3:颜色}]
//         单元格取值形态（实测）:
//           文本   {"1":[{"1":"text","2":"值"}, ...]}  多段按顺序拼接
//           日期   {"4":"1720454400000"}                毫秒时间戳
//           单选   {"17":["选项id", ...]}               用字段定义里的候选项解析名称
//           数字·公式 {"36":{"1":"<内嵌 JSON 字符串>"}} 取 data[0].text
//         行列顺序取自视图 视图["4"]["1"]=行id 列表、["4"]["2"]=字段id 列表；
//         表单类工作表可能没有视图定义，此时退回数据自身的键顺序。
import { renderSheetMarkdown, type SheetTable } from "./sheet.js";
import { extractImageUrls, imagesMarkdown } from "./images.js";

// v1.0 - smartsheet 消息类型号
const MSG_META = 3005;   // 字段定义与视图
const MSG_DATA = 3028;   // 单元格数据

// v1.0 - 字段类型号 → 展示名（用于列名后的类型标注与未解析提示）
const TYPE_NAMES: Record<number, string> = {
  1: "文本",
  2: "数字",
  4: "日期",
  7: "人员",
  17: "单选",
  19: "数字/公式",
};

interface WorkSheetInfo
{
  id: string;
  name: string;
  type?: string;
}

// v1.0 - 毫秒时间戳渲染：零点按日期；带时分则保留到分钟
function formatTimestamp(ms: number): string
{
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ms);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0 || d.getSeconds() !== 0;
  return hasTime ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}

// v1.0 - 从字段定义里取选项字典：{选项id: 名称}
function optionNames(def: Record<string, unknown> | undefined, typeNo: number): Map<string, string>
{
  const map = new Map<string, string>();
  const typeCfg = def?.[String(typeNo)] as Record<string, unknown> | undefined;
  const dict = typeCfg?.["3"];
  if (Array.isArray(dict))
  {
    for (const item of dict)
    {
      const id = (item as Record<string, unknown>)?.["1"];
      const name = (item as Record<string, unknown>)?.["2"];
      if (typeof id === "string" && typeof name === "string") map.set(id, name);
    }
  }
  return map;
}

// v1.0 - 渲染单元格；未知形态返回可辨识的占位，不猜值
function renderCell(cell: Record<string, unknown> | undefined, def: Record<string, unknown> | undefined): string
{
  if (!cell) return "";

  // 文本：多段拼接
  if (Array.isArray(cell["1"]))
  {
    const text = (cell["1"] as Record<string, unknown>[])
      .map((run) => (typeof run?.["2"] === "string" ? (run["2"] as string) : ""))
      .join("");
    if (text !== "")
    {
      // v1.1 - 文本单元格本身就是图片地址时，按图片输出
      const imageUrls = extractImageUrls(text);
      if (imageUrls.length > 0 && imageUrls.some((url) => text.trim() === url))
      {
        return imagesMarkdown(imageUrls);
      }
      return text;
    }
  }

  // 数字·公式：结果内嵌在 JSON 字符串里
  const formula = cell["36"] as Record<string, unknown> | undefined;
  if (formula && typeof formula["1"] === "string")
  {
    try
    {
      const parsed = JSON.parse(formula["1"] as string) as { data?: Record<string, unknown>[] };
      const first = parsed?.data?.[0];
      const text = first?.["text"];
      if (typeof text === "string" && text !== "") return text;
      const num = first?.["number"];
      if (typeof num === "number") return String(num);
    }
    catch
    {
      // 内嵌 JSON 解不开时按“无值”处理，不显示原始串以免误导
    }
  }

  // 日期：毫秒时间戳
  const dateMs = cell["4"];
  if (typeof dateMs === "string" || typeof dateMs === "number")
  {
    const ms = Number(dateMs);
    if (Number.isFinite(ms)) return formatTimestamp(ms);
  }

  // 单选（含以名单做的责任人列）：候选项 id → 名称
  for (const typeNo of [17, 7])
  {
    const ids = cell[String(typeNo)];
    if (Array.isArray(ids) && ids.length > 0)
    {
      const names = optionNames(def, typeNo);
      return (ids as unknown[])
        .map((id) => (typeof id === "string" ? names.get(id) ?? id : String(id)))
        .join("、");
    }
  }

  // 只剩 30/31/32（类型、修改人、修改时间）说明这个单元格没有值，是空单元格而不是未知类型
  const valueKeys = Object.keys(cell).filter((k) => k !== "30" && k !== "31" && k !== "32");
  if (valueKeys.length === 0) return "";

  // v1.1 - 图片单元格的类型号可能不在已知列表里，先从单元格值里兜底提取图片 URL
  const imageUrls = extractImageUrls(cell);
  if (imageUrls.length > 0) return imagesMarkdown(imageUrls);

  // 有价值键但形态不认识：明确标注，不返回看起来像正常值的内容
  const typeNo = cell["30"];
  return typeof typeNo === "number"
    ? `[未解析的类型${typeNo}]`
    : `[未解析的取值键 ${valueKeys.join(",")}]`;
}

// v1.0 - 解析智能表格；data 为 /dop-api/opendoc 的响应体
export function decodeSmartsheet(data: unknown, tabId?: string): SheetTable
{
  const body = (data ?? {}) as { padType?: string; clientVars?: Record<string, unknown> };
  const clientVars = body.clientVars ?? {};
  const collab = (clientVars["collab_client_vars"] ?? {}) as Record<string, unknown>;
  const textSlots = ((collab["initialAttributedText"] as Record<string, unknown> | undefined)?.["text"] ?? []) as Record<string, unknown>[];
  const slot = textSlots[0] ?? {};

  const smartRaw = slot["smartsheet"];
  if (typeof smartRaw !== "string" || smartRaw === "")
  {
    throw new Error(`智能表格响应里没有 smartsheet 数据（文档类型 ${body.padType ?? "未知"}）`);
  }

  const sheets = parseJson<WorkSheetInfo[]>(slot["workbook"], []);
  const targetId = tabId || (typeof collab["padSubId"] === "string" ? collab["padSubId"] : "") || sheets[0]?.id || "";
  const current = sheets.find((s) => s.id === targetId);
  if (!current)
  {
    throw new Error(
      `未在智能表格中找到工作表 ${targetId || "(未指定)"}（可选：${sheets.map((s) => `${s.name}(${s.id})`).join("、") || "无"}）`
    );
  }

  const messages = parseJson<Record<string, unknown>[][]>(smartRaw, []).flat();
  const meta = messages.find((m) => m?.["t"] === MSG_META && (m["c"] as Record<string, unknown> | undefined)?.["1"] === targetId);
  const dataMsg = messages.find((m) => m?.["t"] === MSG_DATA && (m["c"] as Record<string, unknown> | undefined)?.["1"] === targetId);

  // 一次请求只返回一个工作表的数据：要读别的工作表必须在链接里带 tab=<工作表id>。
  // 这里必须明确报错，不能退化成一张空表——空表会被当成“这个表没数据”。
  if (!meta && !dataMsg)
  {
    const available = [...new Set(messages.map((m) => (m?.["c"] as Record<string, unknown> | undefined)?.["1"]).filter((x) => typeof x === "string"))];
    throw new Error(
      `响应里没有工作表 ${targetId} 的数据（本次响应只含 ${available.join("、") || "空"}）；请在链接里带上 tab=${targetId} 后重新获取`
    );
  }

  const metaContent = (meta?.["c"] ?? {}) as Record<string, unknown>;
  const metaInner = (metaContent["3"] ?? {}) as Record<string, unknown>;
  const fieldDefs = (metaInner["3"] ?? {}) as Record<string, Record<string, unknown>>;
  const views = (metaInner["4"] ?? []) as Record<string, unknown>[];
  const viewLayout = (views[0]?.["4"] ?? {}) as Record<string, unknown>;

  const dataContent = (dataMsg?.["c"] ?? {}) as Record<string, unknown>;
  const cellRows = ((dataContent["2"] as Record<string, unknown> | undefined)?.["1"] ?? {}) as Record<
    string,
    Record<string, unknown>
  >;

  // 行列顺序优先取视图定义；表单类工作表没有视图时退回数据自身顺序
  const viewRowIds = Array.isArray(viewLayout["1"]) ? (viewLayout["1"] as string[]) : [];
  const viewFieldIds = Array.isArray(viewLayout["2"]) ? (viewLayout["2"] as string[]) : [];
  const rowIds = viewRowIds.length > 0 ? viewRowIds : Object.keys(cellRows);
  const fieldIds = viewFieldIds.length > 0 ? viewFieldIds : Object.keys(fieldDefs);

  // 列名带上类型名，取值语义一眼可辨（如“时间(日期)”）
  const header = fieldIds.map((fid) =>
  {
    const def = fieldDefs[fid];
    const name = typeof def?.["30"] === "string" ? (def["30"] as string) : fid;
    const typeNo = typeof def?.["31"] === "number" ? (def["31"] as number) : undefined;
    const typeName = typeNo !== undefined ? TYPE_NAMES[typeNo] : undefined;
    return typeName ? `${name}(${typeName})` : name;
  });

  let skippedEmpty = 0;
  const rows: { rowIndex: number; cells: string[] }[] = [];
  for (const rowId of rowIds)
  {
    const cellsByField = (cellRows[rowId]?.["1"] ?? {}) as Record<string, Record<string, unknown>>;
    const cells = fieldIds.map((fid) => renderCell(cellsByField[fid], fieldDefs[fid]));
    if (cells.every((c) => c === ""))
    {
      skippedEmpty++;
      continue;
    }
    rows.push({ rowIndex: rows.length, cells });
  }

  const notes = [`共 ${rows.length} 行有内容，已跳过 ${skippedEmpty} 个空行`];
  if (fieldIds.some((fid) => fieldDefs[fid]?.["31"] === undefined))
  {
    notes.push("部分列缺少类型定义，已按列名原样输出");
  }

  return {
    title: String(clientVars["padTitle"] ?? clientVars["title"] ?? "企业微信智能表格"),
    tabId: current.id,
    tabName: current.name,
    tabs: sheets.map((s) => ({ id: s.id, name: s.name })),
    header,
    columnIndexes: fieldIds.map((_, i) => i),
    headerRowIndex: 0,
    preamble: [],
    rows,
    emptyColumnCount: 0,
    valueNote:
      "智能表格：日期按毫秒时间戳转成本地日期（含时分的保留到分钟）；单选/人员显示候选项名称；" +
      "数字·公式显示计算结果；图片单元格输出为 Markdown 图片链接；无法解析的类型会标注 [未解析的类型N]",
    extraNotes: notes,
  };
}

// v1.0 - 容错解析 JSON 字符串
function parseJson<T>(raw: unknown, fallback: T): T
{
  if (typeof raw !== "string" || raw === "") return fallback;
  try
  {
    return JSON.parse(raw) as T;
  }
  catch
  {
    return fallback;
  }
}
