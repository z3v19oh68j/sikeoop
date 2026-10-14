import { useEffect, useState } from "react";
import type { DictationView, SnipGestureState, VoiceSettings } from "@shared/types";
import { loadSoundSettings, playSound, saveSoundSettings } from "../../sounds";
import { Icon } from "../Icon";
import { IS_MAC, SectionHead, SettingRow, StatusBadge, Switch, cleanError } from "./ui";

/** 界面与输入: the Dynamic Island, sounds, talking instead of typing, and the screenshot shortcut. */
export function InterfaceSection() {
  return (
    <div className="st-section">
      <SectionHead title="界面与输入" desc="灵动岛、提示音，以及用说话、截图代替打字的方式。" />
      <IslandRow />
      <SoundRow />
      <VoiceRow />
      <DictationRow />
      <SnipRow />
      <UninstallRow />
    </div>
  );
}

/** Removes the app; the main process asks first (and whether the data goes too). */
function UninstallRow() {
  const [why, setWhy] = useState("");
  return (
    <SettingRow
      icon="trash"
      title="卸载 sikeoop"
      desc="会先问你一遍，并让你选要不要同时删除对话、设置和密钥。项目文件夹不会被动到。"
      status={why && <StatusBadge tone="warn">{why}</StatusBadge>}
      control={
        <button type="button" className="mini-btn" onClick={() => void window.sweet.uninstallApp().then(setWhy)}>
          卸载…
        </button>
      }
    />
  );
}

/** The Dynamic Island switch (also in the tray menu). */
function IslandRow() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    void window.sweet.islandEnabled().then(setOn);
  }, []);
  if (on === null) return null;
  return (
    <SettingRow
      icon="sparkle"
      title="灵动岛"
      desc="在屏幕正上方显示一个小胶囊：AI 在做什么、什么时候做完，一眼就能看到。"
      control={<Switch checked={on} onChange={(v) => void window.sweet.setIslandEnabled(v).then(setOn)} label="灵动岛" />}
    />
  );
}

/** Sound effects: on/off, volume, and a preview. Saved on this computer. */
function SoundRow() {
  const [s, setS] = useState(loadSoundSettings);
  const update = (change: Partial<typeof s>) => {
    const next = { ...s, ...change };
    setS(next);
    saveSoundSettings(next);
  };
  return (
    <SettingRow
      icon="play"
      title="提示音"
      desc="AI 做完、等你确认、出错时轻轻响一下。"
      control={<Switch checked={s.enabled} onChange={(enabled) => update({ enabled })} label="提示音" />}
    >
      <div className={"st-inline st-sound" + (s.enabled ? "" : " off")}>
        <span className="st-mini-label">音量</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={s.volume}
          disabled={!s.enabled}
          aria-label="音量"
          onChange={(e) => update({ volume: Number(e.target.value) })}
        />
        <button type="button" className="mini-btn" disabled={!s.enabled} onClick={() => playSound("done", true)}>
          <Icon name="play" /> 试听
        </button>
      </div>
    </SettingRow>
  );
}

