import { useEffect, useState } from "react";
import type { McpServerInput, McpServerView } from "@shared/types";
import { Icon } from "../Icon";
import { StatusBadge, Switch, cleanError, type Tone } from "../settings/ui";
import { AddPanel, Empty, Group, ItemCard, Tag, Toolbar, matches } from "./ui";

const MCP_EXAMPLE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"]
    }
  }
}`;

const STATUS: Record<McpServerView["status"], { text: string; tone: Tone }> = {
  off: { text: "已关闭", tone: "muted" },
  connecting: { text: "连接中…", tone: "accent" },
  connected: { text: "已连接", tone: "ok" },
  error: { text: "连接失败", tone: "bad" },
};

const TYPE_LABEL = (t: string) => (t === "stdio" ? "本地命令" : t === "sse" ? "远程 SSE" : "远程 HTTP");

type F = "all" | "on" | "error";
const FILTERS: { id: F; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "on", label: "已启用" },
  { id: "error", label: "连接失败" },
];

export function McpTab() {
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<F>("all");
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<McpServerInput[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void window.sweet.listMcp().then(setServers);
    return window.sweet.onMcpChanged(setServers);
  }, []);

  async function parse() {
    setError("");
    try {
      setParsed(await window.sweet.parseMcpConfig(text));
    } catch (e) {
      setParsed(null);
      setError(cleanError(e));
    }
  }

  async function add() {
    if (!parsed) return;
    try {
      setServers(await window.sweet.addMcpServers(parsed));
      setParsed(null);
      setText("");
      setAdding(false);
    } catch (e) {
      setError(cleanError(e));
    }
  }

  const visible = (servers ?? []).filter(
    (s) => matches(query, s.name, s.summary) && (filter === "all" || (filter === "on" ? s.enabled : s.status === "error")),
  );

  return (
    <div className="pc-tab">
      <Toolbar<F>
        query={query}
        onQuery={setQuery}
        placeholder="搜索服务名或命令"
        filters={FILTERS}
        filter={filter}
        onFilter={setFilter}
        addLabel="添加服务"
        adding={adding}
        onAdd={() => setAdding(!adding)}
      />
      <div className="pc-scroll">
        {adding && (
          <AddPanel title="添加 MCP 服务" onClose={() => setAdding(false)}>
            <p className="hint">粘贴 MCP 服务的 JSON 配置（Claude Desktop、Cursor、VS Code 的格式都可以）。</p>
            <textarea id="mcp-json" className="st-textarea pc-code" value={text} onChange={(e) => setText(e.target.value)} placeholder={MCP_EXAMPLE} />
            <div className="st-inline">
              <span className="spacer" />
              <button type="button" className="send" disabled={!text.trim()} onClick={() => void parse()}>
                解析
              </button>
            </div>
            {error && <div className="err">{error}</div>}
            {parsed && (
              <div className="pc-preview">
                <b>要添加 {parsed.length} 个服务</b>
                <ul className="pc-list">
                  {parsed.map((p) => {
                    const secrets = [...Object.keys(p.env ?? {}), ...Object.keys(p.headers ?? {})];
                    return (
                      <ItemCard
                        key={p.name}
                        label={p.name}
                        name={p.name}
                        tags={
                          <>
                            <Tag>{TYPE_LABEL(p.type)}</Tag>
                            {servers?.some((s) => s.name === p.name) && <Tag tone="warn">已存在，会覆盖</Tag>}
                          </>
                        }
                        desc={p.type === "stdio" ? [p.command, ...(p.args ?? [])].join(" ") : p.url}
                        mono
                        notes={
                          secrets.length > 0 && (
                            <p className="pc-note">
                              <Icon name="lock" /> 会加密保存：{secrets.join("、")}
                            </p>
                          )
                        }
                      />
                    );
                  })}
                </ul>
                <div className="st-inline">
                  <span className="hint">本地命令会在你的电脑上运行，和你自己在终端里运行它一样。</span>
                  <span className="spacer" />
                  <button type="button" className="mini-btn" onClick={() => setParsed(null)}>
                    取消
                  </button>
                  <button type="button" className="send" onClick={() => void add()}>
                    添加并连接
                  </button>
                </div>
              </div>
            )}
          </AddPanel>
        )}
        {!adding && error && <div className="err">{error}</div>}

        {!servers ? (
          <Empty>读取中…</Empty>
        ) : (
          <Group title="已添加的服务" count={visible.length}>
            {visible.length === 0 ? (
              <Empty>{servers.length ? "没有符合条件的服务。" : "还没有添加 MCP 服务。点右上角「添加服务」，粘贴它的 JSON 配置就行。"}</Empty>
            ) : (
              <ul className="pc-list">
                {visible.map((s) => (
                  <ItemCard
                    key={s.name}
                    label={s.name}
                    name={s.name}
                    off={!s.enabled}
                    status={<StatusBadge tone={STATUS[s.status].tone}>{STATUS[s.status].text}</StatusBadge>}
                    tags={
                      <>
                        <Tag>{TYPE_LABEL(s.type)}</Tag>
                        {s.status === "connected" && <Tag>{s.tools.length} 个工具</Tag>}
                        {s.trusted && (
                          <Tag tone="accent" title="它的工具不再一个个问你就直接运行">
                            已信任
                          </Tag>
                        )}
                      </>
                    }
                    desc={s.summary}
                    mono
                    notes={s.error && <p className="pc-note warn-text">{s.error}</p>}
                    control={
                      <Switch checked={s.enabled} onChange={(v) => void window.sweet.setMcpEnabled(s.name, v).then(setServers)} label={`启用 ${s.name}（关掉后断开连接，新对话里不再有它的工具）`} />
                    }
                    menu={[
                      { label: "重新连接", icon: "refresh", onClick: () => void window.sweet.reconnectMcp(s.name).then(setServers) },
                      { label: "删除", icon: "trash", danger: true, onClick: () => void window.sweet.removeMcpServer(s.name).then(setServers) },
                    ]}
                    details={
                      <>
                        <div className="pc-detail-row">
                          <div>
                            <div className="pc-detail-title">信任这个服务</div>
                            <p className="pc-detail-desc">信任后，它的工具不再一个个问你就直接运行。</p>
                          </div>
                          <Switch checked={s.trusted} onChange={(v) => void window.sweet.setMcpTrusted(s.name, v).then(setServers)} label={`信任 ${s.name}`} />
                        </div>
                        {s.secretKeys.length > 0 && (
                          <p className="pc-note">
                            <Icon name="lock" /> 已加密保存：{s.secretKeys.join("、")}
                          </p>
                        )}
                        {s.status === "connected" ? (
                          s.tools.length ? (
                            <ul className="pc-tools">
                              {s.tools.map((t) => (
                                <li key={t.name}>
                                  <code>{t.name}</code> <span>{t.description.slice(0, 140)}</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="pc-note">它没有提供工具。</p>
                          )
                        ) : (
                          <p className="pc-note">连上之后，这里会列出它提供的工具。</p>
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
