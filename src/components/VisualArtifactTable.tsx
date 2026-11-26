import { FactSource } from "./ArtifactEvidenceView";
import type { ArtifactBlock } from '../lib/visualArtifacts';

type TableBlock = Extract<ArtifactBlock, { kind: 'table' }>;

export function VisualArtifactTable({ block, title }: { block: TableBlock; title?: string }) {
  return <table aria-label={title}>
    <thead><tr>{block.columns.map((column, i) => column === ''
      ? <td key={i} />
      : <th key={i} scope="col">{column}</th>)}</tr></thead>
    <tbody>{block.rows.map((row, i) => <tr key={i}>
      {row.map((cell, j) => j === 0 ? <th key={j} scope="row">{cell}<FactSource field="cell" index={i * block.columns.length + j}/></th> : <td key={j}>{cell}<FactSource field="cell" index={i * block.columns.length + j}/></td>)}
    </tr>)}</tbody>
  </table>;
}
