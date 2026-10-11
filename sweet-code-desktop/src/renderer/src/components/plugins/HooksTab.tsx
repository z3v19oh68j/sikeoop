import { useEffect, useState } from "react";
import type { ContextSettings, HooksState } from "@shared/types";
import { Icon } from "../Icon";
import { StatusBadge, Switch, cleanError } from "../settings/ui";
import { AddPanel, Empty, Group, ItemCard, Tag, Toolbar, matches } from "./ui";

export const EVENT_LABEL: Record<string, string> = {
  SessionStart: "新对话开始",
  UserPromptSubmit: "发消息前",
  PreToolUse: "工具运行前",
  PostToolUse: "工具运行后",
  Stop: "AI 停下时",
};

/** Which context setting turns each built-in hook on and off. */
const BUILTIN_SETTING: Record<string, keyof ContextSettings> = { rules: "rules", memory: "memory", recall: "autoRecall", rag: "autoContext" };
/** Built-ins without a setting of their own: they follow another built-in's switch. */
const FOLLOWS: Record<string, string> = { "recent-session": "长期记忆" };

const EXAMPLE = `{
  "hooks": {
    "PostToolUse": [
      { "matcher": "edit_file|create_file", "command": "npx prettier --write \\"$(jq -r .tool_input.path)\\"" }
    ],
    "PreToolUse": [
      { "matcher": "run_command", "command": "grep -q 'rm -rf' && { echo '不许 rm -rf' >&2; exit 2; } || true" }
    ]
  }
}`;

type F = "all" | "on" | "builtin" | "mine";
const FILTERS: { id: F; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "on", label: "已开启" },
  { id: "builtin", label: "内置" },
  { id: "mine", label: "我加的" },
];

