import { normalizeExternalLink } from "./externalLinks";
import { serializeFencedCode, serializeInlineCode } from "./noteCodeSerialization";

const MAX_HTML_LENGTH = 16 * 1024 * 1024;
const MAX_NODES = 100_000;
const MAX_DEPTH = 128;
const MAX_OUTPUT_LENGTH = 16 * 1024 * 1024;
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE", "BASE", "LINK", "META"]);
const MEDIA = new Set(["IMG", "SVG", "CANVAS", "IFRAME", "OBJECT", "EMBED", "VIDEO", "AUDIO", "SOURCE", "TRACK"]);
const BLOCK = /^(?:ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DETAILS|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|SUMMARY|TABLE|UL)$/;

const WARNINGS = {
  links: "Only explicit HTTP(S) links were kept. Other link labels remain as text.",
  media: "Images and embedded media were not imported; available descriptions and fallback text were kept.",
  table: "Complex tables were simplified to readable text; merged cells and table layout were not retained.",
  appearance: "HTML styling and interactive behavior were not imported.",
  lists: "Custom list numbering was simplified to ordinary sequential numbering.",
  structure: "Some irregular HTML structures were simplified while keeping their readable text.",
};

/** Extract semantic Markdown, never attach imported nodes or resolve resource URLs.
 * Template contents have an inert owner document without a browsing context;
 * DOMParser's HTML document can still fetch img/iframe resources in some browsers.
 * The returned text is the complete extracted source, not an archive of raw HTML.
 */
