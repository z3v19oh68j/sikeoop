import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphEdge, GraphEdgeKind, GraphNode, GraphNodeKind, GraphState, KnowledgeGraph } from "@shared/types";
import { Icon } from "../components/Icon";
import { OPEN_FILE, type OpenFileDetail } from "../components/Markdown";
import { type Layout, NODE_H, NODE_W, type Point, bounds, force, layered } from "./layout";

const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

const KIND_NAME: Record<GraphNodeKind, string> = {
  entry: "入口",
  feature: "功能",
  module: "模块",
  data: "数据",
  goal: "目标",
  requirement: "需求",
  interface: "接口",
  constraint: "约束",
};
const EDGE_NAME: Record<GraphEdgeKind, string> = {
  contains: "包含",
  depends: "依赖",
  calls: "调用",
  implements: "实现",
  constrains: "约束",
  produces: "产出",
  uses: "使用",
};
/** Node kinds that are work to be done, so they can go to the Agent. */
const TASK_KINDS = new Set<GraphNodeKind>(["requirement", "feature", "interface"]);

type View = "layered" | "force";
const VIEW_KEY = "sweet.graph.view";

interface Props {
  hidden: boolean;
  /** The chat model is set up, so graphs can be built and questions asked. */
  canWrite: boolean;
  /** Ask the AI about a node in the chat. */
  onAsk(text: string): void;
  /** Hand a requirement to the Agent to implement. */
  onHandOff(text: string): void;
}

/**
 * 知识图谱: the open project's code, or a development document, as flat typed nodes and the
 * relations between them, drawn as swim lanes or as a web.
 */
