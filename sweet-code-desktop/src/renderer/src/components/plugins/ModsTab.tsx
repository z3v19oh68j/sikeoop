import { useEffect, useState } from "react";
import type { ModPermission, ModPreview, ModView } from "@shared/types";
import { Icon } from "../Icon";
import { StatusBadge, Switch, cleanError, type Tone } from "../settings/ui";
import { AddPanel, Empty, Group, ItemCard, Tag, Toolbar, matches } from "./ui";
import { EVENT_LABEL } from "./HooksTab";

const PERMISSION_LABEL: Record<ModPermission, { text: string; risky?: boolean }> = {
  tools: { text: "给 AI 添加工具" },
  hooks: { text: "在对话各环节插手（可补充信息、拦截或放行操作）", risky: true },
  model: { text: "用你的模型和 Key 调用 AI（消耗你的额度）" },
  notify: { text: "在灵动岛上显示通知" },
  network: { text: "访问网络", risky: true },
  fs: { text: "读写你电脑上的文件", risky: true },
  shell: { text: "在你电脑上运行命令", risky: true },
};

const MOD_STATUS: Record<ModView["status"], { text: string; tone: Tone }> = {
  off: { text: "已关闭", tone: "muted" },
  running: { text: "运行中", tone: "ok" },
  error: { text: "出错了", tone: "bad" },
  changed: { text: "文件被改过", tone: "warn" },
};

type F = "all" | "on" | "problem";
const FILTERS: { id: F; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "on", label: "已启用" },
  { id: "problem", label: "有问题" },
];

