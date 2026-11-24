import type { ArtifactBlock } from "./visualArtifacts";

type Scene = Extract<ArtifactBlock, { kind: "scene" }>;
type Flow = Scene["frames"][number]["flows"][number];

export interface SceneSubject {
  index: number;
  /** Centre of the illustration, in viewBox units. Captions sit underneath. */
  x: number;
  y: number;
  width: number;
  artSize: number;
}

interface SceneConnection {
  index: number;
  d: string;
  labelX: number;
  labelY: number;
  labelWidth: number;
}

export interface VisualSceneLayout {
  width: number;
  height: number;
  mode: "diagram" | "list";
  subjects: SceneSubject[];
  context: number[];
  connections: SceneConnection[];
}

const width = 720;
const captionSpace = 56;
const rowGap = 20;
const marginY = 18;

function subjectColumns(columns: number[][]) {
  const rows = Math.max(...columns.map(column => column.length));
  const artSize = columns.length > 2 ? 104 : rows > 1 ? 120 : 146;
  const subjectWidth = columns.length > 2 ? 152 : 196;
  const rowHeight = artSize + captionSpace;
  const height = 2 * marginY + rows * rowHeight + (rows - 1) * rowGap;
  const subjects = columns.flatMap((column, rank) => column.map((index, row) => ({
    index,
    x: columns.length === 2 ? width * (0.2 + 0.6 * rank) : width * (rank + 0.5) / columns.length,
    y: marginY + artSize / 2 + (row + (rows - column.length) / 2) * (rowHeight + rowGap),
    width: subjectWidth,
    artSize,
  })));
  return { subjects, height };
}

/** A drawing has a usable gutter only when every edge goes to the next rank.
 * Keep a relationship list for cycles, bypasses, and crossing or crowded ranks. */
function flowColumns(active: number[], flows: Flow[]): number[][] | undefined {
  const remaining = new Set(active);
  const columns: number[][] = [];
  while (remaining.size) {
    const column = [...remaining].filter(index => !flows.some(flow => flow.to === index && remaining.has(flow.from)));
    if (!column.length || column.length > 2 || columns.length === 3) return;
    columns.push(column);
    column.forEach(index => remaining.delete(index));
  }

  const positions = new Map<number, { rank: number; row: number }>();
  for (const [rank, column] of columns.entries()) {
    if (rank > 0 && column.length > 1) {
      // Preserve vertical order across a pair of independent connections.
      const incomingRow = (index: number) => {
        const incoming = flows.filter(flow => flow.to === index);
        return incoming.reduce((sum, flow) => sum + (positions.get(flow.from)?.row ?? 0), 0) / incoming.length;
      };
      column.sort((a, b) => incomingRow(a) - incomingRow(b));
    }
    column.forEach((index, row) => positions.set(index, { rank, row }));
  }
  if (flows.some((flow, i) => {
    const a = positions.get(flow.from)!, b = positions.get(flow.to)!;
    return b.rank !== a.rank + 1 || flows.slice(i + 1).some(other => {
      const c = positions.get(other.from)!, d = positions.get(other.to)!;
      return a.rank === c.rank && ((a.row - c.row) * (b.row - d.row) < 0 ||
        (flow.from === other.from && flow.to === other.to));
    });
  })) return;
  return columns;
}

