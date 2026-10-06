import type { Editor } from "@tiptap/core";

export const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;
export type HeadingLevel = typeof HEADING_LEVELS[number];

/** Native choice inside More: its options cannot be clipped by the menu edge. */
export function HeadingPicker({ editor, level, onChoose }: {
  editor: Editor; level: number; onChoose?: () => void;
}) {
  return <label className="editor-style-select editor-heading-select"
    style={{ justifyContent: "space-between", paddingLeft: 9 }}>
    <span style={{ fontSize: 13 }}>Text style</span>
    <select aria-label="Text style" value={level} title="Paragraph or heading level"
      onKeyDown={event => {
        // Keep the native select's Arrow/Home/End behavior. Escape still closes
        // the enclosing menu and restores focus to its More trigger.
        if (event.key !== "Escape") event.stopPropagation();
      }}
      onChange={event => {
        const value = Number(event.target.value);
        if (!Number.isInteger(value) || value < 0 || value > 6) return;
        const chain = editor.chain().focus();
        if (value) chain.setHeading({ level: value as HeadingLevel }).run();
        else chain.setParagraph().run();
        onChoose?.();
      }}>
      <option value={0}>Text</option>
      {HEADING_LEVELS.map(value => <option key={value} value={value}>Heading {value}</option>)}
    </select>
  </label>;
}
