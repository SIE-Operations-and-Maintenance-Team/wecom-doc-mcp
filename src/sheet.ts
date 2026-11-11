// 文件名: sheet.ts
// 创建版本: v1.0
// 最后更新: v1.2
// 改动历史:
//   v1.0 (2026-10-16): 初版，随 index.ts v1.3 引入 padType=sheet 表格解析
//   v1.1 (2026-10-16): varint 改用算术累加（原位移累加是 32 位运算，会截断手机号、
//                      毫秒时间戳量级的大整数）；列名与列号按原始列索引取值，
//                      剔除全空列后不再串列；行范围越界/倒序给出明确提示；
//                      数字池基准为负时退回按位置直取
//   v1.2 (2026-10-19): 解析图片单元格（f3.f17）并输出 Markdown 图片链接
// 引入版本: index.ts v1.4（新增 padType=sheet 表格解析）
// 说明: 企业微信表格数据解析。表格单元格不落在 initialAttributedText.commands 里，
//       而是放在 clientVars.collab_client_vars.initialAttributedText.text[0].related_sheet，
//       编码为 base64(zlib(protobuf))，本模块自行解析线格式，不依赖 .proto 文件。
//
// 实测 protobuf 结构（字段号为抓包实得，非官方文档）：
//   root.f1.f5[]                      每个分块对应一个工作表
//     .f19                            表格数据块
//       .f3.f1                        sheetId，如 BB08J2
//       .f4                           样式表（本模块未使用）
//       .f5                           值池
//         .f1[]                       字符串池
//         .f2[]                       富文本池
//         .f3[]                       数字池
//         .f4[]                       全局值 ID 池
//       .f6[]                         单元格，按行顺序排列
//         .f1                         行号（0 基；行内首个单元格才带）
//         .f2                         列号（0 基；省略即列 0）
//         .f3.f1                      值类型：2=数字 4=字符串 5=全局值 ID 6=富文本
//         .f3.f2.f1                   值池索引
import { inflateSync } from "zlib";
import { extractImageUrls, imagesMarkdown } from "./images.js";

export interface SheetTab
{
  id: string;
  name: string;
}

export interface SheetTable
{
  title: string;
  tabId: string;
  tabName: string;
  tabs: SheetTab[];
  /** 按原始列号索引的列名，长度 = 最大列号 + 1（含被剔除的全空列，值为空字符串） */
  header: string[];
  /** 实际输出的列号（已剔除全空列），顺序与数据行 cells 一致 */
  columnIndexes: number[];
  headerRowIndex: number;
  preamble: { rowIndex: number; cells: { col: number; value: string }[] }[];
  rows: { rowIndex: number; cells: string[] }[];
  emptyColumnCount: number;
  /** 值的渲染口径说明（表格与智能表格不同，由各自解析器给出） */
  valueNote: string;
  /** 追加到输出头部的补充说明（如跳过的空行数） */
  extraNotes?: string[];
}

export interface SheetRenderOptions
{
  rowStart?: number;
  rowEnd?: number;
  maxRows?: number;
}

// v1.0 - 默认单次输出的最大数据行数，超出部分显式说明省略数量
const DEFAULT_MAX_ROWS = 100;

// v1.0 - protobuf 线格式字段
interface PbField
{
  field: number;
  wire: number;
  value?: number;
  double?: number;
  raw?: Buffer;
}

