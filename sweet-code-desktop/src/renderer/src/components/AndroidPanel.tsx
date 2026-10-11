import { useCallback, useEffect, useState } from "react";
import type { AndroidDevice, AndroidState } from "@shared/types";
import { Icon } from "./Icon";

const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

const fileName = (p: string) => p.split(/[\\/]/).pop() || p;

/** Android emulators: start a virtual device, see what is connected, install an APK and take a screenshot. */
export function AndroidPanel({ onClose }: { onClose(): void }) {
  const [state, setState] = useState<AndroidState | null>(null);
  const [picked, setPicked] = useState("");
  const [shot, setShot] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await window.sweet.androidState());
    } catch (e) {
      setNotice({ ok: false, text: cleanError(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Devices appear and disappear on their own (an emulator finishes booting), so keep the list fresh.
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const online: AndroidDevice[] = state?.devices.filter((d) => d.state === "device") ?? [];
  const target = online.find((d) => d.serial === picked) ?? online[0];

  const run = async (label: string, job: () => Promise<string | void>) => {
    setBusy(label);
    setNotice(null);
    try {
      const text = await job();
      if (text) setNotice({ ok: true, text });
    } catch (e) {
      setNotice({ ok: false, text: cleanError(e) });
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const startAvd = (name: string) =>
    run(`start:${name}`, async () => {
      await window.sweet.androidStartAvd(name);
      return `正在启动 ${name}。开机需要一段时间，好了之后会出现在下面的设备列表里。`;
    });

  const stop = (serial: string) =>
    run(`stop:${serial}`, async () => {
      await window.sweet.androidStop(serial);
      setShot("");
      return `已关闭 ${serial}`;
    });

  const install = () =>
    run("install", async () => {
      if (!target) throw new Error("没有已连接的设备。先启动一个模拟器。");
      const apk = await window.sweet.androidPickApk();
      if (!apk) return;
      await window.sweet.androidInstall(target.serial, apk);
      return `已安装 ${fileName(apk)} 到 ${target.serial}`;
    });

  const capture = () =>
    run("shot", async () => {
      if (!target) throw new Error("没有已连接的设备。先启动一个模拟器。");
      setShot(await window.sweet.androidScreenshot(target.serial));
    });

  const noSdk = state !== null && !state.sdkRoot;

  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal android-modal" role="dialog" aria-label="Android 模拟器">
        <div className="android-head">
          <h2>Android 模拟器</h2>
          <button type="button" className="icon-btn" aria-label="关闭" title="关闭" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        {noSdk && (
          <p>
            没有找到 Android SDK。请安装 Android Studio（它会装好 SDK），或者设置环境变量 <code>ANDROID_HOME</code> 指向 SDK 文件夹，然后点刷新。
          </p>
        )}

        {state?.sdkRoot && (!state.adb || !state.emulator) && (
          <p className="err">
            SDK 位置：{state.sdkRoot}。缺少{!state.adb && " adb"}
            {!state.adb && !state.emulator && "、"}
            {!state.emulator && " emulator"}，请在 SDK Manager 里安装 Android Emulator 和 Platform-Tools。
          </p>
        )}

        <section className="android-section">
          <div className="android-title">
            <span>虚拟设备（AVD）</span>
            <button type="button" onClick={() => void refresh()} disabled={busy !== null}>
              刷新
            </button>
          </div>
          {state?.avds.length ? (
            <ul className="android-list">
              {state.avds.map((name) => (
                <li key={name}>
                  <span>{name}</span>
                  <button type="button" onClick={() => void startAvd(name)} disabled={busy !== null || !state.emulator}>
                    启动
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>{state && state.sdkRoot ? "还没有虚拟设备。在 Android Studio 的 Device Manager 里创建一个即可。" : "—"}</p>
          )}
        </section>

        <section className="android-section">
          <div className="android-title">
            <span>已连接的设备</span>
          </div>
          {state?.devices.length ? (
            <ul className="android-list">
              {state.devices.map((d) => (
                <li key={d.serial} className={d.serial === target?.serial ? "on" : undefined}>
                  <span>
                    {d.serial}
                    <small> · {d.state === "device" ? "在线" : d.state}</small>
                  </span>
                  {d.state === "device" && (
                    <button type="button" onClick={() => setPicked(d.serial)} disabled={d.serial === target?.serial}>
                      {d.serial === target?.serial ? "当前" : "选择"}
                    </button>
                  )}
                  <button type="button" onClick={() => void stop(d.serial)} disabled={busy !== null}>
                    关闭
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>没有连接的设备。</p>
          )}
        </section>

        <div className="row">
          <button type="button" onClick={() => void install()} disabled={busy !== null || !target}>
            安装 APK…
          </button>
          <button type="button" onClick={() => void capture()} disabled={busy !== null || !target}>
            截图
          </button>
        </div>

        {busy && <p>处理中…</p>}
        {notice && <p className={notice.ok ? undefined : "err"}>{notice.text}</p>}
        {shot && <img className="android-shot" src={shot} alt="设备截图" />}
      </div>
    </div>
  );
}
