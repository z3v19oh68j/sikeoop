import { useState } from "react";
import type { ResearchEnv } from "@shared/types";
import { Icon } from "../Icon";
import { StatusBadge, cleanError } from "../settings/ui";

/** Python and the Chain-Centric package. Shown as a card until everything is ready, then as one line. */
export function EnvCard({ env, onEnv }: { env: ResearchEnv | null; onEnv(e: ResearchEnv): void }) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");

  if (!env) return <p className="hint">正在检查运行环境…</p>;

  if (env.python.found && env.installed && !env.installing)
    return (
      <p className="rs-env-ok">
        <StatusBadge tone="ok">环境就绪</StatusBadge>
        Python {env.python.version}
        {env.python.via === "uv" ? "（uv）" : ""} · Chain-Centric {env.packageVersion}
      </p>
    );

  async function install() {
    setAsking(false);
    setError("");
    try {
      onEnv(await window.sweet.researchInstall());
    } catch (e) {
      setError(cleanError(e));
    }
  }

  return (
    <section className="rs-card rs-env">
      <header className="rs-card-head">
        <Icon name="terminal" />
        <h3>先准备运行环境</h3>
        {!env.python.found ? (
          <StatusBadge tone="warn">没找到 Python</StatusBadge>
        ) : env.installing ? (
          <StatusBadge tone="accent">准备中</StatusBadge>
        ) : (
          <StatusBadge tone="muted">还没准备</StatusBadge>
        )}
      </header>
      <p className="hint">深度科研用的是开源的 Chain-Centric 协议，它是一个 Python 程序，在你电脑上单独运行。</p>

      {!env.python.found ? (
        <div className="rs-callout warn">
          <b>需要 Python 3.10 或更新的版本。</b>
          <p>{env.python.hint || "装好 Python（或 uv）后，回到这里就能继续。"}</p>
        </div>
      ) : env.installing ? (
        <div className="rs-installing">
          <div className="rs-bar indeterminate" aria-hidden="true">
            <span />
          </div>
          <p className="hint">正在建独立的 Python 环境并安装依赖，通常要几分钟。可以先去做别的，好了这里会自动变绿。</p>
        </div>
      ) : asking ? (
        <div className="rs-callout">
          <p>
            sikeoop 会在自己的文件夹里<b>新建一个独立的 Python 环境</b>，安装 Chain-Centric {env.packageVersion} 和它需要的库。
            要下载一些东西，大约几分钟；不会改动你电脑上已有的 Python。
          </p>
          <div className="rs-actions">
            <button type="button" className="mini-btn" onClick={() => setAsking(false)}>
              先不要
            </button>
            <button type="button" className="send rs-accent" onClick={() => void install()}>
              好，开始准备
            </button>
          </div>
        </div>
      ) : (
        <div className="rs-actions start">
          <button type="button" className="send rs-accent" onClick={() => setAsking(true)}>
            准备环境
          </button>
          <span className="hint">
            已找到 Python {env.python.version}
            {env.python.via === "uv" ? "（用 uv 安装，更快）" : ""}
          </span>
        </div>
      )}
      {error && <p className="err-text">准备失败：{error}</p>}
    </section>
  );
}