// v1.0 - 读 varint。用算术累加而不是位移：JS 的位移是 32 位运算，
//        `value |= (b & 0x7f) << s` 会把超过 2^32-1 的整数（手机号、毫秒时间戳等）截断成错误值。
//        超过 2^53 无法精确表示时返回 null：调用方按“该字段无值/结构非法”处理，绝不返回错的数字。
function readVarint(buf: Buffer, cursor: { i: number }): number | null
{
  let value = 0;
  let shift = 0;
  let imprecise = false;
  for (;;)
  {
    if (cursor.i >= buf.length || shift > 63) return null;
    const byte = buf[cursor.i++];
    if (shift <= 49) value += (byte & 0x7f) * 2 ** shift;
    else imprecise = true;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return imprecise ? null : value;
}

// v1.0 - 按线格式拆出字段；结构不合法时返回 null（用于判断是否嵌套消息）
function parseFields(buf: Buffer): PbField[] | null
{
  const fields: PbField[] = [];
  const cursor = { i: 0 };
  while (cursor.i < buf.length)
  {
    const key = readVarint(buf, cursor);
    if (key === null) return null;

    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (field === 0) return null;

    if (wire === 0)
    {
      const value = readVarint(buf, cursor);
      fields.push({ field, wire, value: value ?? undefined });
    }
    else if (wire === 2)
    {
      const len = readVarint(buf, cursor);
      if (len === null || cursor.i + len > buf.length) return null;
      fields.push({ field, wire, raw: buf.subarray(cursor.i, cursor.i + len) });
      cursor.i += len;
    }
    else if (wire === 1)
    {
      // 64 位定长：小数（如 0.3 天）走这里
      if (cursor.i + 8 > buf.length) return null;
      fields.push({ field, wire, double: buf.readDoubleLE(cursor.i) });
      cursor.i += 8;
    }
    else if (wire === 5)
    {
      if (cursor.i + 4 > buf.length) return null;
      cursor.i += 4;
      fields.push({ field, wire });
    }
    else
    {
      return null;
    }
  }
  return fields;
}

// v1.0 - 取第一个长度为 len 的字段的原始内容
function rawOf(fields: PbField[] | null, field: number): Buffer | null
{
  if (!fields) return null;
  const hit = fields.find((f) => f.field === field && f.wire === 2);
  return hit && hit.raw ? hit.raw : null;
}

// v1.0 - 取嵌套消息里的第一个整数字段
function varintOf(fields: PbField[] | null, field: number): number | null
{
  if (!fields) return null;
  const hit = fields.find((f) => f.field === field && f.wire === 0);
  return hit && typeof hit.value === "number" ? hit.value : null;
}

// v1.0 - 取嵌套消息里的第一个 64 位小数
function doubleOf(fields: PbField[] | null, field: number): number | null
{
  if (!fields) return null;
  const hit = fields.find((f) => f.field === field && f.wire === 1);
  return hit && typeof hit.double === "number" ? hit.double : null;
}

// v1.0 - 判断是否为可直接当文本使用的 UTF-8（排除含控制字符的样式二进制）
function isPlainText(buf: Buffer): boolean
{
  if (buf.length === 0) return false;
  let text: string;
  try
  {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  }
  catch
  {
    return false;
  }
  for (const ch of text)
  {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    if (isControl || code === 0x7f) return false;
  }
  return true;
}

// v1.0 - 富文本 run：文本在 f3；f3 可能是纯文本，也可能是只含一个 f1 字符串的消息。
//        必须先按结构判断是否为该消息，否则嵌套消息的头部字节会被当成 UTF-8 文本解码出乱码。
function richRunText(run: Buffer): string
{
  const fields = parseFields(run);
  const payload = rawOf(fields, 3);
  if (!payload) return "";

  const nested = parseFields(payload);
  if (nested && nested.length === 1 && nested[0].field === 1 && nested[0].wire === 2 && nested[0].raw)
  {
    return isPlainText(nested[0].raw) ? nested[0].raw.toString("utf-8") : "";
  }
  return isPlainText(payload) ? payload.toString("utf-8") : "";
}

interface SheetPools
{
  strings: string[];
  richText: Buffer[];
  numbers: number[];
  globalIds: number[];
}

interface RawCell
{
  row: number;
  col: number;
  type: number | null;
  index: number | null;
  /** 图片单元格：f3.f17 里的 ["URL",宽,高]，可能有多张 */
  imageUrls: string[];
}

// v1.0 - 解值池
function readPools(f19: PbField[]): SheetPools
{
  const poolRaw = rawOf(f19, 5);
  const poolFields = parseFields(poolRaw ?? Buffer.alloc(0)) ?? [];

  const strings: string[] = [];
  const richText: Buffer[] = [];
  const numbers: number[] = [];
  const globalIds: number[] = [];

  for (const f of poolFields)
  {
    if (f.wire !== 2 || !f.raw) continue;
    if (f.field === 1)
    {
      const inner = rawOf(parseFields(f.raw), 1);
      strings.push(inner && isPlainText(inner) ? inner.toString("utf-8") : "");
    }
    else if (f.field === 2)
    {
      richText.push(f.raw);
    }
    else if (f.field === 3)
    {
      // 数字池：整数走 varint，小数走 64 位定长；条目与池位置一一对应，不能跳过
      const entry = parseFields(f.raw);
      numbers.push(varintOf(entry, 1) ?? doubleOf(entry, 1) ?? Number.NaN);
    }
    else if (f.field === 4)
    {
      // 条目形如 {f1{f1:2, f3{ID}}, f3{标签}}，ID 在内层 f1.f3；按 protobuf 语义省略即 0
      const head = rawOf(parseFields(f.raw), 1);
      const headFields = head === null ? null : parseFields(head);
      if (headFields === null)
      {
        globalIds.push(-1); // 结构不合法，标记为无值而不是伪造 0
        continue;
      }
      const idPayload = rawOf(headFields, 3);
      globalIds.push(idPayload === null ? 0 : varintOf(parseFields(idPayload), 1) ?? 0);
    }
  }
  return { strings, richText, numbers, globalIds };
}

// v1.0 - 解单元格列表。
//        行内首个出现且不带 f2 的单元格即列 0：空单元格同样会写出 f6 条目（本表 871 行对应 871 个列 0 条目），
//        所以“首个条目 = 列 0”这一假设成立；若某天该假设不成立，表现为每行首列整体错位，需重新核对。
function readCells(f19: PbField[]): RawCell[]
{
  const cells: RawCell[] = [];
  let currentRow = 0;
  for (const f of f19)
  {
    if (f.field !== 6 || f.wire !== 2 || !f.raw) continue;
    const fields = parseFields(f.raw);
    const rowField = varintOf(fields, 1);
    const colField = varintOf(fields, 2);
    if (rowField !== null) currentRow = rowField;

    const typeField = rawOf(fields, 3);
    const typeFields = parseFields(typeField ?? Buffer.alloc(0));
    const listField = rawOf(typeFields, 2);
    // v1.2 - 图片单元格的 URL 在 f3.f17 的 ["URL",宽,高] 里；
    //        直接从整个 f3 里提取，兼容 inlineKeyword 之外的图片结构。
    const imageUrls = typeField ? extractImageUrls(typeField.toString("utf-8")) : [];
    // protobuf 省略字段即默认值 0：f3.f2 存在但为空表示池索引 0；完全没有 f3.f2 才是无值
    const index = listField === null ? null : varintOf(parseFields(listField), 1) ?? 0;
    cells.push({
      row: currentRow,
      col: colField ?? 0,
      type: varintOf(typeFields, 1),
      index,
      imageUrls,
    });
  }
  return cells;
}

// v1.0 - 解析表格；data 为 /dop-api/opendoc 的响应体
export function decodeSheet(data: unknown, tabId?: string): SheetTable
{
  const body = (data ?? {}) as { padType?: string; clientVars?: Record<string, unknown> };
  if (typeof body !== "object") throw new Error("表格响应格式不是对象，无法解析");
  const clientVars = body.clientVars ?? {};
  const collab = (clientVars["collab_client_vars"] ?? {}) as Record<string, unknown>;
  const textSlots = ((collab["initialAttributedText"] as Record<string, unknown> | undefined)?.["text"] ?? []) as Record<string, unknown>[];
  const slot = textSlots[0] ?? {};

  const tabs = readTabs(collab, clientVars);
  const targetId = tabId || (typeof collab["padSubId"] === "string" ? collab["padSubId"] : "") || tabs[0]?.id || "";

  const related = typeof slot["related_sheet"] === "string" ? slot["related_sheet"] : "";
  if (!related) throw new Error(`表格响应里没有 related_sheet 数据（文档类型 ${body.padType ?? "未知"}）`);

  const rootFields = parseFields(inflateSync(Buffer.from(related, "base64"))) ?? [];
  const inner = parseFields(rawOf(rootFields, 1) ?? Buffer.alloc(0)) ?? [];

  let table: SheetTable | null = null;
  for (const block of inner)
  {
    if (block.field !== 5 || block.wire !== 2 || !block.raw) continue;
    const f19 = parseFields(rawOf(parseFields(block.raw) ?? [], 19) ?? Buffer.alloc(0));
    if (!f19) continue;
    const blockSheetId = (() =>
    {
      const idField = rawOf(parseFields(rawOf(f19, 3) ?? Buffer.alloc(0)), 1);
      return idField && isPlainText(idField) ? idField.toString("utf-8") : "";
    })();
    if (!blockSheetId) continue;
    if (targetId && blockSheetId !== targetId) continue;
    table = buildTable(f19, blockSheetId, tabs, String(clientVars["padTitle"] ?? ""));
    break;
  }

  if (!table) throw new Error(`未在响应中找到工作表 ${targetId || "(未指定)"} 的数据（文档类型 ${body.padType ?? "未知"}）`);
  return table;
}

// v1.0 - 读取工作表清单（响应头里的 header 字段为 JSON 字符串数组）
function readTabs(collab: Record<string, unknown>, clientVars: Record<string, unknown>): SheetTab[]
{
  const candidates: unknown[] = [collab["header"], clientVars["header"]];
  for (const candidate of candidates)
  {
    const list = Array.isArray(candidate) ? candidate : [];
    for (const item of list)
    {
      const group = Array.isArray((item as Record<string, unknown>)?.["d"])
        ? ((item as Record<string, unknown>)["d"] as Record<string, unknown>[])
        : [];
      const tabs = group
        .filter((t) => typeof t?.["id"] === "string")
        .map((t) => ({ id: String(t["id"]), name: String(t["name"] ?? "") }));
      if (tabs.length) return tabs;
    }
  }
  return [];
}

// v1.0 - 由 f19 构建行列网格
function buildTable(f19: PbField[], sheetId: string, tabs: SheetTab[], title: string): SheetTable
{
  const pools = readPools(f19);
  const cells = readCells(f19);

  // 数字池按“全局值 ID”寻址：池内位置 p 对应 ID p + base。
  // base 由该表出现过的最大数值 ID（仅 type=2/5）与池长度推得（本表为 129，即前 129 个 ID 的值不在池内）。
  // 若推得负值（说明 ID 与池长度不满足该关系），退回按位置直取，避免整体偏移。
  let maxNumericId = 0;
  for (const cell of cells)
  {
    if (cell.index === null || cell.index === undefined || cell.index < 0) continue;
    let id: number | undefined;
    if (cell.type === 2) id = cell.index;
    else if (cell.type === 5) id = pools.globalIds[cell.index];
    if (id !== undefined && id > maxNumericId) maxNumericId = id;
  }
  const numericBase = pools.numbers.length > 0 ? Math.max(0, maxNumericId - pools.numbers.length + 1) : 0;

  const resolveNumeric = (id: number): string =>
  {
    if (id < numericBase) return String(id);
    const v = pools.numbers[id - numericBase];
    if (v === undefined || Number.isNaN(v)) return String(id);
    return String(v);
  };

  const grid = new Map<number, Map<number, string>>();
  let maxCol = 0;
  for (const cell of cells)
  {
    let value = "";
    // v1.2 - 图片单元格优先按图片输出，不再当成空字符串
    if (cell.imageUrls.length > 0)
    {
      value = imagesMarkdown(cell.imageUrls);
    }
    else if (cell.index !== null && cell.index !== undefined && cell.index >= 0)
    {
      if (cell.type === 4) value = pools.strings[cell.index] ?? "";
      else if (cell.type === 2) value = resolveNumeric(cell.index);
      else if (cell.type === 5)
      {
        const id = pools.globalIds[cell.index];
        value = id === undefined || id < 0 ? "" : resolveNumeric(id);
      }
      else if (cell.type === 6)
      {
        const runs = parseFields(pools.richText[cell.index] ?? Buffer.alloc(0)) ?? [];
        value = runs.map((r) => (r.raw ? richRunText(r.raw) : "")).join("").trim();
      }
    }
    if (!grid.has(cell.row)) grid.set(cell.row, new Map());
    if (value !== "") grid.get(cell.row)!.set(cell.col, value);
    if (cell.col > maxCol) maxCol = cell.col;
  }

  const rowIndexes = [...grid.keys()].sort((a, b) => a - b);
  const headerRowIndex = detectHeaderRow(grid, rowIndexes, maxCol);

  const header: string[] = [];
  for (let col = 0; col <= maxCol; col++)
  {
    header.push(grid.get(headerRowIndex)?.get(col) ?? "");
  }

  // 全空列（无表头也无任何单元格值）直接剔除，不影响信息量
  const emptyCols: number[] = [];
  for (let col = 0; col <= maxCol; col++)
  {
    const hasValue = rowIndexes.some((r) => grid.get(r)?.has(col));
    if (!hasValue && !header[col]) emptyCols.push(col);
  }
  const keepCols: number[] = [];
  for (let col = 0; col <= maxCol; col++)
  {
    if (!emptyCols.includes(col)) keepCols.push(col);
  }

  const contentRows = rowIndexes.filter((r) => (grid.get(r)?.size ?? 0) > 0);
  const lastContentRow = contentRows[contentRows.length - 1] ?? headerRowIndex;

  const preamble = rowIndexes
    .filter((r) => r < headerRowIndex)
    .map((r) => ({
      rowIndex: r,
      cells: [...(grid.get(r)?.entries() ?? [])]
        .sort((a, b) => a[0] - b[0])
        .map(([col, value]) => ({ col, value })),
    }))
    .filter((p) => p.cells.length > 0);

  // 数据行取表头之后到最后一个有内容的行，尾部纯空行不进入行号计数
  const rows = rowIndexes
    .filter((r) => r > headerRowIndex && r <= lastContentRow)
    .map((r) => ({ rowIndex: r, cells: keepCols.map((col) => grid.get(r)?.get(col) ?? "") }));

  return {
    title,
    tabId: sheetId,
    tabName: tabs.find((t) => t.id === sheetId)?.name ?? "",
    tabs,
    header,
    columnIndexes: keepCols,
    headerRowIndex,
    preamble,
    rows,
    emptyColumnCount: emptyCols.length,
    valueNote: "数值列按原始值输出；日期类字段为 Excel 日期序列号（1900 起算，如 46303 = 2026-10-08）；图片单元格输出为 Markdown 图片链接",
  };
}

// v1.0 - 表头行取前若干行内“填充列数达到半数”的首行，取不到时退回首行
function detectHeaderRow(grid: Map<number, Map<number, string>>, rowIndexes: number[], maxCol: number): number
{
  const threshold = Math.ceil((maxCol + 1) / 2);
  for (const row of rowIndexes.slice(0, 20))
  {
    if ((grid.get(row)?.size ?? 0) >= threshold) return row;
  }
  return rowIndexes[0] ?? 0;
}

// v1.0 - 渲染为 Markdown；超出 maxRows 的行会说明省略数量，不做静默截断
export function renderSheetMarkdown(table: SheetTable, options: SheetRenderOptions = {}): string
{
  const total = table.rows.length;
  const notes: string[] = [];

  let start = Math.floor(options.rowStart ?? 1);
  let end = Math.floor(options.rowEnd ?? total);
  if (!Number.isFinite(start))
  {
    notes.push(`rowStart=${options.rowStart} 不是有效数字，已按第 1 行处理`);
    start = 1;
  }
  if (!Number.isFinite(end))
  {
    notes.push(`rowEnd=${options.rowEnd} 不是有效数字，已按最后一行处理`);
    end = total;
  }
  if (start < 1)
  {
    notes.push(`rowStart=${start} 小于 1，已按第 1 行处理`);
    start = 1;
  }
  if (end > total)
  {
    notes.push(`rowEnd=${options.rowEnd} 超出数据行数（共 ${total} 行），已按第 ${total} 行处理`);
    end = total;
  }
  if (start > total)
  {
    notes.push(`rowStart=${options.rowStart} 超出数据行数（共 ${total} 行）`);
  }
  if (end < start)
  {
    notes.push(`rowEnd(${end}) 小于 rowStart(${start})，区间为空`);
  }

  const requested = Math.max(0, end - start + 1);
  const maxRows = options.maxRows && options.maxRows > 0 ? Math.floor(options.maxRows) : DEFAULT_MAX_ROWS;
  const shownCount = Math.min(requested, maxRows);
  const shown = shownCount > 0 ? table.rows.slice(start - 1, start - 1 + shownCount) : [];

  const lines: string[] = [];
  lines.push(`# ${table.title || "企业微信表格"}`);
  lines.push("");
  lines.push(`- 工作表：${table.tabName || table.tabId}（${table.tabId}）`);
  if (table.tabs.length > 1)
  {
    lines.push(`- 其他工作表：${table.tabs.filter((t) => t.id !== table.tabId).map((t) => `${t.name}（${t.id}）`).join("、")}`);
  }
  lines.push(`- 数据行数：${total}（不含表头，表头为第 ${table.headerRowIndex} 行，0 基）`);
  if (shownCount > 0)
  {
    lines.push(`- 本次输出：第 ${start}-${start + shownCount - 1} 行（1 基，不含表头）`);
  }
  if (shownCount < requested)
  {
    lines.push(`- 已省略 ${requested - shownCount} 行：单次输出上限 ${maxRows} 行，可用 rowStart/rowEnd 分段获取`);
  }
  if (table.emptyColumnCount > 0)
  {
    lines.push(`- 已忽略 ${table.emptyColumnCount} 个全空列`);
  }
  lines.push(`- ${table.valueNote}`);
  for (const extra of table.extraNotes ?? [])
  {
    lines.push(`- ${extra}`);
  }
  for (const note of notes)
  {
    lines.push(`- 参数提示：${note}`);
  }
  lines.push("");

  if (table.preamble.length > 0)
  {
    lines.push("## 表头之前的行（模板标题或选项定义，非数据行）");
    for (const p of table.preamble)
    {
      const parts = p.cells.map(({ col, value }) =>
      {
        const name = table.header[col] ? table.header[col] : `第${col}列`;
        return `${name}=${value}`;
      });
      lines.push(`- 第 ${p.rowIndex} 行（0 基）：${parts.join("；")}`);
    }
    lines.push("");
  }

  lines.push("## 数据");
  lines.push("");
  if (shown.length === 0)
  {
    lines.push(`（没有可输出的数据行，共 ${total} 行数据）`);
    return lines.join("\n");
  }

  const escape = (text: string): string => text.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
  // 列名与列号都按原始列号取值，剔除全空列后不会串列
  const headerCells = table.columnIndexes.map((col) => escape(table.header[col] || `第${col}列（无表头）`));
  lines.push(`| ${headerCells.join(" | ")} |`);
  lines.push(`| ${table.columnIndexes.map(() => "---").join(" | ")} |`);
  for (const row of shown)
  {
    lines.push(`| ${row.cells.map((c) => escape(c)).join(" | ")} |`);
  }
  return lines.join("\n");
}