/** Voice input on the island: an OpenAI-compatible transcription endpoint and its key. */
function VoiceRow() {
  const [v, setV] = useState<VoiceSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void window.sweet.voiceSettings().then((s) => {
      setV(s);
      setBaseUrl(s.baseUrl);
      setModel(s.model);
    });
  }, []);
  if (!v) return null;
  const save = async (change: Parameters<typeof window.sweet.setVoiceSettings>[0]) => {
    setError("");
    try {
      setV(await window.sweet.setVoiceSettings(change));
      setKey("");
    } catch (e) {
      setError(cleanError(e));
    }
  };
  const dirty = baseUrl !== v.baseUrl || model !== v.model || !!key.trim();
  return (
    <SettingRow
      icon="chat-plus"
      title="语音输入"
      desc={`按 ${IS_MAC ? "⌘⇧空格" : "Ctrl+Shift+空格"} 或点灵动岛上的 🎤 开始说话，再按一次或点「说完了」，识别出的文字直接发给 AI。`}
      status={
        v.hasKey ? (
          <StatusBadge tone="ok">已设置 Key</StatusBadge>
        ) : v.sharedKey ? (
          <StatusBadge tone="ok">用 MiMo 的 Key</StatusBadge>
        ) : (
          <StatusBadge tone="warn">还没填 Key</StatusBadge>
        )
      }
    >
      <details className="st-disclosure" open={!v.hasKey && !v.sharedKey}>
        <summary>
          <Icon name="chevron-right" /> 识别服务与 Key
        </summary>
        <div className="st-inline">
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://token-plan-cn.xiaomimimo.com/v1" aria-label="接口地址" autoComplete="off" />
          <input className="st-narrow" value={model} onChange={(e) => setModel(e.target.value)} placeholder="mimo-v2.5-asr" aria-label="模型" autoComplete="off" />
        </div>
        <div className="st-inline">
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={v.hasKey ? "已保存。填新的会替换" : v.sharedKey ? "留空就用 MiMo 的 Key" : "粘贴语音识别的 API Key"}
            autoComplete="off"
            aria-label="语音识别的 API Key"
          />
          <button type="button" className="mini-btn" disabled={!dirty} onClick={() => void save({ baseUrl, model, ...(key.trim() ? { key } : {}) })}>
            保存
          </button>
          {v.hasKey && (
            <button type="button" className="mini-btn" onClick={() => void save({ clearKey: true })}>
              <Icon name="trash" /> 删除 Key
            </button>
          )}
        </div>
        <p className="hint">
          默认用 MiMo 的 mimo-v2.5-asr，直接用你 MiMo 的 Key，不用另外填。也可以换成任何 OpenAI 兼容的 /audio/transcriptions 接口，比如 OpenAI（whisper-1）、SiliconFlow（FunAudioLLM/SenseVoiceSmall），那样要填它自己的 Key。
        </p>
        {error && <p className="err-text">{error}</p>}
      </details>
    </SettingRow>
  );
}

/** Dictation anywhere: hold a key, talk, the text is typed where the cursor is. */
function DictationRow() {
  const [d, setD] = useState<DictationView | null>(null);
  useEffect(() => {
    void window.sweet.dictation().then(setD);
    // Granted in System Settings while this is open: it turns green by itself.
    return window.sweet.onDictationChange(setD);
  }, []);
  if (!d) return null;
  const keyLabel = d.keys.find((k) => k.id === d.key)?.label;
  const needsGrant = d.enabled && (!d.running || d.mic === "denied");
  return (
    <SettingRow
      icon="sparkle"
      title="随处语音输入"
      desc={`在任何软件的输入框里，按住「${keyLabel}」说话，松开后说的话会自动打进去。按 Esc 取消。`}
      status={
        !d.enabled ? (
          <StatusBadge tone="muted">没开</StatusBadge>
        ) : needsGrant ? (
          <StatusBadge tone="warn">需要授权</StatusBadge>
        ) : (
          <StatusBadge tone="ok">可以用</StatusBadge>
        )
      }
      control={<Switch checked={d.enabled} onChange={(v) => void window.sweet.setDictation(v).then(setD)} label="随处语音输入" />}
    >
      <div className={"st-inline" + (d.enabled ? "" : " off")}>
        <span className="st-mini-label">快捷键</span>
        <select
          className="st-select"
          value={d.key}
          disabled={!d.enabled}
          aria-label="按住哪个键说话"
          onChange={(e) => void window.sweet.setDictationKey(e.target.value as DictationView["key"]).then(setD)}
        >
          {d.keys.map((k) => (
            <option key={k.id} value={k.id}>
              按住 {k.label}
            </option>
          ))}
        </select>
        {needsGrant && (
          <button type="button" className="mini-btn" onClick={() => void window.sweet.grantDictation().then(setD)}>
            一键授权
          </button>
        )}
      </div>
      {!IS_MAC && <p className="hint">以管理员身份运行的窗口（比如管理员命令行）Windows 不允许别的程序往里输入，这类窗口里用不了。</p>}
      {d.enabled && d.mic === "denied" && <p className="err-text">麦克风被系统关掉了，点「一键授权」打开系统的麦克风设置。</p>}
      {d.enabled && d.error && <p className="err-text">{d.error}</p>}
    </SettingRow>
  );
}