export function HooksTab({ onOpenFile }: { onOpenFile(path: string): void }) {
  const [state, setState] = useState<HooksState | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<F>("all");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void window.sweet.getHooks().then(setState);
  }, []);

  async function run(fn: () => Promise<void>) {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(cleanError(e));
    }
  }

  async function toggleBuiltin(id: string, on: boolean) {
    await window.sweet.setContextSettings({ [BUILTIN_SETTING[id]]: on });
    setState(await window.sweet.getHooks());
  }

  const toolbar = (
    <Toolbar<F>
      query={query}
      onQuery={setQuery}
      placeholder="搜索 hook 名称或命令"
      filters={FILTERS}
      filter={filter}
      onFilter={setFilter}
      addLabel="添加 Hook"
      adding={adding}
      onAdd={() => setAdding(!adding)}
    />
  );
  if (!state)
    return (
      <div className="pc-tab">
        {toolbar}
        <div className="pc-scroll">
          <Empty>读取中…</Empty>
        </div>
      </div>
    );

  const userSrc = state.sources.find((s) => s.kind === "user");
  const hasProjectFile = state.sources.some((s) => s.kind === "project");
  const builtins = state.builtins.filter((b) => matches(query, b.name, b.description) && (filter === "all" || filter === "builtin" || (filter === "on" && b.enabled)));
  const sources = filter === "builtin" ? [] : state.sources.filter((s) => filter !== "on" || s.trusted);
  const openProjectFile = () => void run(async () => onOpenFile((await window.sweet.openHooksFile("project")).projectPath!));

  return (
    <div className="pc-tab">
      {toolbar}
      <div className="pc-scroll">
        {adding && (
          <AddPanel title="添加 Hook" onClose={() => setAdding(false)}>
            <p className="hint">
              Hooks 在 AI 工作的固定时刻自动运行：新对话开始、发消息前、工具运行前后、AI 停下时。可以用来补充信息、拦下危险操作、改完文件自动格式化、没测通就让 AI 接着修。
              格式和 Claude Code 的 hooks 一样，能直接拿来用。
            </p>
            <div className="st-inline">
              {userSrc && (
                <button type="button" className="send" onClick={() => void run(async () => setState((await window.sweet.openHooksFile("user")).state))}>
                  {userSrc.exists ? "编辑我的 Hooks 文件" : "新建我的 Hooks 文件"}
                </button>
              )}
              {state.hasProject && !hasProjectFile && (
                <button type="button" className="mini-btn" onClick={openProjectFile}>
                  给这个项目添加 Hooks（.sweet/hooks.json）
                </button>
              )}
            </div>
            <details className="st-disclosure">
              <summary>
                <Icon name="chevron-right" /> 怎么写 Hook
              </summary>
              <div className="hint pc-guide">
                <span>每个 hook 是一条 bash 命令，在项目文件夹里运行，事件的内容以 JSON 从标准输入传进去（tool_name、tool_input、prompt 等）。</span>
                <span>
                  <b>退出码 2</b>：拦下（工具运行前 = 不让运行；发消息前 = 不发；AI 停下时 = 让它接着做），标准错误输出就是理由，会告诉 AI。
                  <b>退出码 0</b>：标准输出里的文字会作为补充信息给 AI，也可以输出 JSON（additionalContext、decision、hookSpecificOutput.permissionDecision）。
                </span>
                <span>matcher 匹配工具名，可以写 run_command、edit_file，也可以写 Claude Code 的 Bash、Edit|Write。</span>
              </div>
              <pre className="cmd-output">{EXAMPLE}</pre>
            </details>
          </AddPanel>
        )}
        {error && <div className="err">{error}</div>}

        {filter !== "mine" && (
          <Group title="内置" count={builtins.length} note={<p className="pc-group-note">sikeoop 自带的 hook，第一次用到时才加载。</p>}>
            {builtins.length ? (
              <ul className="pc-list">
                {builtins.map((b) => (
                  <ItemCard
                    key={b.id}
                    label={b.name}
                    name={b.name}
                    off={!b.enabled}
                    tags={b.events.map((e) => (
                      <Tag key={e}>{EVENT_LABEL[e]}</Tag>
                    ))}
                    desc={b.description}
                    notes={FOLLOWS[b.id] && <p className="pc-note">跟随「{FOLLOWS[b.id]}」开关，这里不用单独设置。</p>}
                    control={
                      <Switch checked={b.enabled} disabled={!BUILTIN_SETTING[b.id]} onChange={(v) => void run(() => toggleBuiltin(b.id, v))} label={FOLLOWS[b.id] ? `${b.name}（跟随「${FOLLOWS[b.id]}」开关）` : `开启 ${b.name}`} />
                    }
                  />
                ))}
              </ul>
            ) : (
              <Empty>没有符合条件的内置 hook。</Empty>
            )}
          </Group>
        )}

        {sources.map((src) => {
          const hooks = src.hooks.filter((h) => matches(query, h.command, h.matcher, EVENT_LABEL[h.event]));
          const projectHooksFile = src.path.endsWith("hooks.json");
          return (
            <Group
              key={src.path}
              title={src.label}
              count={src.hooks.length}
              action={
                src.kind === "user" ? (
                  <button type="button" className="mini-btn" onClick={() => void run(async () => setState((await window.sweet.openHooksFile("user")).state))}>
                    {src.exists ? "编辑" : "新建"}
                  </button>
                ) : (
                  <>
                    <button type="button" className="mini-btn" onClick={openProjectFile} disabled={!projectHooksFile}>
                      在编辑器里打开
                    </button>
                    {src.trusted ? (
                      <button type="button" className="mini-btn" onClick={() => void run(async () => setState(await window.sweet.trustHooks(src.path, false)))}>
                        取消信任
                      </button>
                    ) : (
                      src.hooks.length > 0 && (
                        <button type="button" className="send" onClick={() => void run(async () => setState(await window.sweet.trustHooks(src.path, true)))}>
                          信任并启用
                        </button>
                      )
                    )}
                  </>
                )
              }
              note={
                <>
                  <p className="pc-group-note pc-path" title={src.path}>
                    {src.kind === "project" &&
                      (src.trusted ? <StatusBadge tone="ok">已信任</StatusBadge> : src.hooks.length > 0 ? <StatusBadge tone="warn">未信任，没启用</StatusBadge> : null)}
                    <code>{src.path}</code>
                  </p>
                  {src.kind === "project" && !src.trusted && src.hooks.length > 0 && (
                    <p className="pc-warn">
                      <Icon name="warning" /> 这个文件跟着项目来，里面的命令会在你的电脑上运行，所以默认不启用。看清楚下面每条命令再点「信任并启用」；文件改动后需要重新信任。
                    </p>
                  )}
                  {src.error && <p className="err-text">{src.error}</p>}
                </>
              }
            >
              {src.hooks.length === 0 ? (
                <Empty>{src.exists ? "里面还没有 hook。" : "还没有这个文件。"}</Empty>
              ) : hooks.length === 0 ? (
                <Empty>没有符合条件的 hook。</Empty>
              ) : (
                <ul className="pc-list">
                  {hooks.map((h, i) => (
                    <ItemCard
                      key={i}
                      label={EVENT_LABEL[h.event] ?? h.event}
                      name={EVENT_LABEL[h.event] ?? h.event}
                      off={!src.trusted}
                      tags={h.matcher ? <Tag title="匹配的工具名">{h.matcher}</Tag> : <Tag>所有工具</Tag>}
                      desc={`$ ${h.command}`}
                      mono
                      meta={`最多运行 ${h.timeout} 秒`}
                    />
                  ))}
                </ul>
              )}
            </Group>
          );
        })}

        {filter !== "builtin" && state.hasProject && !hasProjectFile && (
          <button type="button" className="mini-btn pc-self-start" onClick={openProjectFile}>
            <Icon name="plus" /> 给这个项目添加 Hooks（.sweet/hooks.json）
          </button>
        )}
      </div>
    </div>
  );
}
