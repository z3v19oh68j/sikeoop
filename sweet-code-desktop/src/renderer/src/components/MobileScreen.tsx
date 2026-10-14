import { memo, useEffect, useState } from "react";
import QRCode from "qrcode";
import type { MobileGatewayState, MobilePairingQr } from "@shared/types";
import { Icon } from "./Icon";
import "../styles/mobile.css";

// The「手机」page: turn the phone gateway on, add a phone by QR code, allow or deny it, see and remove
// paired phones, and set the relay address (main/mobile/gateway.ts). The QR payload is held only in
// this component while it shows; it's never stored.

const RELAY: Record<MobileGatewayState["relay"]["status"], string> = {
  off: "未开启",
  connecting: "正在连中继…",
  connected: "已连上中继",
  error: "连不上中继",
};

const fmtLeft = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const fmtDate = (t: number) => new Date(t).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Re-renders every second while something counts down. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export const MobileScreen = memo(function MobileScreen({ hidden }: { hidden: boolean }) {
  const [v, setV] = useState<MobileGatewayState | null>(null);
  const [qr, setQr] = useState<MobilePairingQr | null>(null);
  const [qrImage, setQrImage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [relayUrl, setRelayUrl] = useState("");
  const [phoneUrl, setPhoneUrl] = useState("");

  useEffect(() => {
    void window.sweet.mobileState().then((s) => {
      setV(s);
      setRelayUrl(s.relay.url);
      setPhoneUrl(s.relay.phoneUrl === s.relay.url ? "" : s.relay.phoneUrl);
    });
    return window.sweet.onMobileChanged(setV);
  }, []);

  // The code is used up (scanned) or expired: stop showing it.
  useEffect(() => {
    if (qr && !v?.pairing) setQr(null);
  }, [qr, v?.pairing]);

  useEffect(() => {
    if (!qr) return setQrImage("");
    let live = true;
    void QRCode.toDataURL(qr.payload, { width: 260, margin: 1, errorCorrectionLevel: "M" }).then((d) => live && setQrImage(d));
    return () => {
      live = false;
    };
  }, [qr]);

  const now = useNow(!!qr || !!v?.pendingDevice);

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      const r = await f();
      if (r && typeof r === "object" && "relay" in r) setV(r as MobileGatewayState);
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!v) return <main className="usage" hidden={hidden} />;

  const connected = v.relay.status === "connected";
  const pending = v.pendingDevice;
  const phone = v.phone?.approved ? v.phone : undefined;

  return (
    <main className="usage mobile" hidden={hidden}>
      <div className="usage-inner">
        <div className="usage-head">
          <h1>手机</h1>
          <span className={`mobile-relay ${v.relay.status}`}>
            <span className="dot" />
            {RELAY[v.relay.status]}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className={v.enabled ? "neu-btn" : "neu-btn primary"}
            disabled={busy || !v.secretsAvailable}
            onClick={() => run(() => window.sweet.mobileSetEnabled(!v.enabled))}
          >
            {v.enabled ? "关闭手机连接" : "打开手机连接"}
          </button>
        </div>

        {!v.secretsAvailable && (
          <p className="mobile-banner bad">
            <Icon name="warning" />
            这台电脑的系统钥匙串不可用，没法安全保存手机连接的密钥，所以暂时不能打开。{v.relay.error ? `（${v.relay.error}）` : ""}
          </p>
        )}
        {error && (
          <p className="mobile-banner bad" role="alert">
            <Icon name="warning" />
            {error}
          </p>
        )}
        {v.relay.status === "error" && v.relay.error && <p className="mobile-banner warn">{v.relay.error}</p>}

        {pending && (
          <section className="usage-card mobile-pending" aria-live="assertive">
            <div className="mobile-pending-row">
              <span className="mobile-phone-icon">
                <Icon name="phone" />
              </span>
              <div className="mobile-pending-text">
                <b>「{pending.name}」想连这台电脑</b>
                <span>允许后，它能给主对话派活、审批、撤销改动。不是你的手机就拒绝。{fmtLeft(pending.expiresAt - now)} 后自动拒绝。</span>
              </div>
              <div className="mobile-actions">
                <button type="button" className="neu-btn" disabled={busy} onClick={() => run(() => window.sweet.mobileApproveDevice(pending.id, false))}>
                  拒绝
                </button>
                <button type="button" className="neu-btn primary" disabled={busy} onClick={() => run(() => window.sweet.mobileApproveDevice(pending.id, true))}>
                  允许
                </button>
              </div>
            </div>
          </section>
        )}

        <div className="mobile-grid">
          <section className="usage-card">
            <div className="usage-card-head">
              <h2>添加手机</h2>
              {phone && <span>正连着：{phone.deviceName}（{fmtDate(phone.since)} 起）</span>}
            </div>
            {qr ? (
              <div className="mobile-qr">
                {qrImage ? <img src={qrImage} alt="配对二维码，用 sikeoop 安卓 App 扫" width={260} height={260} /> : <div className="mobile-qr-placeholder" />}
                <div className="mobile-qr-side">
                  <ol className="mobile-steps">
                    <li>手机上打开 sikeoop App</li>
                    <li>点「连接我的电脑」（或「我的」里的电脑卡片）</li>
                    <li>扫这个二维码，再回这里点「允许」</li>
                  </ol>
                  <p className="mobile-expire">
                    <Icon name="clock" />
                    {fmtLeft(qr.expiresAt - now)} 后失效，只能扫一次
                  </p>
                  <div className="mobile-actions">
                    <button type="button" className="neu-btn" disabled={busy} onClick={() => run(() => window.sweet.mobileCreatePairing().then(setQr))}>
                      <Icon name="refresh" />
                      换一个
                    </button>
                    <button
                      type="button"
                      className="neu-btn"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await window.sweet.mobileCancelPairing();
                          setQr(null);
                        })
                      }
                    >
                      取消
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mobile-add">
                <p>
                  在手机上装好 sikeoop 安卓 App，扫一次码就能连上：在手机上派活、看进度、审批、撤销，内容全程端到端加密，中继只转发看不懂的密文。
                </p>
                <button
                  type="button"
                  className="neu-btn primary"
                  disabled={busy || !v.enabled || !connected}
                  title={!v.enabled ? "先打开手机连接" : !connected ? "等连上中继" : undefined}
                  onClick={() => run(() => window.sweet.mobileCreatePairing().then(setQr))}
                >
                  <Icon name="plus" />
                  添加手机
                </button>
                {!v.enabled && <span className="mobile-hint">先打开右上角的「打开手机连接」</span>}
                {v.enabled && !connected && <span className="mobile-hint">连上中继后才能生成二维码</span>}
              </div>
            )}
          </section>

          <section className="usage-card">
            <div className="usage-card-head">
              <h2>已配对的手机</h2>
              <span>{v.devices.length} 台</span>
            </div>
            {v.devices.length === 0 ? (
              <p className="mobile-empty">还没有配对过手机。</p>
            ) : (
              <ul className="mobile-devices">
                {v.devices.map((d) => {
                  const online = v.phone?.deviceId === d.id && v.phone.approved;
                  return (
                    <li key={d.id}>
                      <span className="mobile-phone-icon small">
                        <Icon name="phone" />
                      </span>
                      <div className="mobile-device-text">
                        <b>{d.name}</b>
                        <span>
                          {online ? <em className="on">在线</em> : d.lastSeenAt ? `上次 ${fmtDate(d.lastSeenAt)}` : "还没连过"} · 配对于 {fmtDate(d.addedAt)}
                        </span>
                      </div>
                      {confirmRemove === d.id ? (
                        <span className="mobile-actions">
                          <button type="button" className="neu-btn" onClick={() => setConfirmRemove(null)}>
                            算了
                          </button>
                          <button
                            type="button"
                            className="neu-btn danger"
                            disabled={busy}
                            onClick={() =>
                              run(async () => {
                                setConfirmRemove(null);
                                return window.sweet.mobileRevoke(d.id);
                              })
                            }
                          >
                            确定移除
                          </button>
                        </span>
                      ) : (
                        <button type="button" className="neu-btn" onClick={() => setConfirmRemove(d.id)} aria-label={`移除 ${d.name}`}>
                          <Icon name="trash" />
                          移除
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="mobile-note">移除后它的密钥立刻失效，要再连得重新扫码。</p>
          </section>
        </div>

        <details className="usage-card mobile-relay-settings">
          <summary>中继地址</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => window.sweet.mobileSetRelay(relayUrl.trim(), phoneUrl.trim() || undefined));
            }}
          >
            <label>
              <span>电脑连接的地址</span>
              <input value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} spellCheck={false} placeholder="wss://relay.sikeoop.modgert.online/v1/relay" />
            </label>
            <label>
              <span>手机连接的地址（不填就和上面一样）</span>
              <input value={phoneUrl} onChange={(e) => setPhoneUrl(e.target.value)} spellCheck={false} placeholder="安卓模拟器填 ws://10.0.2.2:8787/v1/relay" />
            </label>
            <div className="mobile-actions">
              <button type="submit" className="neu-btn primary" disabled={busy || !relayUrl.trim()}>
                保存
              </button>
            </div>
          </form>
          <p className="mobile-note">
            默认是公网中继 <code>wss://relay.sikeoop.modgert.online/v1/relay</code>，手机不在家也能连。中继只转发密文，看不到内容。自己调试时可以换成本地中继（<code>node relay/src/node-server.mjs</code>，地址 <code>ws://127.0.0.1:8787/v1/relay</code>，模拟器填 <code>ws://10.0.2.2:8787/v1/relay</code>）。
          </p>
        </details>

        <p className="remote-note">
          手机派来的任务固定用「懒人模式」：危险操作照旧拦下，推送、发布这类撤不回的事会在手机上单独问你。手机发来的消息会出现在电脑的主聊天里。
        </p>
      </div>
    </main>
  );
});