export function GraphScreen({ hidden, canWrite, onAsk, onHandOff }: Props) {
  const [state, setState] = useState<GraphState>({ graphs: [], running: null });
  const [graphId, setGraphId] = useState<string | null>(null);
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "force" ? "force" : "layered";
    } catch {
      return "layered";
    }
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState<string>();
  const [docs, setDocs] = useState<string[] | null>(null);

  const load = useCallback((id: string | null) => {
    if (!id) return setGraph(null);
    void window.sweet.graphGet(id).then((g) => setGraph((cur) => (g && cur?.id === g.id && cur.generatedAt === g.generatedAt ? { ...cur, stale: g.stale } : g)));
  }, []);

  useEffect(() => {
    void window.sweet.graphState().then(setState);
    return window.sweet.onGraphState(setState);
  }, []);

  // Pick a graph when there is none chosen; show the one just built when a run ends.
  const wasRunning = useRef<string | null>(null);
  useEffect(() => {
    const ids = state.graphs.map((g) => g.id);
    const finished = wasRunning.current && !state.running ? wasRunning.current : null;
    wasRunning.current = state.running?.id ?? null;
    if (finished && ids.includes(finished)) {
      setGraphId(finished);
      setSelected(null);
      load(finished);
    } else if (!graphId || !ids.includes(graphId)) {
      setGraphId(ids[0] ?? null);
    }
  }, [state, graphId, load]);
  useEffect(() => load(graphId), [graphId, load]);
  // Coming back to the screen: check whether the code or document changed meanwhile.
  useEffect(() => {
    if (!hidden && graphId) load(graphId);
  }, [hidden]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (p: Promise<void>) => {
    setError("");
    p.catch((e) => setError(cleanError(e)));
  };
  const buildDoc = (file: string) => {
    setDocs(null);
    run(window.sweet.graphBuildDoc(file));
  };
  const importDoc = () => {
    setDocs(null);
    void window.sweet.graphPickDoc().then((file) => file && buildDoc(file));
  };
  const rebuild = () => {
    if (!graph) return;
    run(graph.origin.type === "code" ? window.sweet.graphBuildCode() : window.sweet.graphBuildDoc(graph.origin.path));
  };
  const remove = (id: string, title: string) => {
    if (!window.confirm(`删除图谱「${title}」？`)) return;
    void window.sweet.graphDelete(id);
  };

  const running = state.running;
  const shownError = error || (state.error !== dismissed ? state.error : "");
  const node = graph?.nodes.find((n) => n.id === selected) ?? null;

  return (
    <main className="graph" hidden={hidden}>
      <div className="studio-bar">
        <Icon name="graph" />
        <span className="studio-title">知识图谱</span>
        {graph && (
          <span className="wiki-meta" title={graph.summary}>
            {graph.title}
          </span>
        )}
        {graph?.stale && !running && (
          <button type="button" className="mini-btn warn" disabled={!canWrite} onClick={rebuild} title="生成之后代码或文档改过了">
            <Icon name="refresh" /> 内容已变，重新生成
          </button>
        )}
        <span className="spacer" />
        {graph && (
          <>
            <input className="graph-search" type="search" placeholder="找节点…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜索节点" />
            <div className="seg" role="group" aria-label="画法">
              {(["layered", "force"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  className={view === v ? "on" : undefined}
                  onClick={() => {
                    setView(v);
                    try {
                      localStorage.setItem(VIEW_KEY, v);
                    } catch {
                      // Not remembered; fine.
                    }
                  }}
                >
                  {v === "layered" ? "分层" : "网状"}
                </button>
              ))}
            </div>
          </>
        )}
        {running ? (
          <>
            <span className="wiki-meta">
              {running.label}
              {running.total > 1 && `（${running.done + 1}/${running.total}）`}
            </span>
            <button type="button" className="mini-btn" onClick={() => void window.sweet.graphCancel()}>
              <Icon name="stop" /> 停止
            </button>
          </>
        ) : (
          graph && (
            <button type="button" className="mini-btn" disabled={!canWrite} onClick={rebuild} title={graph.model}>
              <Icon name="sparkle" /> 重新生成
            </button>
          )
        )}
      </div>
      {shownError && (
        <div className="studio-error" role="alert">
          <Icon name="warning" /> {shownError}
          <button type="button" className="icon-btn square" aria-label="关闭" onClick={() => (setError(""), setDismissed(state.error))}>
            <Icon name="close" />
          </button>
        </div>
      )}

      <div className="graph-body">
        <nav className="graph-list" aria-label="图谱">
          <div className="graph-new">
            <button type="button" className="mini-btn" disabled={!canWrite || !!running} onClick={() => run(window.sweet.graphBuildCode())}>
              <Icon name="files" /> 拆解项目代码
            </button>
            <button
              type="button"
              className={docs ? "mini-btn on" : "mini-btn"}
              disabled={!canWrite || !!running}
              aria-expanded={!!docs}
              onClick={() => (docs ? setDocs(null) : void window.sweet.graphProjectDocs().then(setDocs))}
            >
              <Icon name="file" /> 项目里的文档 <Icon name="chevron-down" />
            </button>
            {docs && (
              <div className="graph-docs" role="menu">
                {docs.length === 0 && <p className="wiki-note">项目里没有 .md .txt .pdf .docx 文档</p>}
                {docs.map((d) => (
                  <button key={d} type="button" role="menuitem" title={d} onClick={() => buildDoc(d)}>
                    {d}
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="mini-btn" disabled={!canWrite || !!running} onClick={importDoc}>
              <Icon name="folder-open" /> 导入 PDF / Word…
            </button>
            {!canWrite && <p className="wiki-note">先在设置里配置好模型</p>}
          </div>
          {running && !state.graphs.some((g) => g.id === running.id) && (
            <div className="graph-item busy">
              <span className="t">{running.label}…</span>
            </div>
          )}
          {state.graphs.map((g) => (
            <div key={g.id} className={"graph-item" + (g.id === graphId ? " on" : "")}>
              <button type="button" className="pick" onClick={() => (setGraphId(g.id), setSelected(null))} title={g.origin.type === "doc" ? g.origin.path : "项目代码"}>
                <Icon name={g.origin.type === "code" ? "files" : "file"} />
                <span className="t">{g.title}</span>
                <span className="dim">{running?.id === g.id ? "更新中" : g.nodes}</span>
              </button>
              <button type="button" className="icon-btn square del" aria-label="删除" title="删除" onClick={() => remove(g.id, g.title)}>
                <Icon name="trash" />
              </button>
            </div>
          ))}
        </nav>

        {graph ? (
          <>
            <Canvas graph={graph} view={view} selected={selected} hover={hover} query={query} onSelect={setSelected} onHover={setHover} />
            {node && (
              <NodePanel
                graph={graph}
                node={node}
                canWrite={canWrite}
                onSelect={setSelected}
                onClose={() => setSelected(null)}
                onAsk={() => onAsk(askText(graph, node))}
                onHandOff={() => onHandOff(taskText(graph, node))}
              />
            )}
          </>
        ) : (
          <div className="wiki-empty">
            <Icon name="graph" />
            <h2>把项目或文档拆成一张关系图</h2>
            <p>
              拆解项目代码：先静态分析出模块和真实的 import 依赖，再让 AI 归纳出入口、功能、模块、数据四层。
              <br />
              拆解开发文档（Markdown、PDF、Word）：梳理出目标、需求、功能、接口、约束，每个节点都附上原文出处。
            </p>
            <p className="wiki-note">生成时会把模块清单或文档内容发给当前选择的模型服务商。</p>
          </div>
        )}
      </div>
    </main>
  );
}

function Canvas({
  graph,
  view,
  selected,
  hover,
  query,
  onSelect,
  onHover,
}: {
  graph: KnowledgeGraph;
  view: View;
  selected: string | null;
  hover: string | null;
  query: string;
  onSelect(id: string | null): void;
  onHover(id: string | null): void;
}) {
  const layout: Layout = useMemo(() => (view === "force" ? force(graph) : layered(graph)), [graph, view]);
  /** Nodes the user dragged in the web view. */
  const [moved, setMoved] = useState(new Map<string, Point>());
  const [cam, setCam] = useState({ x: 0, y: 0, k: 1 });
  const wrap = useRef<HTMLDivElement>(null);
  const pos = (id: string) => moved.get(id) ?? layout.pos.get(id);

  const fit = useCallback(() => {
    const el = wrap.current;
    if (!el) return;
    const b = bounds(layout, new Map());
    const k = Math.min(el.clientWidth / b.w, el.clientHeight / b.h, 1.3);
    setCam({ k, x: el.clientWidth / 2 - (b.x + b.w / 2) * k, y: el.clientHeight / 2 - (b.y + b.h / 2) * k });
  }, [layout]);
  useEffect(() => {
    setMoved(new Map());
  }, [layout]);
  useEffect(() => {
    // After the moved positions reset, so the fit uses the fresh layout.
    const t = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(t);
  }, [fit]);

  // Wheel zooms around the pointer (non-passive, to keep the page from scrolling).
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setCam((c) => {
        const k = Math.min(3, Math.max(0.15, c.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: mx - (mx - c.x) * (k / c.k), y: my - (my - c.y) * (k / c.k) };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Centre a node that was picked from the side panel or the search.
  const centre = useCallback(
    (id: string) => {
      const p = pos(id);
      const el = wrap.current;
      if (!p || !el) return;
      setCam((c) => ({ ...c, x: el.clientWidth / 2 - p.x * c.k, y: el.clientHeight / 2 - p.y * c.k }));
    },
    [layout, moved], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const lastSelected = useRef(selected);
  useEffect(() => {
    if (selected && selected !== lastSelected.current) {
      const p = pos(selected);
      const el = wrap.current;
      // Only when it is off screen; clicking a visible node shouldn't move the view.
      if (p && el) {
        const sx = p.x * cam.k + cam.x;
        const sy = p.y * cam.k + cam.y;
        if (sx < 40 || sy < 40 || sx > el.clientWidth - 40 || sy > el.clientHeight - 40) centre(selected);
      }
    }
    lastSelected.current = selected;
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      q
        ? new Set(
            graph.nodes
              .filter((n) => `${n.label} ${n.summary} ${n.sources.map((s) => s.file ?? s.section ?? "").join(" ")}`.toLowerCase().includes(q))
              .map((n) => n.id),
          )
        : null,
    [graph, q],
  );
  const focus = hover ?? selected;
  const near = useMemo(() => {
    if (!focus) return null;
    const s = new Set([focus]);
    for (const e of graph.edges) {
      if (e.from === focus) s.add(e.to);
      if (e.to === focus) s.add(e.from);
    }
    return s;
  }, [graph, focus]);

  // Dragging: the background pans, a node moves (web view) or is just clicked.
  const drag = useRef<{ kind: "pan" | "node"; id?: string; sx: number; sy: number; ox: number; oy: number; movedFar: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent, id?: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = id ? pos(id) : null;
    drag.current = id && view === "force" && p ? { kind: "node", id, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, movedFar: false } : { kind: "pan", id, sx: e.clientX, sy: e.clientY, ox: cam.x, oy: cam.y, movedFar: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.movedFar = true;
    if (!d.movedFar) return;
    if (d.kind === "pan") setCam((c) => ({ ...c, x: d.ox + dx, y: d.oy + dy }));
    else setMoved((m) => new Map(m).set(d.id!, { x: d.ox + dx / cam.k, y: d.oy + dy / cam.k }));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.movedFar) onSelect(d.id ?? null);
  };

  const kinds = [...new Set(graph.nodes.map((n) => n.kind))];
  const layerOf = new Map(graph.nodes.map((n) => [n.id, n.layer]));

  return (
    <div className="graph-canvas" ref={wrap}>
      <svg
        role="img"
        aria-label={`知识图谱：${graph.title}`}
        onPointerDown={(e) => onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
      >
        <defs>
          <marker id="garrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" />
          </marker>
        </defs>
        <g transform={`translate(${cam.x} ${cam.y}) scale(${cam.k})`}>
          {layout.columns.map((c) => (
            <text key={c.name} className="graph-col" x={c.x} y={c.y} textAnchor="middle">
              {c.name}
            </text>
          ))}
          {graph.edges.map((e, i) => {
            const a = pos(e.from);
            const b = pos(e.to);
            if (!a || !b) return null;
            const on = !!focus && (e.from === focus || e.to === focus);
            const dim = (!!near && !on) || (!!matches && !(matches.has(e.from) && matches.has(e.to)));
            const d = view === "layered" ? lanePath(a, b, layerOf.get(e.from) === layerOf.get(e.to)) : straightPath(a, b);
            return (
              <g key={i} className={"gedge" + (on ? " on" : "") + (dim ? " dim" : "")}>
                <path d={d} markerEnd="url(#garrow)" style={e.weight ? { strokeWidth: 1.2 + Math.log2(e.weight) * 0.6 } : undefined} />
                {on && (
                  <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4} textAnchor="middle">
                    {EDGE_NAME[e.kind] ?? e.kind}
                    {e.weight && e.weight > 1 ? ` ×${e.weight}` : ""}
                  </text>
                )}
              </g>
            );
          })}
          {graph.nodes.map((n) => {
            const p = pos(n.id);
            if (!p) return null;
            const dim = (!!near && !near.has(n.id)) || (!!matches && !matches.has(n.id));
            return (
              <g
                key={n.id}
                className={`gnode k-${n.kind}` + (n.id === selected ? " sel" : "") + (dim ? " dim" : "") + (matches?.has(n.id) ? " match" : "")}
                transform={`translate(${p.x - NODE_W / 2} ${p.y - NODE_H / 2})`}
                onPointerDown={(e) => onPointerDown(e, n.id)}
                onPointerEnter={() => onHover(n.id)}
                onPointerLeave={() => onHover(null)}
              >
                <title>{n.summary || n.label}</title>
                <rect className="box" width={NODE_W} height={NODE_H} rx={8} />
                <rect className="stripe" x={0} y={0} width={4} height={NODE_H} rx={2} />
                <text className="lbl" x={14} y={19}>
                  {clip(n.label, 12)}
                </text>
                <text className="sub" x={14} y={34}>
                  {clip(`${KIND_NAME[n.kind]} · ${subtitle(n)}`, 17)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="graph-legend">
        {kinds.map((k) => (
          <span key={k} className={`k-${k}`}>
            <i /> {KIND_NAME[k]}
          </span>
        ))}
      </div>
      <div className="graph-zoom">
        <button type="button" className="icon-btn square" title="放大" aria-label="放大" onClick={() => setCam((c) => zoomAt(c, 1.25, wrap.current))}>
          +
        </button>
        <button type="button" className="icon-btn square" title="缩小" aria-label="缩小" onClick={() => setCam((c) => zoomAt(c, 0.8, wrap.current))}>
          −
        </button>
        <button type="button" className="icon-btn square" title="适应窗口" aria-label="适应窗口" onClick={() => (setMoved(new Map()), requestAnimationFrame(fit))}>
          <Icon name="maximize" />
        </button>
      </div>
      {matches && (
        <div className="graph-hits">
          找到 {matches.size} 个
          {matches.size > 0 && (
            <button type="button" className="link-btn" onClick={() => onSelect([...matches][0])}>
              定位第一个
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NodePanel({
  graph,
  node,
  canWrite,
  onSelect,
  onClose,
  onAsk,
  onHandOff,
}: {
  graph: KnowledgeGraph;
  node: GraphNode;
  canWrite: boolean;
  onSelect(id: string): void;
  onClose(): void;
  onAsk(): void;
  onHandOff(): void;
}) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const ups = graph.edges.filter((e) => e.to === node.id);
  const downs = graph.edges.filter((e) => e.from === node.id);
  const open = (path: string, line?: number) => window.dispatchEvent(new CustomEvent<OpenFileDetail>(OPEN_FILE, { detail: { path, line } }));
  const isDoc = graph.origin.type === "doc";

  const list = (title: string, edges: GraphEdge[], other: (e: GraphEdge) => string) =>
    edges.length > 0 && (
      <section>
        <h4>
          {title} <span className="dim">{edges.length}</span>
        </h4>
        <ul className="graph-links">
          {edges.map((e, i) => {
            const n = byId.get(other(e));
            return (
              n && (
                <li key={i}>
                  <button type="button" onClick={() => onSelect(n.id)}>
                    <i className={`dot k-${n.kind}`} />
                    <span className="t">{n.label}</span>
                    <span className="dim">
                      {EDGE_NAME[e.kind] ?? e.kind}
                      {e.weight && e.weight > 1 ? ` ×${e.weight}` : ""}
                    </span>
                  </button>
                </li>
              )
            );
          })}
        </ul>
      </section>
    );

  return (
    <aside className="graph-panel" aria-label="节点详情">
      <header>
        <span className={`chip k-${node.kind}`}>{KIND_NAME[node.kind]}</span>
        <span className="spacer" />
        <button type="button" className="icon-btn square" aria-label="关闭" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <h3>{node.label}</h3>
      {node.summary && <p className="summary">{node.summary}</p>}
      <div className="graph-actions">
        <button type="button" className="mini-btn" disabled={!canWrite} onClick={onAsk}>
          <Icon name="chat-plus" /> 问 AI
        </button>
        {isDoc && TASK_KINDS.has(node.kind) && (
          <button type="button" className="mini-btn accent" disabled={!canWrite} onClick={onHandOff}>
            <Icon name="rocket" /> 交给 Agent 做
          </button>
        )}
      </div>
      {list("上游", ups, (e) => e.from)}
      {list("下游", downs, (e) => e.to)}
      {node.sources.length > 0 && (
        <section>
          <h4>来源</h4>
          <ul className="graph-sources">
            {node.sources.map((s, i) => (
              <li key={i}>
                {s.section && <div className="sec">{s.section}</div>}
                {s.quote && <blockquote>{s.quote}</blockquote>}
                {s.file && (
                  <button type="button" className="md-file" title="在编辑器里打开" onClick={() => open(s.file!, s.line)}>
                    {s.file}
                    {s.line ? `:${s.line}` : ""}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {isDoc && graph.origin.type === "doc" && graph.origin.external && <p className="wiki-note">出自项目外的文档《{graph.origin.name}》</p>}
        </section>
      )}
    </aside>
  );
}

/** Second line of a node: where it lives. */
function subtitle(n: GraphNode): string {
  const s = n.sources[0];
  if (!s) return "";
  if (n.kind === "feature" && !s.section) return `${n.sources.length} 处代码`;
  if (s.file && !s.section) return n.sources.length > 1 ? `${s.file.slice(0, s.file.lastIndexOf("/") + 1) || "./"} ${n.sources.length} 个文件` : s.file.slice(s.file.lastIndexOf("/") + 1);
  return s.section ?? "";
}

/** Cut to about `width` full-width characters (Latin letters count as half). */
function clip(text: string, width: number): string {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    w += text.charCodeAt(i) > 0x2e7f ? 1 : 0.56;
    if (w > width) return text.slice(0, i) + "…";
  }
  return text;
}

function lanePath(a: Point, b: Point, sameLayer: boolean): string {
  const hw = NODE_W / 2;
  if (sameLayer) {
    const x = a.x + hw;
    const bend = 40 + Math.min(80, Math.abs(b.y - a.y) * 0.25);
    return `M${x} ${a.y} C${x + bend} ${a.y} ${x + bend} ${b.y} ${x + 3} ${b.y}`;
  }
  const dir = b.x > a.x ? 1 : -1;
  const x1 = a.x + hw * dir;
  const x2 = b.x - hw * dir;
  const c = Math.max(30, Math.abs(x2 - x1) * 0.5) * dir;
  return `M${x1} ${a.y} C${x1 + c} ${a.y} ${x2 - c} ${b.y} ${x2} ${b.y}`;
}

/** Centre to centre, cut at both boxes' edges. */
function straightPath(a: Point, b: Point): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const cut = (sx: number, sy: number) => {
    const t = Math.min(Math.abs(sx) > 0 ? NODE_W / 2 / Math.abs(sx) : Infinity, Math.abs(sy) > 0 ? NODE_H / 2 / Math.abs(sy) : Infinity);
    return Math.min(t, 0.5);
  };
  const t = cut(dx, dy);
  return `M${a.x + dx * t} ${a.y + dy * t} L${b.x - dx * t} ${b.y - dy * t}`;
}

function zoomAt(c: { x: number; y: number; k: number }, f: number, el: HTMLElement | null) {
  const mx = (el?.clientWidth ?? 0) / 2;
  const my = (el?.clientHeight ?? 0) / 2;
  const k = Math.min(3, Math.max(0.15, c.k * f));
  return { k, x: mx - (mx - c.x) * (k / c.k), y: my - (my - c.y) * (k / c.k) };
}

function sourceText(graph: KnowledgeGraph, n: GraphNode): string {
  return n.sources
    .slice(0, 4)
    .map((s) => [s.file && `${s.file}${s.line ? `:${s.line}` : ""}`, s.section && `章节「${s.section}」`, s.quote && `原文“${s.quote}”`].filter(Boolean).join(" "))
    .join("\n")
    .replace(/^/gm, "- ")
    .concat(graph.origin.type === "doc" ? `\n（出自文档 ${graph.origin.external ? `《${graph.origin.name}》` : graph.origin.path}）` : "");
}

function relations(graph: KnowledgeGraph, n: GraphNode): string {
  const label = new Map(graph.nodes.map((x) => [x.id, `${x.label}（${KIND_NAME[x.kind]}）`]));
  const ups = graph.edges.filter((e) => e.to === n.id).map((e) => `${label.get(e.from)} ${EDGE_NAME[e.kind]}它`);
  const downs = graph.edges.filter((e) => e.from === n.id).map((e) => `它${EDGE_NAME[e.kind]} ${label.get(e.to)}`);
  return [...ups, ...downs].slice(0, 16).join("；");
}

function askText(graph: KnowledgeGraph, n: GraphNode): string {
  const rel = relations(graph, n);
  const src = n.sources.length ? sourceText(graph, n) : "";
  return (
    `我在看知识图谱「${graph.title}」里的${KIND_NAME[n.kind]}节点「${n.label}」。\n` +
    (n.summary ? `图谱里的说明：${n.summary}\n` : "") +
    (rel ? `关系：${rel}\n` : "") +
    (src ? `来源：\n${src}\n` : "") +
    `\n请结合项目里的实际代码给我讲讲它：具体做什么、和上下游怎么配合、如果要改它需要注意什么。`
  );
}

function taskText(graph: KnowledgeGraph, n: GraphNode): string {
  const rel = relations(graph, n);
  const src = n.sources.length ? sourceText(graph, n) : "";
  return (
    `请实现开发文档里的这条${KIND_NAME[n.kind]}：「${n.label}」\n` +
    (n.summary ? `说明：${n.summary}\n` : "") +
    (src ? `出处：\n${src}\n` : "") +
    (rel ? `相关节点：${rel}\n` : "") +
    `\n先在项目里找到相关代码，列一个简短的计划，再动手实现。做完告诉我改了哪些文件、怎么验证。`
  );
}
