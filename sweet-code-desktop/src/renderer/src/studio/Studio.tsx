import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ProtoCanvas, ProtoDevice, ProtoDoc, ProtoScreen, ProtoSummary } from "@shared/types";
import { Icon } from "../components/Icon";
import { DemoPlayer } from "./DemoPlayer";
import { PublishPanel } from "./PublishPanel";
import { MyPublishes } from "../publish/MyPublishes";
import { SHOW_UNFINISHED } from "../unfinished";

// The prototype studio (D1): an infinite canvas of artboards, each a live render of one
// screen's HTML, the link lines between them, a pages panel, and a clickable demo.
// Prototypes are files in the project (see main/prototypes/store.ts); the canvas only reads
// them and saves where the artboards sit.

const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 3;
const DEVICE_LABEL: Record<ProtoDevice, string> = { phone: "手机", tablet: "平板", desktop: "电脑" };

interface View {
  x: number;
  y: number;
  zoom: number;
}

interface Props {
  hidden: boolean;
  /** Open a project-relative file in the code editor. */
  onOpenFile(path: string): void;
  /** Bumped by the app when a prototype file was saved from the editor. */
  externalChange: number;
}

export function Studio({ hidden, onOpenFile, externalChange }: Props) {
  const [list, setList] = useState<ProtoSummary[] | null>(null);
  const [doc, setDoc] = useState<ProtoDoc | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [demo, setDemo] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [myPublishes, setMyPublishes] = useState(false);
  const [view, setView] = useState<View>({ x: 80, y: 80, zoom: 0.5 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  // Fit once the new layout has rendered (the pages panel changes the canvas width).
  const pendingFit = useRef<{ ids: string[] | null; max: number } | null>(null);
  const fitLater = (ids: string[] | null = null, max = 1) => (pendingFit.current = { ids, max });
  useLayoutEffect(() => {
    const p = pendingFit.current;
    if (!p || !doc) return;
    pendingFit.current = null;
    const screens = p.ids ? doc.canvas.screens.filter((s) => p.ids!.includes(s.id)) : doc.canvas.screens;
    setView((v) => fitView(screens, viewportRef.current, p.max) ?? v);
  });

  const open = useCallback(async (name: string, fit = true) => {
    setError("");
    try {
      const d = await window.sweet.protoLoad(name);
      setDoc(d);
      setErrors({});
      setVersions((v) => Object.fromEntries(d.canvas.screens.map((s) => [s.id, (v[s.id] ?? 0) + 1])));
      if (fit) fitLater();
    } catch (e) {
      setError(cleanError(e));
    }
  }, []);

  // First visit: the most recently changed prototype.
  useEffect(() => {
    void window.sweet.protoList().then((l) => {
      setList(l);
      if (l[0]) void open(l[0].name);
    });
  }, [open]);

  // The agent (or a command) changed prototype files: reload, re-rendering only what changed.
  const reload = useCallback(
    async (changed?: string) => {
      const d = docRef.current;
      if (!d) return;
      try {
        const next = await window.sweet.protoLoad(d.name);
        setDoc(next);
        const all = !changed || /\/(canvas\.json|tokens\.css)$/.test(changed) || !changed.endsWith(".html");
        setVersions((v) =>
          Object.fromEntries(
            next.canvas.screens.map((s) => {
              const touched = all || changed === `prototypes/${d.name}/${s.file}` || next.sources[s.id] !== d.sources[s.id];
              return [s.id, (v[s.id] ?? 0) + (touched ? 1 : 0)];
            }),
          ),
        );
      } catch (e) {
        setError(cleanError(e));
      }
    },
    [],
  );

  useEffect(
    () =>
      window.sweet.onAgentEvent((e) => {
        const d = docRef.current;
        if (e.type === "workspace_changed") {
          void window.sweet.protoList().then(setList);
          if (d) void reload();
        }
        if (e.type === "file_changed" && e.path.startsWith("prototypes/")) {
          void window.sweet.protoList().then(setList);
          if (d && e.path.startsWith(`prototypes/${d.name}/`)) void reload(e.path);
        }
      }),
    [reload],
  );
  useEffect(() => {
    if (externalChange) void reload();
  }, [externalChange, reload]);

  // Saving positions: debounced, so dragging an artboard writes once.
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  function updateCanvas(change: (c: ProtoCanvas) => ProtoCanvas) {
    setDoc((d) => {
      if (!d) return d;
      const next = { ...d, canvas: change(d.canvas) };
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void window.sweet.protoSaveCanvas(next.name, next.canvas).catch((e) => setError(cleanError(e))), 400);
      return next;
    });
  }

  // Script errors reported by the artboards' runtime.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { __sweetProto?: boolean; type?: string; message?: string };
      if (!m?.__sweetProto || m.type !== "error") return;
      const frame = [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-screen]")].find((f) => f.contentWindow === e.source);
      if (frame) setErrors((x) => ({ ...x, [frame.dataset.screen!]: m.message ?? "脚本出错" }));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const links = useMemo(() => (doc ? findLinks(doc) : []), [doc]);

  if (hidden) return null;

  return (
    <main className="studio">
      <div className="studio-bar">
        <ProtoPicker list={list} current={doc?.name} onOpen={(n) => void open(n)} onCreated={(d) => {
          setDoc(d);
          setVersions(Object.fromEntries(d.canvas.screens.map((s) => [s.id, 1])));
          void window.sweet.protoList().then(setList);
          fitLater();
        }} />
        <span className="spacer" />
        {doc && (
          <>
            <div className="zoom" aria-label="缩放">
              <button type="button" className="icon-btn square" aria-label="缩小" onClick={() => setView((v) => zoomAt(v, v.zoom / 1.25, center(viewportRef.current)))}>
                −
              </button>
              <button type="button" className="icon-btn" title="适应窗口（Shift+1）" onClick={() => setView((v) => fitView(doc.canvas.screens, viewportRef.current) ?? v)}>
                {Math.round(view.zoom * 100)}%
              </button>
              <button type="button" className="icon-btn square" aria-label="放大" onClick={() => setView((v) => zoomAt(v, v.zoom * 1.25, center(viewportRef.current)))}>
                +
              </button>
            </div>
            <button
              type="button"
              className="mini-btn"
              disabled={!doc.canvas.screens.length}
              onClick={() => setDemo(selected ?? doc.canvas.start ?? doc.canvas.screens[0]?.id ?? null)}
            >
              <Icon name="play" /> 演示
            </button>
            {/* One-click publish waits for its hosting service (docs/方向A-一键发布-任务清单.md). */}
            {SHOW_UNFINISHED && (
              <>
            <span className="publish-anchor">
              <button type="button" className="mini-btn publish-btn" disabled={!doc.canvas.screens.length} onClick={() => setPublishing((v) => !v)}>
                发布
              </button>
              {publishing && <PublishPanel key={doc.name} protoName={doc.name} onClose={() => setPublishing(false)} />}
            </span>
            <span className="publish-anchor">
              <button type="button" className="mini-btn" onClick={() => setMyPublishes((v) => !v)}>
                我的发布
              </button>
              {myPublishes && <MyPublishes onClose={() => setMyPublishes(false)} />}
            </span>
              </>
            )}
          </>
        )}
      </div>

      {error && (
        <div className="studio-error" role="alert">
          {error}
          <button type="button" className="icon-btn square" aria-label="关闭" onClick={() => setError("")}>
            <Icon name="close" />
          </button>
        </div>
      )}

      <div className="studio-body">
        {doc && (
          <PagesPanel
            doc={doc}
            selected={selected}
            errors={errors}
            onSelect={(id) => {
              setSelected(id);
              const s = doc.canvas.screens.find((x) => x.id === id);
              if (s) setView((v) => fitView([s], viewportRef.current, 0.7) ?? v);
            }}
            onSetStart={(id) => updateCanvas((c) => ({ ...c, start: id }))}
            onOpenSource={(s) => onOpenFile(`prototypes/${doc.name}/${s.file}`)}
            onAdded={(d, id) => {
              setDoc(d);
              void window.sweet.protoList().then(setList);
              setVersions((v) => ({ ...v, [id]: 1 }));
              setSelected(id);
              const s = d.canvas.screens.find((x) => x.id === id);
              if (s) fitLater([s.id], 0.7);
            }}
            onError={setError}
          />
        )}
        <Canvas
          viewportRef={viewportRef}
          view={view}
          setView={setView}
          doc={doc}
          versions={versions}
          errors={errors}
          links={links}
          selected={selected}
          onSelect={setSelected}
          onMove={(id, x, y) => updateCanvas((c) => ({ ...c, screens: c.screens.map((s) => (s.id === id ? { ...s, x, y } : s)) }))}
          onPlay={(id) => setDemo(id)}
          empty={list !== null && !doc ? <EmptyState onCreated={(d) => {
            setDoc(d);
            setVersions(Object.fromEntries(d.canvas.screens.map((s) => [s.id, 1])));
            void window.sweet.protoList().then(setList);
            fitLater();
          }} /> : null}
        />
      </div>

      {demo && doc && <DemoPlayer doc={doc} start={demo} version={versions} onClose={() => setDemo(null)} />}
    </main>
  );
}

// ---- canvas ---------------------------------------------------------------------------

interface CanvasProps {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  view: View;
  setView: React.Dispatch<React.SetStateAction<View>>;
  doc: ProtoDoc | null;
  versions: Record<string, number>;
  errors: Record<string, string>;
  links: { from: string; to: string }[];
  selected: string | null;
  onSelect(id: string | null): void;
  onMove(id: string, x: number, y: number): void;
  onPlay(id: string): void;
  empty: React.ReactNode;
}

function Canvas({ viewportRef, view, setView, doc, versions, errors, links, selected, onSelect, onMove, onPlay, empty }: CanvasProps) {
  const [panning, setPanning] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const space = useRef(false);

  // Wheel: scroll pans, pinch / ⌘ / Ctrl + wheel zooms around the cursor. Not passive, to stop the page scrolling.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      // Trackpad pinches send small deltas, mouse wheels big ones: cap each step at about ±35%.
      if (e.ctrlKey || e.metaKey) setView((v) => zoomAt(v, v.zoom * Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.006), at));
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [viewportRef, setView]);

  // Space + drag pans (Figma), Shift+1 fits, +/- zoom.
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t as HTMLElement)?.isContentEditable;
    const down = (e: KeyboardEvent) => {
      if (typing(e.target) || !viewportRef.current?.offsetParent) return;
      if (e.code === "Space") {
        space.current = true;
        e.preventDefault();
      } else if (e.shiftKey && e.code === "Digit1" && doc) {
        setView((v) => fitView(doc.canvas.screens, viewportRef.current) ?? v);
      } else if ((e.key === "=" || e.key === "+") && !e.metaKey) {
        setView((v) => zoomAt(v, v.zoom * 1.25, center(viewportRef.current)));
      } else if (e.key === "-" && !e.metaKey) {
        setView((v) => zoomAt(v, v.zoom / 1.25, center(viewportRef.current)));
      }
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && (space.current = false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [doc, setView, viewportRef]);

  function startPan(e: React.PointerEvent) {
    const onBackground = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("studio-world");
    if (!(e.button === 1 || (e.button === 0 && (space.current || onBackground)))) return;
    if (onBackground && e.button === 0 && !space.current) onSelect(null);
    e.preventDefault();
    const start = { cx: e.clientX, cy: e.clientY, x: view.x, y: view.y };
    setPanning(true);
    const move = (ev: PointerEvent) => setView((v) => ({ ...v, x: start.x + ev.clientX - start.cx, y: start.y + ev.clientY - start.cy }));
    const end = () => {
      setPanning(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  }

  function startDrag(e: React.PointerEvent, s: ProtoScreen) {
    if (e.button !== 0 || space.current) return;
    e.stopPropagation();
    e.preventDefault();
    onSelect(s.id);
    const start = { cx: e.clientX, cy: e.clientY, x: s.x, y: s.y };
    let moved = false;
    setDragging(s.id);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.cx) / view.zoom;
      const dy = (ev.clientY - start.cy) / view.zoom;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3 / view.zoom) return;
      moved = true;
      onMove(s.id, Math.round(start.x + dx), Math.round(start.y + dy));
    };
    const end = () => {
      setDragging(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  }

  const byId = new Map(doc?.canvas.screens.map((s) => [s.id, s]) ?? []);

  return (
    <div
      ref={viewportRef}
      className={"studio-canvas" + (panning ? " panning" : "") + (space.current ? " grab" : "")}
      onPointerDown={startPan}
      style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${20 * view.zoom}px ${20 * view.zoom}px` }}
    >
      {empty}
      {doc && (
        <div className="studio-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
          <svg className="studio-links" aria-hidden="true">
            <defs>
              <marker id="proto-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M1 1 9 5 1 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </marker>
            </defs>
            {links.map((l) => {
              const a = byId.get(l.from);
              const b = byId.get(l.to);
              if (!a || !b || a === b) return null;
              return (
                <path
                  key={`${l.from}>${l.to}`}
                  d={linkPath(a, b)}
                  className={selected === l.from || selected === l.to ? "on" : undefined}
                  strokeWidth={1.5 / view.zoom}
                  markerEnd="url(#proto-arrow)"
                />
              );
            })}
          </svg>
          {doc.canvas.screens.map((s) => (
            <section
              key={s.id}
              className={"artboard" + (selected === s.id ? " selected" : "") + (dragging === s.id ? " dragging" : "")}
              style={{ left: s.x, top: s.y, width: s.width, height: s.height }}
              aria-label={`页面：${s.title}`}
            >
              <div className="artboard-label" style={{ transform: `scale(${1 / view.zoom})`, width: s.width * view.zoom }} onPointerDown={(e) => startDrag(e, s)} onDoubleClick={() => onPlay(s.id)}>
                <span className="t">{s.title}</span>
                {doc.canvas.start === s.id && s.width * view.zoom > 120 && <span className="badge">起始页</span>}
                {errors[s.id] && (
                  <span className="err" title={errors[s.id]}>
                    <Icon name="warning" /> 脚本出错
                  </span>
                )}
                {s.width * view.zoom > 200 && (
                  <span className="size">
                    {s.width} × {s.height}
                  </span>
                )}
              </div>
              <iframe
                data-screen={s.id}
                title={s.title}
                src={window.sweet.protoScreenUrl(doc.name, s.file, versions[s.id] ?? 0)}
                sandbox="allow-scripts"
                width={s.width}
                height={s.height}
                tabIndex={-1}
              />
              {/* The page stays visual on the canvas: clicks select and drag; the demo is for using it. */}
              <div className="artboard-cover" onPointerDown={(e) => startDrag(e, s)} onDoubleClick={() => onPlay(s.id)} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- side panel ----------------------------------------------------------------------

interface PagesProps {
  doc: ProtoDoc;
  selected: string | null;
  errors: Record<string, string>;
  onSelect(id: string): void;
  onSetStart(id: string): void;
  onOpenSource(s: ProtoScreen): void;
  onAdded(doc: ProtoDoc, id: string): void;
  onError(msg: string): void;
}

function PagesPanel({ doc, selected, errors, onSelect, onSetStart, onOpenSource, onAdded, onError }: PagesProps) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [device, setDevice] = useState<ProtoDevice>("phone");
  const sel = doc.canvas.screens.find((s) => s.id === selected);

  async function add() {
    try {
      const before = new Set(doc.canvas.screens.map((s) => s.id));
      const d = await window.sweet.protoAddScreen(doc.name, { title, device });
      const added = d.canvas.screens.find((s) => !before.has(s.id));
      setAdding(false);
      setTitle("");
      if (added) onAdded(d, added.id);
    } catch (e) {
      onError(cleanError(e));
    }
  }

  return (
    <aside className="studio-side" aria-label="页面">
      <div className="section-head">
        页面
        <span className="spacer" />
        <button type="button" className="icon-btn square" title="新建页面" aria-label="新建页面" onClick={() => setAdding((v) => !v)}>
          +
        </button>
      </div>
      {adding && (
        <form
          className="studio-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="页面名字，比如：设置" aria-label="页面名字" />
          <div className="row">
            <div className="seg" role="radiogroup" aria-label="设备">
              {(Object.keys(DEVICE_LABEL) as ProtoDevice[]).map((d) => (
                <button key={d} type="button" role="radio" aria-checked={device === d} className={device === d ? "on" : undefined} onClick={() => setDevice(d)}>
                  {DEVICE_LABEL[d]}
                </button>
              ))}
            </div>
            <button type="submit" className="send">
              添加
            </button>
          </div>
        </form>
      )}
      <ul className="studio-pages">
        {doc.canvas.screens.map((s) => (
          <li key={s.id}>
            <button type="button" className={"tree-row" + (selected === s.id ? " active" : "")} onClick={() => onSelect(s.id)} title={s.file}>
              <Icon name={s.device === "desktop" ? "files" : "file"} className="ft" />
              <span className="name">{s.title}</span>
              {doc.canvas.start === s.id && <span className="start-dot" title="起始页" />}
              {errors[s.id] && <Icon name="warning" className="err-icon" />}
              <span className="dim">{s.width}</span>
            </button>
          </li>
        ))}
      </ul>
      {doc.warnings.length > 0 && (
        <div className="studio-warn">
          {doc.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}
      <span className="spacer" />
      {sel && (
        <div className="studio-sel">
          <div className="t">{sel.title}</div>
          <div className="hint">
            {DEVICE_LABEL[sel.device]} · {sel.width} × {sel.height}
          </div>
          <code className="cmd-inline">{sel.file}</code>
          {errors[sel.id] && <p className="err-text">{errors[sel.id]}</p>}
          <div className="row-links">
            <button type="button" className="mini-btn" onClick={() => onOpenSource(sel)}>
              看代码
            </button>
            {doc.canvas.start !== sel.id && (
              <button type="button" className="mini-btn" onClick={() => onSetStart(sel.id)}>
                设为起始页
              </button>
            )}
          </div>
        </div>
      )}
      <p className="hint studio-tip">
        拖动画板标题可以移动；双击画板开始演示。在页面里给元素加 <code>data-goto="页面id"</code>，演示时点它就会跳过去。
      </p>
    </aside>
  );
}

function ProtoPicker({ list, current, onOpen, onCreated }: { list: ProtoSummary[] | null; current?: string; onOpen(name: string): void; onCreated(d: ProtoDoc): void }) {
  const [creating, setCreating] = useState(false);
  if (!list?.length && !current) return <span className="studio-title">原型工坊</span>;
  return (
    <div className="studio-picker">
      <Icon name="frame" />
      {creating ? (
        <NewProtoForm onCreated={(d) => (setCreating(false), onCreated(d))} onCancel={() => setCreating(false)} compact />
      ) : (
        <>
          <span className="select-pill strong">
            <select value={current ?? ""} onChange={(e) => (e.target.value === "__new" ? setCreating(true) : onOpen(e.target.value))} aria-label="选择原型">
              {list?.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}（{p.screens} 页）
                </option>
              ))}
              <option value="__new">＋ 新建原型…</option>
            </select>
            <Icon name="chevron-down" />
          </span>
        </>
      )}
    </div>
  );
}

function NewProtoForm({ onCreated, onCancel, compact }: { onCreated(d: ProtoDoc): void; onCancel?(): void; compact?: boolean }) {
  const [name, setName] = useState(compact ? "" : "我的原型");
  const [error, setError] = useState("");
  async function create() {
    setError("");
    try {
      onCreated(await window.sweet.protoCreate(name));
    } catch (e) {
      setError(cleanError(e));
    }
  }
  return (
    <form
      className={"new-proto" + (compact ? " compact" : "")}
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void create();
      }}
    >
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="原型名字" aria-label="原型名字" maxLength={40} />
      <button type="submit" className="send" disabled={!name.trim()}>
        新建
      </button>
      {onCancel && (
        <button type="button" className="icon-btn" onClick={onCancel}>
          取消
        </button>
      )}
      {error && <span className="err-text">{error}</span>}
    </form>
  );
}

function EmptyState({ onCreated }: { onCreated(d: ProtoDoc): void }) {
  return (
    <div className="studio-empty">
      <span className="mark">
        <Icon name="frame" />
      </span>
      <h2>原型工坊</h2>
      <p>在画布上摆出 App 的每个页面，每个页面都是真的网页，点「演示」就能像真 App 一样点来点去。原型保存在项目的 prototypes 文件夹里。</p>
      <NewProtoForm onCreated={onCreated} />
    </div>
  );
}

// ---- geometry ---------------------------------------------------------------------------

function center(el: HTMLElement | null) {
  return { x: (el?.clientWidth ?? 800) / 2, y: (el?.clientHeight ?? 600) / 2 };
}

function zoomAt(v: View, zoom: number, at: { x: number; y: number }): View {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  return { zoom: z, x: at.x - ((at.x - v.x) * z) / v.zoom, y: at.y - ((at.y - v.y) * z) / v.zoom };
}

/** The view that shows these screens whole, centered, at most 100% (or `max`). */
function fitView(screens: ProtoScreen[], el: HTMLElement | null, max = 1): View | null {
  if (!el || !screens.length) return null;
  const pad = 72;
  const minX = Math.min(...screens.map((s) => s.x));
  const minY = Math.min(...screens.map((s) => s.y)) - 28;
  const maxX = Math.max(...screens.map((s) => s.x + s.width));
  const maxY = Math.max(...screens.map((s) => s.y + s.height));
  const zoom = Math.min(max, (el.clientWidth - pad * 2) / (maxX - minX), (el.clientHeight - pad * 2) / (maxY - minY));
  const z = Math.max(MIN_ZOOM, zoom);
  return { zoom: z, x: (el.clientWidth - (maxX - minX) * z) / 2 - minX * z, y: (el.clientHeight - (maxY - minY) * z) / 2 - minY * z };
}

/** Screen-to-screen links: every [data-goto] target in a screen's HTML. */
function findLinks(doc: ProtoDoc): { from: string; to: string }[] {
  const out = new Map<string, { from: string; to: string }>();
  const parser = new DOMParser();
  for (const s of doc.canvas.screens) {
    const html = doc.sources[s.id];
    if (!html) continue;
    for (const el of parser.parseFromString(html, "text/html").querySelectorAll("[data-goto]")) {
      const to = el.getAttribute("data-goto") ?? "";
      if (to && to !== s.id) out.set(`${s.id}>${to}`, { from: s.id, to });
    }
  }
  return [...out.values()];
}

function linkPath(a: ProtoScreen, b: ProtoScreen): string {
  const forward = b.x >= a.x + a.width / 2;
  const sx = forward ? a.x + a.width : a.x;
  const tx = forward ? b.x : b.x + b.width;
  const sy = a.y + a.height / 2;
  const ty = b.y + b.height / 2;
  const bend = Math.max(60, Math.abs(tx - sx) / 2);
  const c1 = forward ? sx + bend : sx - bend;
  const c2 = forward ? tx - bend : tx + bend;
  return `M ${sx} ${sy} C ${c1} ${sy}, ${c2} ${ty}, ${tx} ${ty}`;
}
