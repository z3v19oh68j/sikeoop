import { memo, useEffect, useState } from "react";
import QRCode from "qrcode";
import type { RemoteView } from "@shared/types";

const STATUS: Record<RemoteView["status"], string> = {
  off: "未开启",
  connecting: "连接中…",
  qr: "请用微信扫码",
  scanned: "已扫码，请在手机上确认",
  verify: "请输入手机微信上显示的验证码",
  online: "在线",
};

/** WeChat remote control: scan to log in, then send tasks from the phone. */
export const RemoteScreen = memo(function RemoteScreen({ hidden }: { hidden: boolean }) {
  const [v, setV] = useState<RemoteView | null>(null);
  const [qr, setQr] = useState("");
  const [pending, setPending] = useState(false);
  const [code, setCode] = useState("");

  useEffect(() => {
    void window.sweet.remoteState().then(setV);
    return window.sweet.onRemote(setV);
  }, []);

  useEffect(() => {
    if (!v?.qrUrl) return setQr("");
    let live = true;
    void QRCode.toDataURL(v.qrUrl, { width: 240, margin: 1 }).then((d) => live && setQr(d));
    return () => {
      live = false;
    };
  }, [v?.qrUrl]);

  const act = (f: () => Promise<RemoteView>) => {
    setPending(true);
    void f()
      .then(setV)
      .finally(() => setPending(false));
  };

  const on = !!v && v.status !== "off";
  return (
    <main className="usage" hidden={hidden}>
      <div className="usage-inner">
        <div className="usage-head">
          <h1>微信远程控制</h1>
          <span className="spacer" />
          {v && (
            <button type="button" className={on ? "neu-btn" : "neu-btn primary"} disabled={pending} onClick={() => act(on ? window.sweet.remoteDisable : window.sweet.remoteEnable)}>
              {on ? "关闭" : "开启"}
            </button>
          )}
        </div>
        <div className="usage-card">
          <div className="usage-card-head">
            <h2>{v ? STATUS[v.status] : "…"}</h2>
            {v?.busy && <span>正在处理微信里的任务</span>}
          </div>
          {v?.error && <p className="remote-error">{v.error}</p>}
          {qr && <img className="remote-qr" src={qr} alt="微信登录二维码" width={240} height={240} />}
          {v?.status === "verify" && (
            <form
              className="remote-verify"
              onSubmit={(e) => {
                e.preventDefault();
                if (!code.trim()) return;
                void window.sweet.remoteVerify(code);
                setCode("");
              }}
            >
              {v.verifyRetry && <span className="remote-error">验证码不对，再输一次</span>}
              <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoFocus placeholder="验证码" aria-label="验证码" />
              <button type="submit" className="neu-btn primary">
                确定
              </button>
            </form>
          )}
          {v?.status === "online" && (
            <p>
              已连接。在微信里给机器人发消息，sikeoop 主控就会指挥 Claude Code / Codex 在当前项目里干活；发 /help 看命令。只有扫码的这个微信号能控制。{" "}
              <button type="button" className="neu-btn" disabled={pending} onClick={() => act(window.sweet.remoteRelogin)}>
                换个微信号
              </button>
            </p>
          )}
          <p className="remote-note">
            远程任务用「懒人模式」运行：不会弹审批，危险操作会被自动拒绝。微信发来的消息会出现在电脑上的主聊天里；Claude Code 要权限时会发到微信，回 /y 或 /n。
          </p>
        </div>
      </div>
    </main>
  );
});
