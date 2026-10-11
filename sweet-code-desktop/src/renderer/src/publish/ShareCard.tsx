import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { PublishRecord } from "@shared/types";

// Chat share card (F4): a local-only card shown after a publish finishes. Never publishes anything.
export function ShareCard({ record, onDismiss }: { record: PublishRecord; onDismiss: () => void }) {
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    void QRCode.toDataURL(record.url, { width: 140, margin: 1, errorCorrectionLevel: "M" }).then((d) => live && setQr(d));
    return () => {
      live = false;
    };
  }, [record.url]);

  return (
    <div className="share-card" role="status">
      <div className="share-card-body">
        <strong>你的网页上线啦</strong>
        <p className="publish-note">把链接发给朋友，或者用手机扫码打开。</p>
        <div className="publish-link">
          <a href={record.url} target="_blank" rel="noreferrer">
            {record.url}
          </a>
          <button type="button" className="mini-btn" onClick={() => void navigator.clipboard.writeText(record.url).then(() => setCopied(true))}>
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
      {qr && <img className="share-card-qr" src={qr} alt="扫码打开" width={140} height={140} />}
      <button type="button" className="icon-btn square share-card-close" aria-label="关闭" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
