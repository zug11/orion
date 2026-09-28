import type { EditorState } from "@tiptap/pm/state";
export type SlashCommand = "heading" | "todo" | "bullet" | "numbered" | "divider" | "image" | "code" | "link" | "excerpt" | "table" | "delete-row" | "delete-column" | "delete-table" | `h${1|2|3|4|5|6}`;
export interface SlashMatch { from: number; to: number; query: string; inTable: boolean }
export function getSlashMatch(state: EditorState): SlashMatch | null {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code || $from.marks().some(mark => mark.type.name === "code")) return null;
  const prefix = $from.parent.textBetween(0, $from.parentOffset, "\ufffc", "\ufffc");
  // A command can start at any word boundary, including in the middle of an
  // existing paragraph. Slashes inside URLs and paths stay ordinary text.
  const match = /(?:^|[\s\ufffc])(\/([a-z-]{0,24}\d?))$/i.exec(prefix);
  if (!match) return null;
  const inTable = Array.from({ length: $from.depth }, (_, i) => $from.node(i + 1).type.name).includes("table");
  return { from: $from.pos - match[1].length, to: $from.pos, query: match[2].toLowerCase(), inTable };
}
export const SLASH_ITEMS: { id: SlashCommand; title: string; description: string; keywords?: string }[] = [
  {id:"heading", title:"Heading", description:"Choose a heading size", keywords:"title h1 h2 h3 h4 h5 h6"},
  {id:"todo", title:"To-do", description:"A checkbox connected to Home", keywords:"task checkbox"},
  {id:"bullet", title:"Bulleted list", description:"Start a simple list", keywords:"list unordered"},
  {id:"numbered", title:"Numbered list", description:"Put things in order", keywords:"list ordered"},
  {id:"divider", title:"Divider", description:"Give your writing a little space", keywords:"rule horizontal"},
  {id:"image", title:"Image", description:"Place an image in your note", keywords:"photo picture"},
  {id:"code", title:"Code", description:"Add a code block", keywords:"fence"},
  {id:"link", title:"Link a note", description:"Connect to a note in this Space", keywords:"reference"},
  {id:"excerpt", title:"Excerpt", description:"Quote an exact passage from a note", keywords:"quote quotation"},
  {id:"table", title:"Table", description:"Choose rows and columns", keywords:"grid"},
];
export function matchingSlashItems(match: SlashMatch) {
  if (match.inTable && /^(d|de|del|dele|delet|delete)(-|$)/.test(match.query)) {
    return [
      {id:"delete-row" as const,title:"Delete this row",description:"Remove the selected row"},
      {id:"delete-column" as const,title:"Delete this column",description:"Remove the selected column"},
      {id:"delete-table" as const,title:"Delete this table",description:"Remove the table"},
    ].filter(item => item.id.startsWith(match.query));
  }
  if (/^h[1-6]$/.test(match.query)) return [{id:match.query as SlashCommand,title:`Heading ${match.query[1]}`,description:"Apply this heading level"}];
  return SLASH_ITEMS.filter(item => !(match.inTable && item.id === "table") && `${item.id} ${item.title} ${item.keywords ?? ""}`.toLowerCase().includes(match.query));
}
