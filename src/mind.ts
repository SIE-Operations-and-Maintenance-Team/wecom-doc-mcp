// 文件名: mind.ts
// 创建版本: v1.0
// 最后更新: v1.1
// 改动历史:
//   v1.0 (2026-10-16): 初版，脑图渲染从 index.ts 抽出
//   v1.1 (2026-10-19): 节点标题/属性中的图片输出为 Markdown 图片链接
// 引入版本: index.ts v1.4（脑图渲染从 index.ts 抽出，便于单测）
// 说明: 企业微信脑图(mind)的树形节点渲染。节点结构实测为
//       rootTopic { title, children: { attached: [...] } }，
//       其中 title 可能是字符串，也可能是 { text } 对象。

import { extractImageUrls, imagesMarkdown } from "./images.js";

interface MindNode
{
  title?: unknown;
  children?: Record<string, unknown>;
  [key: string]: unknown;
}

// v1.1 - 取节点标题；标题对象只有图片时用 (图片) 占位，不再输出 [object Object]
function nodeTitle(node: MindNode | undefined): string
{
  const t = node?.title;
  if (!t) return "(空)";
  if (typeof t === "string") return t.trim() || "(空)";
  if (typeof t === "object")
  {
    const text = (t as { text?: unknown }).text;
    const trimmed = text === undefined ? "" : String(text).trim();
    if (trimmed !== "") return trimmed;
    if (extractImageUrls(t).length > 0) return "(图片)";
    return "(空)";
  }
  // 数字/布尔等原始类型保留可读值，避免回退成 (空)
  return String(t).trim() || "(空)";
}

// v1.1 - 取当前节点自身的图片，排除 children，避免把子节点的图片重复挂到父节点
function nodeImages(node: MindNode): string[]
{
  const own: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node))
  {
    if (key !== "children") own[key] = value;
  }
  return extractImageUrls(own);
}

// v1.0 - 递归渲染为 Markdown 层级
function renderNode(node: MindNode, depth: number): string[]
{
  const lines: string[] = [];
  const title = nodeTitle(node);
  const imageUrls = nodeImages(node);
  const imageText = imageUrls.length > 0 ? ` ${imagesMarkdown(imageUrls)}` : "";
  if (depth === 0) lines.push(`# ${title}${imageText}\n`);
  else if (depth === 1) lines.push(`## ${title}${imageText}\n`);
  else if (depth === 2) lines.push(`### ${title}${imageText}\n`);
  else lines.push(`${"  ".repeat(depth - 3)}- ${title}${imageText}`);

  const attached = Array.isArray(node?.children?.["attached"]) ? (node.children!["attached"] as MindNode[]) : [];
  for (const child of attached)
  {
    lines.push(...renderNode(child ?? {}, depth + 1));
  }

  // 只渲染 attached；其余子主题容器（如浮动主题 detached）明确标注数量，不让内容无声消失
  const others = Object.keys(node?.children ?? {}).filter((k) => k !== "attached");
  for (const key of others)
  {
    const value = node.children![key];
    if (Array.isArray(value) && value.length > 0)
    {
      lines.push(`${"  ".repeat(Math.max(0, depth - 3))}- （未渲染的子主题容器 ${key}：${value.length} 个）`);
    }
  }
  return lines;
}

// v1.0 - 渲染整棵脑图
export function renderMindTree(root: MindNode | undefined): string
{
  return renderNode(root ?? {}, 0).join("\n");
}
