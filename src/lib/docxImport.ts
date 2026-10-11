import { htmlToMarkdown } from "./htmlImport";

/** Mammoth's semantic HTML shares the bounded inert converter used by local
 * HTML import. The Word profile retains its established checkbox glyphs and
 * mailto links; images remain descriptions and report an explicit warning. */
export function parseDocxHtml(html: string): { text: string; warnings: string[] } {
  try {
    const { text, warnings } = htmlToMarkdown(html, "word");
    return { text, warnings };
  } catch (error) {
    if (error instanceof Error) throw new Error(error.message.replace(/HTML document/g, "Word document"));
    throw error;
  }
}

/** Retained for export/import comparisons that only need the semantic text. */
export function docxHtmlToMarkdown(html: string): string {
  return parseDocxHtml(html).text;
}
