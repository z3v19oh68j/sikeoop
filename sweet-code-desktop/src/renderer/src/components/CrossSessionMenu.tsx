import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { sessionApi, type CrossSession } from "./crossSession";

/** 「+」菜单里的跨项目 session 区：新建，以及最近的（含已结束的）session 列表。 */
export function CrossSessionMenu({ openIds, onNew, onOpen }: { openIds: string[]; onNew(): void; onOpen(s: CrossSession): void }) {
  const [list, setList] = useState<CrossSession[] | null>(null);
  useEffect(() => {
    const api = sessionApi();
    if (!api) return setList([]);
    void api.list().then((r) => setList(r.ok ? [...r.data].sort((a, b) => b.createdAt - a.createdAt) : []));
    return api.onChanged((s) => setList((cur) => (cur ? (cur.some((x) => x.id === s.id) ? cur.map((x) => (x.id === s.id ? s : x)) : [s, ...cur]) : cur)));
  }, []);
  const shown = (list ?? []).slice(0, 8);
  return (
    <>
      <hr />
      <button type="button" onClick={onNew}>
        新建跨项目 session…
        <span>多个项目文件夹，和几个 AI 在同一条对话里干活</span>
      </button>
      {shown.length > 0 && <div className="xs-menu-title">最近的 session</div>}
      {shown.map((s) => (
        <button type="button" key={s.id} onClick={() => onOpen(s)}>
          <Icon name={s.state === "ended" ? "history" : "group"} /> {s.title}
          <span>
            {s.state === "ended" ? "已结束，只读" : openIds.includes(s.id) ? "进行中，已打开" : "进行中"} · {s.roots.length} 个工作区
          </span>
        </button>
      ))}
    </>
  );
}
