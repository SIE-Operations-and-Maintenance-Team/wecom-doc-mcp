// 文件名: images.ts
// 创建版本: v1.0
// 引入版本: index.ts v1.4 / sheet.ts v1.2 / smartsheet.ts v1.1 / mind.ts v1.1
// 说明: 企业微信文档各类型共用的图片提取与 Markdown 渲染。
//       图片地址在不同类型里的落点不同：
//         doc        mutations[].pr.drawing...blip.embed
//         sheet      单元格 f3.f17 里的 ["URL",宽,高]
//         smartsheet 单元格值中的图片 URL
//         mind       节点标题或节点属性中的图片 URL
//       这里只负责识别 URL、去重和转义，具体从哪里取图由各解析器决定。

// v1.0 - 图片地址识别：企业微信图片 CDN、常见图片扩展名，以及显式的图片路径
const IMAGE_URL_PATTERN = /https?:\/\/[^\s"'<>\\]+/g;
const IMAGE_PATH_PATTERN = /\/(?:image|images)\//i;
const IMAGE_EXT_PATTERN = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i;

// v1.0 - 判断一个 URL 是否应按图片渲染。
//        只认图片 CDN 或明确带图片扩展名/图片路径的地址，避免把普通网页链接误判成图片。
export function isImageUrl(url: string): boolean
{
  let parsed: URL;
  try
  {
    parsed = new URL(url.trim());
  }
  catch
  {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const host = parsed.hostname.toLowerCase();
  // XML/办公文档命名空间不是图片，避免把 drawing 里的 schema URI 当成图片
  if (/(?:^|\.)(?:openxmlformats\.org|microsoft\.com|w3\.org)$/.test(host)) return false;
  if (host === "qpic.cn" || host.endsWith(".qpic.cn") || host === "qlogo.cn" || host.endsWith(".qlogo.cn"))
  {
    return true;
  }
  return IMAGE_EXT_PATTERN.test(parsed.pathname) || IMAGE_PATH_PATTERN.test(parsed.pathname);
}

// v1.0 - 从任意字符串/对象里提取图片 URL。
//        - 字符串：匹配所有 http(s) 地址，再按 isImageUrl 过滤；
//        - 数组/对象：递归遍历，深度受限，避免异常数据拖垮解析；
//        - 结果按首次出现顺序去重。
export function extractImageUrls(value: unknown, maxDepth = 12): string[]
{
  const urls: string[] = [];
  const seen = new Set<string>();

  const add = (raw: string): void =>
  {
    // 去掉 URL 末尾可能粘上的 JSON/引号/括号；成对的 ")" 属于 URL 本身，保留
    let url = raw.replace(/[",\]}]+$/g, "");
    const open = (url.match(/\(/g) ?? []).length;
    let close = (url.match(/\)/g) ?? []).length;
    while (close > open && url.endsWith(")"))
    {
      url = url.slice(0, -1);
      close--;
    }
    if (!isImageUrl(url) || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };

  const walk = (node: unknown, depth: number): void =>
  {
    if (depth > maxDepth || node === null || node === undefined) return;

    if (typeof node === "string")
    {
      for (const match of node.matchAll(IMAGE_URL_PATTERN)) add(match[0]);
      return;
    }

    if (Array.isArray(node))
    {
      for (const item of node) walk(item, depth + 1);
      return;
    }

    if (typeof node === "object")
    {
      for (const item of Object.values(node)) walk(item, depth + 1);
    }
  };

  walk(value, 0);
  return urls;
}

// v1.0 - 生成 Markdown 图片语法。
//        URL 里的 ")" 和 "|" 会破坏 Markdown 链接/表格，按百分号编码处理；
//        alt 里的方括号同样需要清掉。
export function imageMarkdown(url: string, alt = "图片"): string
{
  const safeUrl = url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\|/g, "%7C");
  const safeAlt = alt.replace(/[[\]]/g, "");
  return `![${safeAlt}](${safeUrl})`;
}

// v1.0 - 批量渲染图片，多个图片用换行分隔（表格里会被渲染器转成 <br>）
export function imagesMarkdown(urls: string[], alt = "图片"): string
{
  return urls.map((url) => imageMarkdown(url, alt)).join("\n");
}
