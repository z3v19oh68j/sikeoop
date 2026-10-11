import type { KnowledgeGraph } from "@shared/types";

// The two ways to draw a knowledge graph. Both are deterministic: the same graph always lands
// in the same place, so a node is where you left it after switching views or rebuilding.

export const NODE_W = 176;
export const NODE_H = 44;
const COL_GAP = 120;
const ROW_GAP = 14;

export interface Point {
  x: number;
  y: number;
}

export interface Layout {
  /** Node centres. */
  pos: Map<string, Point>;
  /** Column titles of the layered view (centre x, top y). */
  columns: { name: string; x: number; y: number }[];
}

/**
 * Swim lanes: one column per layer (only the layers that have nodes), rows ordered by the
 * average position of each node's neighbours (a few barycentre sweeps) so lines cross less.
 */
export function layered(g: KnowledgeGraph): Layout {
  const used = [...new Set(g.nodes.map((n) => n.layer))].sort((a, b) => a - b);
  const cols = used.map((layer) => g.nodes.filter((n) => n.layer === layer).map((n) => n.id));
  const nbrs = neighbours(g);
  const degree = (id: string) => nbrs.get(id)?.length ?? 0;
  for (const col of cols) col.sort((a, b) => degree(b) - degree(a) || a.localeCompare(b));

  const rank = new Map<string, number>();
  const setRanks = () => cols.forEach((col) => col.forEach((id, i) => rank.set(id, i - (col.length - 1) / 2)));
  setRanks();
  for (let sweep = 0; sweep < 6; sweep++) {
    const order = sweep % 2 ? [...cols].reverse() : cols;
    for (const col of order) {
      const bary = new Map(
        col.map((id) => {
          const ns = (nbrs.get(id) ?? []).filter((n) => !col.includes(n));
          return [id, ns.length ? ns.reduce((s, n) => s + rank.get(n)!, 0) / ns.length : rank.get(id)!];
        }),
      );
      col.sort((a, b) => bary.get(a)! - bary.get(b)! || a.localeCompare(b));
      col.forEach((id, i) => rank.set(id, i - (col.length - 1) / 2));
    }
  }

  const pos = new Map<string, Point>();
  const step = NODE_H + ROW_GAP;
  const tallest = Math.max(...cols.map((c) => c.length));
  cols.forEach((col, ci) => {
    const x = ci * (NODE_W + COL_GAP);
    col.forEach((id, i) => pos.set(id, { x, y: (i - (col.length - 1) / 2) * step }));
  });
  const top = -((tallest - 1) / 2) * step - NODE_H / 2 - 36;
  return { pos, columns: used.map((layer, ci) => ({ name: g.layers[layer] ?? "", x: ci * (NODE_W + COL_GAP), y: top })) };
}

/** A force-directed web: linked nodes pull together, all nodes push apart. Starts from the lanes. */
export function force(g: KnowledgeGraph): Layout {
  const start = layered(g).pos;
  const ids = g.nodes.map((n) => n.id);
  const p = ids.map((id) => ({ ...start.get(id)! }));
  const index = new Map(ids.map((id, i) => [id, i]));
  const links = g.edges.flatMap((e) => {
    const a = index.get(e.from);
    const b = index.get(e.to);
    return a === undefined || b === undefined ? [] : [[a, b] as const];
  });
  const n = p.length;
  const repel = 26000;
  const spring = 0.04;
  const rest = 210;
  for (let it = 0, heat = 1; it < 360; it++, heat *= 0.988) {
    const f = p.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = p[i].x - p[j].x;
        let dy = (p[i].y - p[j].y) * 1.6;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) (dx = (i - j) * 0.5), (dy = 1), (d2 = 1);
        const d = Math.sqrt(d2);
        const k = repel / d2;
        f[i].x += (dx / d) * k;
        f[i].y += (dy / d) * k;
        f[j].x -= (dx / d) * k;
        f[j].y -= (dy / d) * k;
      }
    }
    for (const [a, b] of links) {
      const dx = p[b].x - p[a].x;
      const dy = p[b].y - p[a].y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const k = spring * (d - rest);
      f[a].x += (dx / d) * k;
      f[a].y += (dy / d) * k;
      f[b].x -= (dx / d) * k;
      f[b].y -= (dy / d) * k;
    }
    for (let i = 0; i < n; i++) {
      f[i].x -= p[i].x * 0.01;
      f[i].y -= p[i].y * 0.016;
      const len = Math.hypot(f[i].x, f[i].y);
      const max = 40 * heat;
      const s = len > max ? max / len : 1;
      p[i].x += f[i].x * s;
      p[i].y += f[i].y * s;
    }
  }
  return { pos: new Map(ids.map((id, i) => [id, p[i]])), columns: [] };
}

export function neighbours(g: KnowledgeGraph): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of g.edges) {
    m.set(e.from, [...(m.get(e.from) ?? []), e.to]);
    m.set(e.to, [...(m.get(e.to) ?? []), e.from]);
  }
  return m;
}

/** The box around all nodes (and column titles), with a margin. */
export function bounds(l: Layout, overrides: Map<string, Point>) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [id, pt] of l.pos) {
    const q = overrides.get(id) ?? pt;
    x0 = Math.min(x0, q.x - NODE_W / 2);
    x1 = Math.max(x1, q.x + NODE_W / 2);
    y0 = Math.min(y0, q.y - NODE_H / 2);
    y1 = Math.max(y1, q.y + NODE_H / 2);
  }
  for (const c of l.columns) y0 = Math.min(y0, c.y - 8);
  if (!Number.isFinite(x0)) return { x: -200, y: -150, w: 400, h: 300 };
  const m = 40;
  return { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m };
}
