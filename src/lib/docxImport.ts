/** Convert Mammoth's semantic HTML to portable Markdown without executing HTML,
 * loading images, preserving native paths, or trusting embedded style maps. */
export function docxHtmlToMarkdown(html: string): string {
  if (html.length > 16 * 1024 * 1024) throw new Error("This Word document contains too much extracted content.");
  const document = new DOMParser().parseFromString(html, "text/html");
  document.querySelectorAll("script,style,noscript,svg,canvas,template,iframe,object,embed").forEach((element) => element.remove());
  const escape = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/([\\`*_{}\[\]<>#])/g, "\\$1");

  function inline(node: Node): string {
    if (node.nodeType === 3) return escape(node.textContent ?? "").replace(/\s+/g, " ");
    if (!(node instanceof Element)) return "";
    const tag = node.tagName;
    const text = [...node.childNodes].map(inline).join("");
    if (tag === "BR") return "\n";
    if (tag === "STRONG" || tag === "B") return text.trim() ? `**${text}**` : text;
    if (tag === "EM" || tag === "I") return text.trim() ? `*${text}*` : text;
    if (tag === "DEL" || tag === "S") return text.trim() ? `~~${text}~~` : text;
    if (tag === "CODE") {
      const value = node.textContent ?? "";
      const fence = "`".repeat(Math.max(1, ...[...value.matchAll(/`+/g)].map((match) => match[0].length + 1)));
      return `${fence} ${value} ${fence}`;
    }
    if (tag === "IMG") return node.getAttribute("alt") ? `[Image: ${escape(node.getAttribute("alt")!)}]` : "[Image]";
    if (tag === "INPUT" && node.getAttribute("type") === "checkbox") return node.hasAttribute("checked") ? "☑ " : "☐ ";
    if (tag === "A") {
      try {
        const url = new URL(node.getAttribute("href") ?? "");
        if (["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password) {
          const destination = url.href.replace(/[()<>\s]/g, (character) => encodeURIComponent(character));
          return `[${text}](${destination})`;
        }
      } catch { /* Local and malformed links retain their visible labels. */ }
    }
    return text;
  }

  function list(element: Element, depth = 0): string {
    let number = Math.max(1, Number.parseInt(element.getAttribute("start") ?? "1") || 1);
    return [...element.children].filter((child) => child.tagName === "LI").map((item) => {
      const nested = [...item.children].filter((child) => child.tagName === "UL" || child.tagName === "OL");
      const own = item.cloneNode(true) as Element;
      [...own.children].filter((child) => child.tagName === "UL" || child.tagName === "OL").forEach((child) => child.remove());
      let value = blocks(own).trim();
      let marker = element.tagName === "OL" ? `${number++}. ` : "- ";
      const task = value.match(/^[☐☑☒]\s*/);
      if (task) { marker = task[0].startsWith("☐") ? "- [ ] " : "- [x] "; value = value.slice(task[0].length); }
      const paragraphTask = value.match(/^- \[([ x])\] /);
      if (paragraphTask) { marker = paragraphTask[0]; value = value.slice(paragraphTask[0].length); }
      const indent = "    ".repeat(depth);
      return `${indent}${marker}${value.replace(/\n/g, `\n${indent}    `)}${nested.map((child) => `\n${list(child, depth + 1)}`).join("")}`;
    }).join("\n");
  }

  function table(element: Element): string {
    const rows = [...element.querySelectorAll("tr")].filter((row) => row.closest("table") === element).map((row) =>
      [...row.children].map((cell) => blocks(cell).trim().replace(/\n+/g, " ").replace(/\|/g, "\\|")),
    );
    const width = Math.max(0, ...rows.map((row) => row.length));
    if (!width) return "";
    const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
    return [line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
  }

  function block(element: Element): string {
    const tag = element.tagName;
    if (tag === "UL" || tag === "OL") return list(element);
    if (tag === "TABLE") return table(element);
    if (tag === "BLOCKQUOTE") return blocks(element).split("\n").map((line) => `> ${line}`).join("\n");
    if (tag === "PRE") {
      const pre = element.cloneNode(true) as Element;
      pre.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
      const text = (pre.textContent ?? "").replace(/\n$/, "");
      const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
      return `${fence}\n${text}\n${fence}`;
    }
    if (tag === "HR") return "---";
    if (/^H[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${[...element.childNodes].map(inline).join("").trim()}`;
    if (tag === "P") {
      const text = [...element.childNodes].map(inline).join("").trim();
      return text.replace(/^([-+])(?=\s)/, "\\$1").replace(/^(\d+)([.)])(?=\s)/, "$1\\$2")
        .replace(/^☐\s*/, "- [ ] ").replace(/^[☑☒]\s*/, "- [x] ");
    }
    return blocks(element);
  }

  function blocks(element: Element): string {
    const pieces: string[] = [];
    let text = "";
    const flush = () => { if (text.trim()) pieces.push(text.trim()); text = ""; };
    for (const node of element.childNodes) {
      if (node instanceof Element && /^(?:P|DIV|SECTION|H[1-6]|UL|OL|TABLE|BLOCKQUOTE|PRE|HR)$/.test(node.tagName)) {
        flush(); pieces.push(block(node));
      } else text += inline(node);
    }
    flush();
    return pieces.filter(Boolean).join("\n\n");
  }
  return blocks(document.body).trim();
}
