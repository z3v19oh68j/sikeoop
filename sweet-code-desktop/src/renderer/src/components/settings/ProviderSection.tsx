import { useEffect, useRef, useState } from "react";
import type { AnthropicLogin, AuthMode, Balance, ProvidersState, ProviderView } from "@shared/types";
import { runInTerminal } from "../TerminalPanel";
import { Icon } from "../Icon";
import { FreeModels } from "./FreeModels";
import { Field, IS_WIN, SectionHead, StatusBadge, cleanError, isReady } from "./ui";

/** What a provider still lacks, in words; "" when it is ready. */
function missing(p: ProviderView): string {
  if (!p.baseURL) return "缺接口地址";
  if (p.authMode === "login" ? !p.login?.loggedIn : p.needsKey && !p.hasKey) return p.authMode === "login" ? "还没登录" : "还没填 Key";
  if (!p.model) return "还没选模型";
  return "";
}

/** 使用中 / 已配好 / 未配置, the same everywhere in this section. */
function providerStatus(p: ProviderView, activeId: string) {
  if (p.id === activeId) return { cls: "active", label: "使用中" };
  return isReady(p) ? { cls: "ready", label: "已配好" } : { cls: "", label: "未配置" };
}

interface Props {
  state: ProvidersState;
  selectedId: string;
  onSelect(id: string): void;
  onClose(): void;
  onChange(s: ProvidersState, switched: boolean): void;
}

