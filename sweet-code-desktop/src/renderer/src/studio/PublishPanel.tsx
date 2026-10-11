import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { PublishErrorCode, PublishRecord, PublishRequest, PublishScanResult } from "@shared/types";
import { Icon } from "../components/Icon";

// One-click publish popover (F2): scan the prototype, show plain-language warnings, upload
// with a progress bar, then hand back the link, a copy button and a QR code.

const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

const ERROR_TEXT: Record<PublishErrorCode, string> = {
  too_big: "作品太大了，单个网站最多 10MB。可以压缩一下图片再试。",
  quota: "你发布的网站数量已经到上限了，可以先下线不用的网站。",
  network: "网络好像断了，检查一下网络再点一次发布。",
  blocked_file: "作品里有不能公开的文件（比如密钥），先处理掉再发布。",
  server: "发布服务暂时出了点问题，稍后再试一次。",
  cancelled: "已取消发布。",
};

const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

type Phase =
  | { kind: "scanning" }
  | { kind: "ready"; scan: PublishScanResult }
  | { kind: "uploading"; done: number; total: number }
  | { kind: "done"; record: PublishRecord }
  | { kind: "error"; text: string };

interface Props {
  protoName: string;
  onClose(): void;
}

export function PublishPanel({ protoName, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "scanning" });
  const [scan, setScan] = useState<PublishScanResult | null>(null);
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  const busy = useRef(false);
  const req: PublishRequest = { source: { kind: "proto", name: protoName } };

  const runScan = async () => {
    setPhase({ kind: "scanning" });
    try {
      const r = await window.sweet.publishScan(req);
      setScan(r);
      setPhase({ kind: "ready", scan: r });
    } catch (e) {
      setPhase({ kind: "error", text: cleanError(e) || ERROR_TEXT.server });
    }
  };

  useEffect(() => {
    void runScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [protoName]);

  useEffect(
    () =>
      window.sweet.onPublishEvent((ev) => {
        if (!busy.current) return;
        if (ev.type === "scan") setScan(ev.result);
        else if (ev.type === "upload") setPhase({ kind: "uploading", done: ev.done, total: ev.total });
        else if (ev.type === "done") {
          busy.current = false;
          setPhase({ kind: "done", record: ev.record });
        } else if (ev.type === "error") {
          busy.current = false;
          setPhase({ kind: "error", text: ERROR_TEXT[ev.code] ?? ev.message });
        }
      }),
    [],
  );

  const url = phase.kind === "done" ? phase.record.url : "";
  useEffect(() => {
    if (!url) return setQr("");
    let live = true;
    void QRCode.toDataURL(url, { width: 180, margin: 1, errorCorrectionLevel: "M" }).then((d) => live && setQr(d));
    return () => {
      live = false;
    };
  }, [url]);

  const start = async () => {
    busy.current = true;
    setCopied(false);
    setPhase({ kind: "uploading", done: 0, total: scan?.files ?? 0 });
    try {
      const record = await window.sweet.publishStart(req);
      if (busy.current) {
        busy.current = false;
        setPhase({ kind: "done", record });
      }
    } catch (e) {
      if (busy.current) {
        busy.current = false;
        setPhase({ kind: "error", text: cleanError(e) || ERROR_TEXT.server });
      }
    }
  };

  const cancel = () => {
    void window.sweet.publishCancel();
    busy.current = false;
    setPhase({ kind: "error", text: ERROR_TEXT.cancelled });
  };

  const copy = () => {
    void navigator.clipboard.writeText(url).then(() => setCopied(true));
  };

  const blocking = scan?.warnings.some((w) => w.blocking) ?? false;

  return (
    <div className="publish-panel" role="dialog" aria-label="发布">
      <div className="publish-head">
        <strong>发布「{protoName}」</strong>
        <span className="spacer" />
        <button type="button" className="icon-btn square" aria-label="关闭" onClick={onClose} disabled={phase.kind === "uploading"}>
          <Icon name="close" />
        </button>
      </div>

      {phase.kind === "scanning" && <p className="publish-note">正在检查作品…</p>}

      {phase.kind === "ready" && (
        <>
          <p className="publish-note">
            共 {phase.scan.files} 个文件，{formatBytes(phase.scan.bytes)}。发布后任何人都能通过链接打开。
          </p>
          {phase.scan.warnings.length > 0 && (
            <ul className="publish-warnings">
              {phase.scan.warnings.map((w, i) => (
                <li key={i} className={w.blocking ? "blocking" : undefined}>
                  <span className="tag">{w.blocking ? "必须处理" : "提醒"}</span>
                  <span>
                    {w.message}
                    <span className="file">{w.file}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {blocking && <p className="publish-note bad">有必须处理的问题，处理好后点「重新检查」。</p>}
          <div className="publish-actions">
            <button type="button" className="mini-btn" onClick={() => void runScan()}>
              重新检查
            </button>
            <button type="button" className="send" disabled={blocking} onClick={() => void start()}>
              发布
            </button>
          </div>
        </>
      )}

      {phase.kind === "uploading" && (
        <>
          <p className="publish-note">
            正在上传 {phase.done}/{phase.total || "…"}
          </p>
          <div className="publish-progress" role="progressbar" aria-valuemin={0} aria-valuemax={phase.total} aria-valuenow={phase.done}>
            <div style={{ width: `${phase.total ? Math.round((phase.done / phase.total) * 100) : 5}%` }} />
          </div>
          <div className="publish-actions">
            <button type="button" className="mini-btn" onClick={cancel}>
              取消
            </button>
          </div>
        </>
      )}

      {phase.kind === "done" && (
        <>
          <p className="publish-note ok">发布成功！把链接发给朋友，或者用手机扫码打开。</p>
          <div className="publish-link">
            <a href={phase.record.url} target="_blank" rel="noreferrer">
              {phase.record.url}
            </a>
            <button type="button" className="mini-btn" onClick={copy}>
              {copied ? "已复制" : "复制"}
            </button>
          </div>
          {qr && <img className="publish-qr" src={qr} alt="扫码打开" width={180} height={180} />}
          <div className="publish-actions">
            <span className="publish-meta">
              {phase.record.fileCount} 个文件 · {formatBytes(phase.record.bytes)}
            </span>
            <button type="button" className="send" onClick={() => void runScan()}>
              更新发布
            </button>
          </div>
        </>
      )}

      {phase.kind === "error" && (
        <>
          <p className="publish-note bad">{phase.text}</p>
          <div className="publish-actions">
            <button type="button" className="send" onClick={() => void runScan()}>
              再试一次
            </button>
          </div>
        </>
      )}
    </div>
  );
}