export function htmlToMarkdown(html: string, profile: "html" | "word" = "html"): { title: string; text: string; warnings: string[] } {
  if (html.length > MAX_HTML_LENGTH) throw new Error("This HTML document is too large to import safely (16 million text units maximum).");
  if (typeof document === "undefined") throw new Error("HTML import requires the document parser available in Orion.");
  const template = document.createElement("template");
  template.innerHTML = html;
  const root = template.content;
  // Check the entire tree before extracting anything, including ignored templates.
  const pending: Array<{ node: Node; depth: number; indent: number; pre: boolean }> = [{ node: root, depth: 0, indent: 0, pre: false }];
  let count = 0;
  let projectedIndentation = 0;
  while (pending.length) {
    const { node, depth, indent, pre } = pending.pop()!;
    if (++count > MAX_NODES || depth > MAX_DEPTH) throw new Error("This HTML document is too complex to import safely. Simplify its nesting or split it into smaller documents.");
    const tag = node.nodeType === 1 ? (node as Element).tagName : "";
    if (pre && node.nodeType === 3) {
      const text = node.textContent ?? "";
      for (let index = 0; index < text.length; index += 1) if (text[index] === "\n") projectedIndentation += indent;
    } else if (tag === "BR") projectedIndentation += indent;
    if (projectedIndentation > MAX_OUTPUT_LENGTH) throw new Error("This HTML document produces too much formatted text to import safely. Simplify its structure or split it into smaller documents.");
    // Conservatively reserve the widest portable list marker before any nested
    // preformatted text is repeatedly indented during conversion.
    for (const child of node.childNodes) pending.push({ node: child, depth: depth + 1, indent: indent + (tag === "LI" ? 12 : tag === "BLOCKQUOTE" ? 2 : 0), pre: pre || tag === "PRE" });
    if (tag === "TEMPLATE") {
      pending.push({ node: (node as HTMLTemplateElement).content, depth: depth + 1, indent, pre });
    }
  }
  const warnings = new Set<string>();
  const warn = (kind: keyof typeof WARNINGS) => warnings.add(kind === "links" && profile === "word"
    ? "Only explicit HTTP(S) and mailto links were kept. Other link labels remain as text."
    : WARNINGS[kind]);
  const checkSize = (length: number) => {
    if (length > MAX_OUTPUT_LENGTH) throw new Error("This HTML document produces too much formatted text to import safely. Simplify its structure or split it into smaller documents.");
  };
  const join = (pieces: string[], separator: string) => {
    checkSize(pieces.reduce((total, piece) => total + piece.length, Math.max(0, pieces.length - 1) * separator.length));
    return pieces.join(separator);
  };
  const title = root.querySelector("title")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/([\\`*_{}\[\]<>#!|~+=\-])/g, "\\$1").replace(/(\d)\.(?=\s)/g, "$1\\.");
  const normal = (text: string) => escape(text.replace(/[\t\n\r\f ]+/g, " "));
  const markFor = (tag: string): string => /^(?:STRONG|B)$/.test(tag) ? "**" : /^(?:EM|I)$/.test(tag) ? "*" : /^(?:DEL|S|STRIKE)$/.test(tag) ? "~~" : "";
  const children = (node: Node, omit?: Node, active: readonly string[] = []) => inlines(node.childNodes, omit, active);
  function inlines(nodes: Iterable<Node>, omit?: Node, active: readonly string[] = []): string {
    let result = "";
    let previous = "";
    for (const child of nodes) {
      if (child === omit) continue;
      const mark = child.nodeType === 1 ? markFor((child as Element).tagName) : "";
      const value = inline(child, omit, active);
      checkSize(result.length + value.length);
      if (mark && mark === previous && !active.includes(mark) && result.endsWith(mark) && value.startsWith(mark)) result = result.slice(0, -mark.length) + value.slice(mark.length);
      else result += value;
      previous = mark;
    }
    return result;
  }
  const marked = (value: string, delimiter: string): string => value.trim()
    ? value.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_, before: string, text: string, after: string) => `${before}${delimiter}${text}${delimiter}${after}`) : value;
  const wordText = new Map<Node, string>();
  const wordOmissions = new Set<Node>();
  function wordTask(element: Element): { node: Node; text?: string; checked: boolean } | undefined {
    if (profile !== "word" || element.closest("table, pre, code")) return undefined;
    const pending = [...element.childNodes].reverse();
    while (pending.length) {
      const node = pending.pop()!;
      if (node.nodeType === 3) {
        const value = node.textContent ?? "";
        if (!value.trim()) continue;
        const glyph = value.match(/^\s*([☐☑☒])\s*/);
        return glyph ? { node, text: value.slice(glyph[0].length), checked: glyph[1] !== "☐" } : undefined;
      }
      if (node.nodeType !== 1) continue;
      const tag = (node as Element).tagName;
      if (SKIP.has(tag) || tag === "BR") continue;
      if (tag === "INPUT") return (node as Element).getAttribute("type")?.toLowerCase() === "checkbox"
        ? { node, checked: (node as Element).hasAttribute("checked") } : undefined;
      // A descendant list's first marker belongs to that list, never its parent.
      // Code, media and table contents are reference text, not glyph tasks.
      if (/^(?:UL|OL|TABLE|PRE|CODE|KBD|SAMP|BLOCKQUOTE|H[1-6])$/.test(tag) || MEDIA.has(tag)) return undefined;
      pending.push(...[...node.childNodes].reverse());
    }
    return undefined;
  }
  function taskContent(element: Element, task: ReturnType<typeof wordTask>, omit?: Node): string {
    if (!task) return blocks(element, omit);
    if (task.text === undefined) wordOmissions.add(task.node);
    else wordText.set(task.node, task.text);
    try { return blocks(element, omit); }
    finally { wordText.delete(task.node); wordOmissions.delete(task.node); }
  }

  function rawText(node: Node): string {
    if (node.nodeType === 3) return node.textContent ?? "";
    if (node.nodeType !== 1) return "";
    const tag = (node as Element).tagName;
    if (SKIP.has(tag) || MEDIA.has(tag)) return "";
    if (tag === "BR") return "\n";
    return Array.from(node.childNodes).map(rawText).join("");
  }

  function inline(node: Node, omit?: Node, active: readonly string[] = []): string {
    if (node === omit || wordOmissions.has(node)) return "";
    if (node.nodeType === 3) return normal(wordText.get(node) ?? node.textContent ?? "");
    if (node.nodeType !== 1) return "";
    const element = node as Element;
    const tag = element.tagName;
    if (element.hasAttribute("style") || tag === "SCRIPT" || tag === "STYLE" || tag === "FORM" || tag === "BUTTON") warn("appearance");
    if (SKIP.has(tag)) return "";
    if (BLOCK.test(tag)) return `\n\n${block(element, omit)}\n\n`;
    if (MEDIA.has(tag)) {
      warn("media");
      if (tag === "IMG") return escape(element.getAttribute("alt") ? `[Image: ${element.getAttribute("alt")}]` : "[Image]");
      if (tag === "SVG") return normal(element.querySelector("title, desc")?.textContent ?? "");
      return /^(?:OBJECT|CANVAS|VIDEO|AUDIO)$/.test(tag) ? blocks(element) : "";
    }
    if (tag === "BR") return "  \n";
    if (tag === "INPUT") {
      if (element.getAttribute("type")?.toLowerCase() === "checkbox") return element.hasAttribute("checked") ? "☑ " : "☐ ";
      warn("appearance"); return "";
    }
    if (tag === "CODE" || tag === "KBD" || tag === "SAMP") {
      const text = rawText(element).replace(/[\r\n]+/g, " ");
      if (!text) return "";
      const inTable = Boolean(element.closest("table"));
      return serializeInlineCode(text, inTable);
    }
    const mark = markFor(tag);
    const value = children(element, omit, mark ? [...active, mark] : active);
    if ((mark || tag === "A") && value.includes("\n\n")) { warn("structure"); return value; }
    if (mark) return active.includes(mark) ? value : marked(value, mark);
    if (tag === "A") {
      const href = element.getAttribute("href") ?? "";
      let safe = /^https?:\/\//i.test(href.trim()) ? normalizeExternalLink(href) : null;
      if (!safe && profile === "word" && /^mailto:/i.test(href.trim())
        && href.trim().length <= 2_048 && !/[\u0000-\u0020\u007f\\]/.test(href.trim())) {
        try { const url = new URL(href.trim()); if (url.protocol === "mailto:" && !url.username && !url.password) safe = url.href; }
        catch { /* Keep the visible label of a malformed address. */ }
      }
      if (safe && value.trim()) return `[${value}](<${safe.replace(/[<>|]/g, (character) => encodeURIComponent(character))}>)`;
      if (href) warn("links");
    }
    return value;
  }

  function list(element: Element): string {
    const items = Array.from(element.children).filter((child) => child.tagName === "LI");
    const start = element.getAttribute("start") ?? "1";
    let number = /^\d{1,9}$/.test(start) ? Number(start) : 1;
    if (element.hasAttribute("reversed") || !/^\d{1,9}$/.test(start) || items.some((item) => item.hasAttribute("value"))) warn("lists");
    if (number + items.length - 1 > 999_999_999) { number = 1; warn("lists"); }
    const renderItem = (item: Element) => {
      const wordLeading = wordTask(item);
      const checkbox = profile === "word"
        ? wordLeading?.node.nodeType === 1 ? wordLeading.node as Element : undefined
        : Array.from(item.querySelectorAll('input[type="checkbox" i]')).find((input) => input.closest("li") === item);
      // A checkbox is a task marker only when it precedes the item's prose.
      const prefix = checkbox ? (() => { const range = root.ownerDocument.createRange(); range.selectNodeContents(item); range.setEndBefore(checkbox); return range.toString().trim(); })() : "";
      const task = checkbox && !prefix ? checkbox : undefined;
      const glyph = task ? undefined : wordLeading;
      const marker = task || glyph ? `- [${task ? task.hasAttribute("checked") ? "x" : " " : glyph?.checked ? "x" : " "}] ` : element.tagName === "OL" ? `${number++}. ` : "- ";
      const value = taskContent(item, glyph, task);
      let lines = 0;
      for (let index = 0; index < value.length; index += 1) if (value[index] === "\n") lines += 1;
      checkSize(value.length + lines * marker.length + marker.length);
      return `${marker}${value.replace(/\n/g, `\n${" ".repeat(marker.length)}`)}`;
    };
    const pieces: string[] = [];
    let run: string[] = [];
    const flush = () => { if (run.length) pieces.push(join(run, "\n")); run = []; };
    for (const node of element.childNodes) {
      if (node.nodeType === 1 && (node as Element).tagName === "LI") run.push(renderItem(node as Element));
      else {
        const text = inline(node).trim();
        if (text) { flush(); warn("structure"); pieces.push(text); }
      }
    }
    flush();
    return join(pieces, "\n\n");
  }

  function table(element: Element): string {
    const rows = Array.from(element.querySelectorAll("tr")).filter((row) => row.closest("table") === element);
    const cells = rows.map((row) => Array.from(row.children).filter((cell) => cell.tagName === "TD" || cell.tagName === "TH"));
    const width = cells[0]?.length ?? 0;
    const hasHeader = cells[0]?.every((cell) => cell.tagName === "TH") ?? false;
    const wordHeaderRows = profile === "word" && hasHeader && cells.every((row) =>
      row.every((cell) => cell.tagName === "TH") || row.every((cell) => cell.tagName === "TD"));
    const simple = width > 0 && width <= 100 && cells.every((row) => row.length === width && row.every((cell) =>
      !cell.querySelector("table, ul, ol, pre, blockquote, h1, h2, h3, h4, h5, h6, hr") && ["colspan", "rowspan"].every((attribute) => !cell.hasAttribute(attribute) || cell.getAttribute(attribute) === "1")))
      && (wordHeaderRows || cells.every((row, index) => row.every((cell) => cell.tagName === (hasHeader && index === 0 ? "TH" : "TD"))));
    const captions = Array.from(element.children).filter((child) => child.tagName === "CAPTION").map((caption) => blocks(caption));
    if (!simple) {
      warn("table");
      return join([...captions, ...cells.flatMap((row) => row.map((cell) => blocks(cell)))].filter(Boolean), "\n\n");
    }
    if (wordHeaderRows && cells.slice(1).some((row) => row[0]?.tagName === "TH")) {
      warnings.add("Multiple Word table header rows were reduced to one; all row content was kept.");
    }
    const values = cells.map((row) => row.map((cell) => blocks(cell).replace(/\s*\n+\s*/g, " ").replace(/(?<!\\)\|/g, "\\|")));
    // GFM always requires a header; Orion's portable marker removes only this
    // synthetic row, retaining the first data row even when it is empty.
    const line = (row: string[]) => `| ${row.join(" | ")} |`;
    const body = [hasHeader ? line(values[0]) : line(Array(width).fill("")), line(Array(width).fill("---")), ...values.slice(hasHeader ? 1 : 0).map(line)].join("\n");
    return [...captions, `${hasHeader ? "" : '<!-- orion-table:v1 {"header":false} -->\n'}${body}`].filter(Boolean).join("\n\n");
  }

  function block(element: Element, omit?: Node): string {
    const tag = element.tagName;
    if (element.hasAttribute("style") || tag === "FORM") warn("appearance");
    if (tag === "UL" || tag === "OL") return list(element);
    if (tag === "TABLE") return table(element);
    if (tag === "BLOCKQUOTE") return join(blocks(element).split("\n").map((line) => `> ${line}`), "\n");
    if (tag === "PRE") {
      const text = rawText(element);
      return serializeFencedCode(text);
    }
    if (tag === "HR") return "---";
    if (/^H[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${children(element, omit).trim()}`;
    const glyph = tag === "P" && !element.closest("li") ? wordTask(element) : undefined;
    const value = taskContent(element, glyph, omit);
    return glyph ? `- [${glyph.checked ? "x" : " "}] ${value}` : value;
  }

  function blocks(element: Node, omit?: Node): string {
    const pieces: string[] = [];
    let pending: Node[] = [];
    const flush = () => { const text = inlines(pending, omit).trim(); if (text) pieces.push(text); pending = []; };
    for (const node of element.childNodes) {
      if (node === omit) continue;
      if (node.nodeType === 1 && BLOCK.test((node as Element).tagName)) {
        flush(); pieces.push(block(node as Element, omit));
      } else pending.push(node);
    }
    flush();
    return join(pieces.filter(Boolean), "\n\n");
  }
  const text = blocks(root).trim();
  checkSize(text.length);
  return { title, text, warnings: [...warnings] };
}