/** 模型服务商: the providers on the left, the picked one's Key, model and address on the right. */
export function ProviderSection({ state, selectedId, onSelect, onClose, onChange }: Props) {
  const selected = state.providers.find((p) => p.id === selectedId) ?? state.providers.find((p) => p.id === state.activeId)!;

  const [baseURL, setBaseURL] = useState(selected.baseURL);
  const [model, setModel] = useState(selected.model);
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>(selected.authMode);
  /** Custom providers: their name and protocol. */
  const [name, setName] = useState(selected.name);
  const [kind, setKind] = useState(selected.kind);
  /** More models this key can use, one per line: each can join a group chat. */
  const [groupModels, setGroupModels] = useState(selected.models.join("\n"));

  // Load the form whenever another provider is picked in the list.
  useEffect(() => {
    setBaseURL(selected.baseURL);
    setModel(selected.model);
    setApiKey("");
    setModels([]);
    setError("");
    setSavedNote(false);
    setAuthMode(selected.authMode);
    setName(selected.name);
    setKind(selected.kind);
    setGroupModels(selected.models.join("\n"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.id]);

  // Only Claude itself has an account login (compatible services report no login status).
  const loginMode = !!selected.login && authMode === "login";

  // While the login panel is open, check every 2s so it turns green as soon as `ant auth login` finishes.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (!loginMode) return;
    const t = setInterval(() => void window.sweet.getProviders().then((s) => onChangeRef.current(s, false)), 2000);
    return () => clearInterval(t);
  }, [loginMode]);

  function terminal(cmd: string) {
    if (!runInTerminal(cmd)) setError("先打开一个项目文件夹，下面的终端才能用。也可以在系统自带的终端里运行：" + cmd);
  }

  const isActive = selected.id === state.activeId;
  const options = [...new Set([...selected.suggestedModels, ...models])];
  const lack = missing(selected);

  /** Save the form. With `use`, also make it the active provider and close (the original 「保存」). */
  async function save(use: boolean) {
    setError("");
    setSavedNote(false);
    setSaving(true);
    try {
      let s = await window.sweet.updateProvider({
        id: selected.id,
        baseURL,
        model,
        authMode,
        apiKey: loginMode ? undefined : apiKey || undefined,
        models: groupModels.split(/[\n,，]/),
        ...(selected.custom ? { name, kind } : {}),
      });
      const p = s.providers.find((x) => x.id === selected.id)!;
      setApiKey("");
      if (!isReady(p)) {
        onChange(s, isActive);
        setError(
          !p.model
            ? "还差一步：选一个模型。"
            : !p.baseURL
              ? "还差一步：填接口地址。"
              : loginMode
                ? "还差一步：用 Anthropic 账号登录。"
                : "还差一步：填 API Key。",
        );
        return;
      }
      if (!use) {
        onChange(s, isActive);
        setSavedNote(true);
        return;
      }
      if (!isActive) s = await window.sweet.setActiveProvider(selected.id);
      onChange(s, true);
      onClose();
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setSaving(false);
    }
  }

  async function fetchModels() {
    setError("");
    setLoadingModels(true);
    try {
      // Save first so the lookup uses the key and URL currently in the form.
      onChange(await window.sweet.updateProvider({ id: selected.id, baseURL, authMode, apiKey: loginMode ? undefined : apiKey || undefined }), isActive);
      setApiKey("");
      const list = await window.sweet.listModels(selected.id);
      setModels(list);
      if (!list.length) setError("这个服务商没有返回任何模型，手动填模型名称吧。");
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setLoadingModels(false);
    }
  }

  async function addCustom() {
    setError("");
    try {
      const res = await window.sweet.addCustomProvider("openai");
      onChange(res.state, false);
      onSelect(res.id);
    } catch (e) {
      setError(cleanError(e));
    }
  }

  async function removeCustom() {
    if (!window.confirm(`删除「${selected.name}」？它的地址、模型和 Key 都会删掉。`)) return;
    const s = await window.sweet.removeCustomProvider(selected.id);
    onChange(s, selected.id === state.activeId);
    onSelect(s.activeId);
  }

  async function clearKey() {
    onChange(await window.sweet.clearProviderKey(selected.id), isActive);
  }

  const keyBlocked = !state.canEncrypt && Boolean(apiKey);

  return (
    <div className="st-section st-providers">
      <SectionHead title="模型服务商" desc="AI 背后是哪家的模型。选一家，填上它的 Key 和模型，再点「设为当前使用」。" />

      <FreeModels state={state} onChange={(s) => onChange(s, false)} onUse={(s) => onChange(s, true)} />

      <div className="st-provider-layout">
        <div className="st-provider-side">
          <ul className="st-provider-list" role="listbox" aria-label="服务商">
            {state.providers.filter((p) => !p.builtinFree).map((p) => {
              const st = providerStatus(p, state.activeId);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={p.id === selected.id}
                    className={"st-provider-item" + (p.id === selected.id ? " selected" : "")}
                    onClick={() => onSelect(p.id)}
                    title={`${p.name}：${st.label}`}
                  >
                    <span className={"st-pdot " + st.cls} aria-hidden="true" />
                    <span className="pname">{p.name}</span>
                    {st.cls === "active" && <span className="st-using">使用中</span>}
                  </button>
                </li>
              );
            })}
            <li>
              <button type="button" className="st-provider-item add" onClick={() => void addCustom()}>
                <Icon name="plus" />
                <span className="pname">添加自定义服务商</span>
              </button>
            </li>
          </ul>
          <p className="st-legend" aria-hidden="true">
            <span><span className="st-pdot active" /> 使用中</span>
            <span><span className="st-pdot ready" /> 已配好</span>
            <span><span className="st-pdot" /> 未配置</span>
          </p>
        </div>

        <form
          className="st-provider-detail"
          onSubmit={(e) => {
            e.preventDefault();
            void save(true);
          }}
        >
          <div className="st-detail-head">
            <div className="st-detail-title">
              <h4>{selected.name}</h4>
              {isActive ? (
                lack ? <StatusBadge tone="warn">{lack}</StatusBadge> : <StatusBadge tone="ok">可以用</StatusBadge>
              ) : lack ? (
                <StatusBadge tone="muted">未配置 · {lack}</StatusBadge>
              ) : (
                <StatusBadge tone="ok">已配好</StatusBadge>
              )}
            </div>
            {isActive ? (
              <span className="st-using-pill">
                <Icon name="check" /> 正在使用
              </span>
            ) : (
              <button type="submit" className="send st-use-btn" disabled={saving || keyBlocked}>
                设为当前使用
              </button>
            )}
          </div>
          {!loginMode && selected.keyHint && <p className="hint">{selected.keyHint}</p>}

          {selected.custom && (
            <Field label="名称" htmlFor="pv-name">
              <div className="st-inline">
                <input id="pv-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="比如：我的中转站" autoComplete="off" />
                <button type="button" className="mini-btn" onClick={() => void removeCustom()}>
                  <Icon name="trash" /> 删除这个服务商
                </button>
              </div>
              <div className="seg" role="radiogroup" aria-label="接口协议">
                {(["openai", "anthropic"] as const).map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? "on" : undefined} onClick={() => setKind(k)}>
                    {k === "openai" ? "OpenAI 兼容" : "Anthropic 兼容"}
                  </button>
                ))}
              </div>
            </Field>
          )}

          {selected.login && (
            <Field label="登录方式">
              <div className="seg" role="radiogroup" aria-label="登录方式">
                {(["api_key", "login"] as const).map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={authMode === m} className={authMode === m ? "on" : undefined} onClick={() => setAuthMode(m)}>
                    {m === "api_key" ? "API Key" : "Anthropic 账号登录"}
                  </button>
                ))}
              </div>
            </Field>
          )}

          {loginMode && selected.login && <LoginPanel login={selected.login} run={terminal} />}

          {selected.needsKey && !loginMode && (
            <Field
              label={
                <>
                  <Icon name="key" /> API Key
                </>
              }
              htmlFor="pv-key"
              extra={
                selected.keySource === "saved" ? (
                  <StatusBadge tone="ok">已保存</StatusBadge>
                ) : selected.keySource === "env" ? (
                  <StatusBadge tone="ok">用环境变量</StatusBadge>
                ) : (
                  <StatusBadge tone="warn">还没填</StatusBadge>
                )
              }
            >
              <div className="st-inline">
                <input
                  id="pv-key"
                  type="password"
                  value={apiKey}
                  placeholder={
                    selected.keySource === "saved"
                      ? "已保存。留空就不修改"
                      : selected.keySource === "env"
                        ? "正在用环境变量里的 Key。填了就改用这个"
                        : "粘贴你的 Key"
                  }
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                />
                {selected.keySource === "saved" && (
                  <button type="button" className="mini-btn" onClick={() => void clearKey()}>
                    删除已保存的 Key
                  </button>
                )}
              </div>
            </Field>
          )}

          <Field
            label="模型"
            htmlFor="pv-model"
            hint={
              <>
                {models.length > 0 && `找到 ${models.length} 个模型，点输入框就能选。`}
                {selected.kind === "openai" && "要选支持「工具调用 / function calling」的模型，AI 才能读你的文件。"}
              </>
            }
          >
            <div className="st-inline">
              <input
                id="pv-model"
                list="pv-model-options"
                value={model}
                placeholder={options.length ? "从列表里选，或直接输入" : "点右边按钮获取，或直接输入"}
                onChange={(e) => setModel(e.target.value)}
                autoComplete="off"
              />
              <datalist id="pv-model-options">
                {options.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <button type="button" className="mini-btn" onClick={() => void fetchModels()} disabled={loadingModels}>
                <Icon name="refresh" /> {loadingModels ? "获取中…" : "获取模型列表"}
              </button>
            </div>
          </Field>

          {selected.hasBalance && selected.hasKey && <BalanceLine id={selected.id} />}

          {selected.openaiApi && (
            <Field label="调用方式" htmlFor="pv-api">
              <select
                id="pv-api"
                className="st-select"
                value={selected.openaiApi}
                onChange={(e) => {
                  const openaiApi = e.target.value as "responses" | "chat";
                  window.sweet
                    .updateProvider({ id: selected.id, openaiApi })
                    .then((s) => onChange(s, isActive))
                    .catch((err) => setError(cleanError(err)));
                }}
              >
                <option value="responses">Responses API（推荐，GPT 新模型）</option>
                <option value="chat">Chat Completions（兼容旧模型和国模）</option>
              </select>
            </Field>
          )}

          <details className="st-disclosure" open={!selected.baseURL}>
            <summary>
              <Icon name="chevron-right" /> 高级：接口地址
            </summary>
            <input id="pv-url" value={baseURL} placeholder="https://…/v1" onChange={(e) => setBaseURL(e.target.value)} autoComplete="off" aria-label="接口地址" />
            <p className="hint">
              {selected.kind === "anthropic" && !selected.login
                ? "使用 Anthropic 兼容协议。按服务商控制台给的专属地址填写。"
                : selected.kind === "anthropic"
                  ? "使用 Claude 官方 SDK。一般不用改，只有走代理时才需要。"
                  : "使用 OpenAI 兼容格式。地址一般以 /v1 结尾，以服务商文档为准。"}
            </p>
          </details>

          <details className="st-disclosure" open={selected.models.length > 0}>
            <summary>
              <Icon name="chevron-right" /> 群聊：这个 Key 还能用的其他模型
              {selected.models.length > 0 && <span className="st-count">{selected.models.length}</span>}
            </summary>
            <textarea
              className="st-textarea"
              rows={3}
              value={groupModels}
              onChange={(e) => setGroupModels(e.target.value)}
              placeholder={"一行一个模型名，例如：\ngpt-5.5\ngemini-3-pro\nqwen3-max"}
              aria-label="群聊可用模型"
            />
            <p className="hint">
              中转站一个 Key 能用多个模型时，把它们都写在这里，每个都能作为一位群聊成员。
              {models.length > 0 && (
                <>
                  {" "}
                  <button type="button" className="link-btn" onClick={() => setGroupModels((t) => [...new Set([...t.split("\n").filter(Boolean), ...models])].join("\n"))}>
                    把获取到的 {models.length} 个模型都加进来
                  </button>
                </>
              )}
            </p>
          </details>

          {error && <div className="err">{error}</div>}
          {!state.canEncrypt && <div className="err">这台电脑的系统钥匙串不可用，没法安全保存 Key。可以改用环境变量。</div>}

          <div className="st-detail-foot">
            <span className="hint">
              {savedNote
                ? "已保存。"
                : isActive
                  ? "保存后，当前对话会用新设置接着做。"
                  : "切换后，当前对话交给它接着做，不用重新读文件。"}
            </span>
            <span className="spacer" />
            {isActive ? (
              <button type="submit" className="send" disabled={saving || keyBlocked}>
                {saving ? "保存中…" : "保存"}
              </button>
            ) : (
              <>
                <button type="button" className="mini-btn" disabled={saving || keyBlocked} onClick={() => void save(false)}>
                  只保存
                </button>
                <button type="submit" className="send" disabled={saving || keyBlocked}>
                  保存并使用 {selected.name}
                </button>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

/** "Log in with an Anthropic account" through the official ant CLI, run in the app's terminal. */
function LoginPanel({ login, run }: { login: AnthropicLogin; run(cmd: string): void }) {
  return (
    <div className="st-login">
      <p className="hint">
        用 Anthropic 开发者平台（Console）的账号登录，不用复制粘贴 Key。按 API 用量计费，和填 Key 一样；
        Claude Pro / Max 订阅不能在第三方应用里使用。
      </p>

      {login.loggedIn ? (
        <div className="st-login-state ok">
          <span>
            <Icon name="check-circle" /> 已登录{login.account ? `：${login.account}` : ""}
          </span>
          {login.email && login.email !== login.account && <span className="hint">{login.email}</span>}
          <button type="button" className="link-btn" onClick={() => run("ant auth logout")}>
            退出登录
          </button>
        </div>
      ) : !login.antInstalled ? (
        <div className="st-login-state">
          <span>需要先安装 Anthropic 官方命令行工具 ant。</span>
          {IS_WIN ? (
            <span className="hint">
              到{" "}
              <a href="https://github.com/anthropics/anthropic-cli/releases" target="_blank" rel="noreferrer">
                github.com/anthropics/anthropic-cli/releases
              </a>{" "}
              下载 Windows 版，把 ant.exe 放到 PATH 里的文件夹，然后重启 sikeoop。
            </span>
          ) : (
            <>
              <code className="cmd">brew install anthropics/tap/ant</code>
              <button type="button" className="mini-btn" onClick={() => run('brew install anthropics/tap/ant && xattr -d com.apple.quarantine "$(brew --prefix)/bin/ant"')}>
                <Icon name="play" /> 在终端里安装
              </button>
              <span className="hint">需要 Homebrew。装好后这里会自动更新。</span>
            </>
          )}
        </div>
      ) : (
        <div className="st-login-state">
          <span>{login.expired ? "登录已经过期了，重新登录一次吧。" : "还没有登录。"}</span>
          <button type="button" className="send" onClick={() => run("ant auth login")}>
            在终端里登录
          </button>
          <span className="hint">会打开浏览器，登录 Console 账号并选一个工作区。登录完成后这里会自动变成「已登录」。</span>
        </div>
      )}
      {login.error && <span className="hint">读取登录信息时出错：{login.error}</span>}
    </div>
  );
}

/** Account balance, for providers that report it (DeepSeek). */
function BalanceLine({ id }: { id: string }) {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setBalance(null);
    setError("");
    window.sweet.getBalance(id).then(setBalance, (e) => setError(cleanError(e)));
  }, [id]);
  const sym = (c: string) => (c === "CNY" ? "¥" : c === "USD" ? "$" : `${c} `);
  return (
    <div className="st-balance">
      <span className="st-balance-label">余额</span>
      {error ? (
        <span className="warn-text">{error}</span>
      ) : !balance ? (
        <span className="hint">查询中…</span>
      ) : (
        <>
          <span className={balance.available ? "st-balance-value" : "st-balance-value warn-text"}>
            {balance.items.length ? balance.items.map((b) => `${sym(b.currency)}${b.total}（其中赠送 ${b.granted}）`).join("，") : "0"}
          </span>
          {!balance.available && <StatusBadge tone="warn">余额不足，去 platform.deepseek.com 充值</StatusBadge>}
        </>
      )}
    </div>
  );
}