export function ModsTab() {
  const [mods, setMods] = useState<ModView[] | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<F>("all");
  const [adding, setAdding] = useState(false);
  const [preview, setPreview] = useState<ModPreview | null>(null);
  const [dev, setDev] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void window.sweet.listMods().then(setMods);
  }, []);

  async function run(p: Promise<ModView[]>) {
    setError("");
    try {
      setMods(await p);
    } catch (e) {
      setError(cleanError(e));
    }
  }

  async function pick(kind: "folder" | "zip", asDev: boolean) {
    setError("");
    try {
      const p = await window.sweet.pickMod(kind);
      if (p) (setPreview(p), setDev(asDev));
    } catch (e) {
      setError(cleanError(e));
    }
  }

  const visible = (mods ?? []).filter(
    (m) =>
      matches(query, m.name, m.description, m.author) &&
      (filter === "all" || (filter === "on" ? m.enabled && m.status !== "changed" : m.status === "error" || m.status === "changed")),
  );

  return (
    <div className="pc-tab">
      <Toolbar<F>
        query={query}
        onQuery={setQuery}
        placeholder="搜索 Mod"
        filters={FILTERS}
        filter={filter}
        onFilter={setFilter}
        addLabel="安装 Mod"
        adding={adding}
        onAdd={() => setAdding(!adding)}
      />
      <div className="pc-scroll">
        {adding && (
          <AddPanel title="安装 Mod" onClose={() => setAdding(false)}>
            <p className="pc-warn">
              <Icon name="warning" /> Mod 是第三方开发者写的扩展，可以给 AI 加工具、在对话里插手、调用模型。它的代码<b>和 sikeoop 本身有同样的权限</b>，只装你信任的作者的 mod。
            </p>
            <div className="st-inline">
              <button type="button" className="send" onClick={() => void pick("zip", false)}>
                从压缩包安装
              </button>
              <button type="button" className="mini-btn" onClick={() => void pick("folder", false)}>
                从文件夹安装
              </button>
              <span className="spacer" />
              <button type="button" className="link-btn" title="直接加载文件夹，改了代码点刷新就生效" onClick={() => void pick("folder", true)}>
                开发者：链接文件夹
              </button>
            </div>
            {error && <div className="err">{error}</div>}
            {preview && (
              <div className="pc-preview">
                <div className="pc-card-title">
                  <span className="pc-name">{preview.manifest.name}</span>
                  <Tag>v{preview.manifest.version}</Tag>
                  {preview.exists && <Tag tone="warn">已安装，会替换</Tag>}
                  {dev && <Tag>开发模式</Tag>}
                </div>
                <p className="hint">
                  {preview.manifest.description || "（没有介绍）"}
                  {preview.manifest.author ? ` · 作者 ${preview.manifest.author}` : ""} · {preview.files} 个文件
                </p>
                <div className="pc-detail-title">它申请的权限</div>
                <ul className="pc-perms">
                  {preview.manifest.permissions.length === 0 && <li className="hint">不需要任何权限</li>}
                  {preview.manifest.permissions.map((p) => (
                    <li key={p} className={PERMISSION_LABEL[p].risky ? "risky" : undefined}>
                      <Icon name={PERMISSION_LABEL[p].risky ? "warning" : "check"} />
                      {PERMISSION_LABEL[p].text}
                    </li>
                  ))}
                </ul>
                {preview.errors.map((e) => (
                  <div key={e} className="err">
                    {e}
                  </div>
                ))}
                <div className="st-inline">
                  <span className="hint">权限是作者的声明，sikeoop 只能管住它通过接口做的事。</span>
                  <span className="spacer" />
                  <button type="button" className="mini-btn" onClick={() => setPreview(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="send"
                    disabled={preview.errors.length > 0}
                    onClick={() =>
                      void run(window.sweet.installMod(preview.id, dev)).then(() => {
                        setPreview(null);
                        setAdding(false);
                      })
                    }
                  >
                    信任并安装
                  </button>
                </div>
              </div>
            )}
          </AddPanel>
        )}
        {!adding && error && <div className="err">{error}</div>}

        {!mods ? (
          <Empty>读取中…</Empty>
        ) : (
          <Group title="已安装的 Mod" count={visible.length}>
            {visible.length === 0 ? (
              <Empty>{mods.length ? "没有符合条件的 Mod。" : "还没有安装 Mod。开发者可以看 docs/mod-dev.md 写一个。"}</Empty>
            ) : (
              <ul className="pc-list">
                {visible.map((m) => (
                  <ItemCard
                    key={m.id}
                    label={m.name}
                    name={m.name}
                    off={!m.enabled || m.status === "changed"}
                    status={<StatusBadge tone={MOD_STATUS[m.status].tone}>{MOD_STATUS[m.status].text}</StatusBadge>}
                    tags={
                      <>
                        <Tag>v{m.version}</Tag>
                        {m.dev && <Tag tone="accent">开发模式</Tag>}
                        {m.status === "running" && m.tools.length + m.hooks.length > 0 && (
                          <Tag>
                            {m.tools.length} 个工具 · {m.hooks.length} 个 hook
                          </Tag>
                        )}
                      </>
                    }
                    desc={m.description || "（没有介绍）"}
                    meta={m.author ? `作者 ${m.author}` : undefined}
                    notes={
                      <>
                        {m.status === "changed" && <p className="pc-note warn-text">安装后它的文件被改过，没有加载。确认是你信任的改动后，重新打开开关。</p>}
                        {m.error && <p className="pc-note warn-text">{m.error}</p>}
                      </>
                    }
                    control={
                      <Switch
                        checked={m.enabled && m.status !== "changed"}
                        onChange={(v) => void run(window.sweet.setModEnabled(m.id, v))}
                        label={m.status === "changed" ? `启用 ${m.name}（打开 = 接受改动后的文件）` : `启用 ${m.name}`}
                      />
                    }
                    menu={[
                      ...(m.dev ? [{ label: "重新加载代码", icon: "refresh", onClick: () => void run(window.sweet.reloadMod(m.id)) }] : []),
                      { label: "删除", icon: "trash", danger: true, onClick: () => void run(window.sweet.removeMod(m.id)) },
                    ]}
                    details={
                      <>
                        <p className="pc-note" title={m.dir}>
                          位置：<code>{m.dir}</code>
                        </p>
                        {m.tools.length + m.hooks.length === 0 ? (
                          <p className="pc-note">{m.status === "running" ? "它没有注册工具或 hook。" : "运行后，这里会列出它注册的工具和 hook。"}</p>
                        ) : (
                          <ul className="pc-tools">
                            {m.tools.map((t) => (
                              <li key={t}>
                                <code>{t}</code>
                              </li>
                            ))}
                            {m.hooks.map((h, i) => (
                              <li key={`${h}${i}`}>
                                <span>hook：{EVENT_LABEL[h] ?? h}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    }
                  />
                ))}
              </ul>
            )}
          </Group>
        )}
      </div>
    </div>
  );
}