/** The screenshot shortcut: capture an area, ask the vision model about it in the island. */
function SnipRow() {
  const [s, setS] = useState<{ accelerator: string; enabled: boolean; error?: string } | null>(null);
  useEffect(() => {
    void window.sweet.snipShortcut().then(setS);
  }, []);
  if (!s) return null;
  const keys = s.accelerator
    .replace("CommandOrControl", IS_MAC ? "⌘" : "Ctrl")
    .replace("Shift", IS_MAC ? "⇧" : "Shift")
    .replace(/\+/g, IS_MAC ? "" : "+");
  return (
    <SettingRow
      icon="eye-search"
      title={
        <>
          截图问 AI <kbd>{keys}</kbd>
        </>
      }
      desc="按快捷键框选屏幕的一块，在灵动岛上直接问识图模型。截下的图也可以同时复制，直接粘贴到聊天软件里。"
      status={s.error ? <StatusBadge tone="warn">{s.error}</StatusBadge> : undefined}
      control={<Switch checked={s.enabled} onChange={(v) => void window.sweet.setSnipShortcut(v).then(setS)} label="截图问 AI" />}
    >
      <SnipCopyRow />
      <SnipGestureRow />
    </SettingRow>
  );
}

/** Every screenshot also goes to the clipboard as an image. */
function SnipCopyRow() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    void window.sweet.snipCopy().then(setOn);
  }, []);
  if (on === null) return null;
  return (
    <div className="st-subrow">
      <div className="st-subrow-main">
        <div className="st-row-text">
          <div className="st-row-title">
            <span>截图后自动复制图片</span>
          </div>
          <p className="st-row-desc">截完就在剪贴板里，可以直接粘贴到微信、QQ、飞书或文档里。不想问 AI 的话，截完关掉灵动岛的卡片就行。</p>
        </div>
        <Switch checked={on} onChange={(v) => void window.sweet.setSnipCopy(v).then(setOn)} label="截图后自动复制图片" />
      </div>
    </div>
  );
}

/** Four trackpad clicks (macOS) or a mouse side button (Windows) also start a screenshot. */
function SnipGestureRow() {
  const [g, setG] = useState<SnipGestureState | null>(null);
  useEffect(() => {
    void window.sweet.snipGesture().then(setG);
  }, []);
  if (!g) return null;
  return (
    <div className="st-subrow">
      <div className="st-subrow-main">
        <div className="st-row-text">
          <div className="st-row-title">
            <span>{g.kind === "quadClick" ? "触控板连点 4 下也能截图" : "鼠标侧键也能截图"}</span>
            {g.error && <StatusBadge tone="warn">{g.error}</StatusBadge>}
          </div>
          <p className="st-row-desc">
            {g.kind === "quadClick"
              ? "在同一个位置快速点 4 下。这 4 下也会照常点到下面的软件上。"
              : "按下侧键时浏览器等软件也会照常响应（比如后退），所以默认用前进键。"}
          </p>
        </div>
        <Switch
          checked={g.enabled}
          onChange={(v) => void window.sweet.setSnipGesture({ enabled: v }).then(setG)}
          label={g.kind === "quadClick" ? "触控板连点 4 下截图" : "鼠标侧键截图"}
        />
      </div>
      {g.kind === "sideButton" && (
        <select
          className="st-select"
          value={g.sideButton}
          disabled={!g.enabled}
          aria-label="用哪个侧键"
          onChange={(e) => void window.sweet.setSnipGesture({ sideButton: Number(e.target.value) === 4 ? 4 : 5 }).then(setG)}
        >
          <option value={5}>前进键（靠前的那个）</option>
          <option value={4}>后退键（靠后的那个）</option>
        </select>
      )}
    </div>
  );
}
