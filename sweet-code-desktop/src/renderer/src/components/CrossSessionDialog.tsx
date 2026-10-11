import { useEffect, useState } from "react";
import type { AgentCli, RecentProject } from "@shared/types";
import { Icon } from "./Icon";
import { MIN_SESSION_ROOTS, SCOPE_NOTE, sessionApi, type CrossSession } from "./crossSession";

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

interface Props {
  /** 当前打开的项目，默认勾上。 */
  currentRoot?: string;
  onClose(): void;
  onCreated(s: CrossSession): void;
}

/** 新建跨项目 session：起名字、至少勾 2 个工作区、可选直接拉一个 AI 进来。 */
export function CrossSessionDialog({ currentRoot, onClose, onCreated }: Props) {
  const [title, setTitle] = useState("");
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [extra, setExtra] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>(currentRoot ? [currentRoot] : []);
  const [manual, setManual] = useState("");
  const [cli, setCli] = useState<AgentCli | "">("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    void window.sweet.listRecent().then((r) => setRecent(r.filter((p) => p.exists)));
  }, []);

  const options = [
    ...recent.map((r) => ({ path: r.path, name: r.name })),
    ...(currentRoot && !recent.some((r) => r.path === currentRoot) ? [{ path: currentRoot, name: baseName(currentRoot) }] : []),
    ...extra.filter((p) => !recent.some((r) => r.path === p) && p !== currentRoot).map((p) => ({ path: p, name: baseName(p) })),
  ];
  const toggle = (p: string) => setPicked((ps) => (ps.includes(p) ? ps.filter((x) => x !== p) : [...ps, p]));
  const enough = picked.length >= MIN_SESSION_ROOTS;

  function addManual() {
    const p = manual.trim();
    if (!p) return;
    if (!extra.includes(p) && !options.some((o) => o.path === p)) setExtra((e) => [...e, p]);
    setPicked((ps) => (ps.includes(p) ? ps : [...ps, p]));
    setManual("");
  }

  async function create() {
    const api = sessionApi();
    if (!api) return setErr("当前版本还没接上跨项目 session，请更新 sikeoop 后再试。");
    setBusy(true);
    setErr("");
    const res = await api.create({ title: title.trim() || "未命名 session", roots: picked });
    if (!res.ok) {
      setBusy(false);
      return setErr(res.message);
    }
    if (cli) {
      const added = await api.addAgent(res.data.id, cli);
      if (!added.ok) setErr(`session 建好了，但没能拉入 AI：${added.message}`);
    }
    setBusy(false);
    onCreated(res.data);
  }

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal xsess-dialog" role="dialog" aria-label="新建跨项目 session">
        <h2>新建跨项目 session</h2>
        <p>让几个 AI 和你在同一条对话里，一起处理多个项目文件夹。</p>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="给这个 session 起个名字，比如：前后端联调" autoFocus />
        <div className="xsess-roots" role="group" aria-label="选择工作区">
          {options.length === 0 && <p>还没有可选的项目，先在下面输入文件夹路径。</p>}
          {options.map((o) => (
            <label key={o.path} className={picked.includes(o.path) ? "on" : ""}>
              <input type="checkbox" checked={picked.includes(o.path)} onChange={() => toggle(o.path)} />
              <span className="n">{o.name}</span>
              <span className="p" title={o.path}>{o.path}</span>
            </label>
          ))}
        </div>
        <div className="row">
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addManual()}
            placeholder="其他文件夹：粘贴完整路径后回车"
          />
          <button type="button" className="mini-btn" onClick={addManual} disabled={!manual.trim()}>
            <Icon name="folder-plus" /> 添加
          </button>
        </div>
        <p className={"xsess-count" + (enough ? " ok" : "")}>
          {enough ? `已选 ${picked.length} 个工作区` : `至少要选 ${MIN_SESSION_ROOTS} 个工作区才能创建（现在选了 ${picked.length} 个）`}
        </p>
        <label className="xsess-ai">
          <span>顺便拉一个 AI 进来（可选）</span>
          <select value={cli} onChange={(e) => setCli(e.target.value as AgentCli | "")}>
            <option value="">先不拉，建好再说</option>
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <p className="xsess-note">
          <Icon name="shield-check" /> {SCOPE_NOTE}
        </p>
        {err && <div className="err">{err}</div>}
        <div className="row">
          <button type="button" className="mini-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="mini-btn primary" disabled={!enough || busy} onClick={() => void create()}>
            {busy ? "创建中…" : "创建 session"}
          </button>
        </div>
      </div>
    </div>
  );
}