function connectSubjects(subjects: SceneSubject[], flows: Flow[]): SceneConnection[] {
  const byIndex = new Map(subjects.map(subject => [subject.index, subject]));

  // Separate ports on a split or merge, ordered to match the other ends.
  function portY(subject: SceneSubject, other: SceneSubject, outgoing: boolean) {
    const adjacent = flows.filter(f => (outgoing ? f.from : f.to) === subject.index)
      .map(f => byIndex.get(outgoing ? f.to : f.from)!).sort((a, b) => a.y - b.y);
    return subject.y + (adjacent.indexOf(other) - (adjacent.length - 1) / 2) * 22;
  }
  return flows.map((flow, index) => {
    const source = byIndex.get(flow.from)!, target = byIndex.get(flow.to)!;
    const left = source.x + source.artSize / 2 + 7;
    const right = target.x - target.artSize / 2 - 7;
    const y1 = portY(source, target, true), y2 = portY(target, source, false);
    const middle = (left + right) / 2;
    return {
      index,
      d: y1 === y2
        ? `M ${left} ${y1} H ${right}`
        : `M ${left} ${y1} C ${middle} ${y1} ${middle} ${y2} ${right} ${y2}`,
      labelX: middle,
      labelY: (y1 + y2) / 2,
      labelWidth: right - left - 32,
    };
  });
}

function unconnectedSubjects(scene: Scene, active: number[]) {
  const nodes = active.map(i => scene.nodes[i]);
  const minX = Math.min(...nodes.map(n => n.x)), maxX = Math.max(...nodes.map(n => n.x));
  const minY = Math.min(...nodes.map(n => n.y)), maxY = Math.max(...nodes.map(n => n.y));
  const artSize = active.length === 1 ? 146 : 114;
  const subjectWidth = 174;
  const subjects = active.map(index => ({
    index,
    x: width / 2 + (scene.nodes[index].x - (minX + maxX) / 2) * (width - subjectWidth - 24) / 100,
    y: marginY + artSize / 2 + (scene.nodes[index].y - minY) * 2.8,
    width: subjectWidth,
    artSize,
  }));
  const height = marginY * 2 + artSize + captionSpace + (maxY - minY) * 2.8;
  const crowded = subjects.some((s, i) => subjects.slice(i + 1).some(t =>
    Math.abs(s.x - t.x) < subjectWidth + 8 && Math.abs(s.y - t.y) < artSize + captionSpace + 8));
  return { subjects, height, crowded };
}

export function layoutVisualScene(scene: Scene, frameIndex: number): VisualSceneLayout {
  const frame = scene.frames[frameIndex];
  const indices = scene.nodes.map((_, i) => i);
  const hasState = (i: number) => Boolean(frame.values[i].trim()) || frame.levels[i] !== null;
  const stated = indices.filter(hasState);
  const endpoints = new Set(frame.flows.flatMap(f => [f.from, f.to]));
  const active = endpoints.size ? indices.filter(i => endpoints.has(i)) : stated.length ? stated : indices;
  const context = endpoints.size ? stated.filter(i => !endpoints.has(i)) : [];
  const longCaptions = active.some(i => scene.nodes[i].label.length > 32 || frame.values[i].length > 28);

  if (!frame.flows.length) {
    const { subjects, height, crowded } = unconnectedSubjects(scene, active);
    return { width, height, mode: crowded || longCaptions ? "list" : "diagram", subjects, context, connections: [] };
  }

  // Use the model's vertical ordering to break ties within a flow rank.
  active.sort((a, b) => scene.nodes[a].y - scene.nodes[b].y || scene.nodes[a].x - scene.nodes[b].x || a - b);
  const columns = flowColumns(active, frame.flows);
  if (columns && !longCaptions) {
    const { subjects, height } = subjectColumns(columns);
    const connections = connectSubjects(subjects, frame.flows);
    // Budget for the smallest spatial presentation. Longer relationship text
    // wraps naturally in the list, without covering a connector or subject.
    const fits = connections.every(({ index, labelWidth }) => {
      const label = frame.flows[index].label;
      const estimatedWidth = Array.from(label).reduce((sum, ch) => sum + (/[^\u0020-\u007E]|[MW@%]/u.test(ch) ? 14 : 8), 0);
      return estimatedWidth + 10 <= labelWidth * 0.72;
    });
    if (fits) return { width, height, mode: "diagram", subjects, context, connections };
  }

  const { subjects, height } = subjectColumns([active]);
  return { width, height, mode: "list", subjects, context, connections: [] };
}
