import { unified } from "unified";
import remarkParse from "remark-parse";
import { splitMarkdownFrontmatter } from "./markdown";
import { literalMarkdown } from "./chatCitations";

export function singleLineTasks(tasks: readonly string[]): string[] | undefined {
  if (!tasks.length || tasks.length > 24) return;
  const flat = tasks.map(text => text.replace(/\s+/gu, " ").trim());
  if (flat.every(text => text.length > 0 && text.length <= 300)) return flat;
}

export function addReadingArtifactTasks(body: string, marker: string, occurrence: number, tasks: readonly string[]) {
  const normalized = singleLineTasks(tasks);
  if (!normalized) return;
  const { prefix, content } = splitMarkdownFrontmatter(body);
  const nodes = unified().use(remarkParse).parse(content).children;
  const node = nodes.filter(node => node.type === "html" && node.value === marker)[occurrence];
  const end = node?.position?.end.offset;
  if (end === undefined) return;
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const checklist = normalized.map(text => "- [ ] " + literalMarkdown(text)).join(newline);
  return prefix + content.slice(0, end) + newline + newline + checklist + content.slice(end);
}
