import { useEffect, useState } from "react";
import type { SkillHubItem, SkillInfo, SkillPreview } from "@shared/types";
import { RESOURCE_CATEGORIES, RESOURCES, type ResourceCard, type ResourceCategory } from "@shared/resources";
import { Icon } from "./Icon";
import { SkillReview } from "./SkillReview";

const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

interface Props {
  /** A project is open and the partner is set up, so the chat can take a request. */
  canAskAI: boolean;
  /** Send a message to the AI in the chat (switches to the workbench). */
  onAskAI(text: string): void;
}

/** What the AI is asked to do for one card. */
function installRequest(cards: ResourceCard[]): string {
  const lines = cards.map(
    (c) => `- 「${c.title}」：来源 ${c.repo}，${c.pick.length ? `只装这些：${c.pick.join("、")}` : "里面的技能全部装上"}`,
  );
  return (
    `帮我从资源库安装${cards.length > 1 ? "这几组" : "这组"}技能，用 install_skills 工具${cards.length > 1 ? "一组一组地装" : ""}：\n${lines.join("\n")}\n` +
    "装好后用两三句大白话告诉我它们能帮我做什么、我该怎么用（比如在新对话里怎么说）。"
  );
}

/** Installed skills that came from this card's repo. */
function installedFrom(card: ResourceCard, skills: SkillInfo[]): SkillInfo[] {
  const repo = card.repo.toLowerCase();
  return skills.filter((s) => s.source.toLowerCase().startsWith(repo));
}

/** The install review open over the library: which preview, and which skills to pre-tick. */
interface Reviewing {
  preview: SkillPreview;
  preselect?: string[];
  /** The card or store item it came from, for the note shown afterwards. */
  key: string;
}

export function ResourceLibrary({ canAskAI, onAskAI }: Props) {
  const [tab, setTab] = useState<"picks" | "hub">("picks");
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [stars, setStars] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [reviewing, setReviewing] = useState<Reviewing | null>(null);

  useEffect(() => {
    void window.sweet.listSkills().then(setSkills);
    void window.sweet.resourceStars().then(setStars, () => {});
    return window.sweet.onSkillsChanged(setSkills);
  }, []);

  /** Without the AI: fetch the skills, then show the security review before installing. */
  async function reviewDirectly(key: string, load: () => Promise<SkillPreview>, preselect?: string[]) {
    setBusy(key);
    setNotes((n) => ({ ...n, [key]: { ok: true, text: "正在拉取并检查…" } }));
    try {
      const preview = await load();
      setNotes((n) => ({ ...n, [key]: { ok: true, text: "" } }));
      setReviewing({ preview, preselect, key });
    } catch (e) {
      setNotes((n) => ({ ...n, [key]: { ok: false, text: cleanError(e) } }));
    } finally {
      setBusy(null);
    }
  }

  const reviewCard = (card: ResourceCard) =>
    reviewDirectly(card.id, () => window.sweet.previewSkills({ kind: "url", url: card.repo, only: card.pick.length ? card.pick : undefined }), card.pick.length ? card.pick : undefined);

  const starters = RESOURCES.filter((r) => r.starter);
  const startersDone = starters.every((c) => installedFrom(c, skills).length >= Math.max(1, c.pick.length || 1));

  return (
    <main className="start resources">
      <div className="start-inner wide">
        <div className="start-hero">
          <span className="mark">
            <Icon name="sparkle" />
          </span>
          <div>
            <h1>资源库</h1>
            <p>别人做好的 AI 技能，挑好了、写好了说明。点一下，AI 会自己去 GitHub 拉下来装好。</p>
          </div>
        </div>

        <section className="res-starter">
          <div>
            <b>还不知道装哪个？先装这 {starters.length} 个</b>
            <span>{starters.map((s) => s.title).join(" · ")}</span>
          </div>
          <button
            type="button"
            className="send"
            disabled={!canAskAI || startersDone}
            title={canAskAI ? undefined : "先打开一个项目并设置好伙伴，AI 才能帮你装"}
            onClick={() => onAskAI(installRequest(starters))}
          >
            {startersDone ? (
              <>
                都装好了 <Icon name="check" />
              </>
            ) : (
              <>
                <Icon name="sparkle" /> 让 AI 一键全装
              </>
            )}
          </button>
        </section>
        {!canAskAI && <p className="hint">现在还不能让 AI 装：先打开一个项目、设置好伙伴。也可以点卡片上的「直接装」，不经过 AI。</p>}

        <div className="seg res-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "picks"} className={tab === "picks" ? "on" : ""} onClick={() => setTab("picks")}>
            精选
          </button>
          <button type="button" role="tab" aria-selected={tab === "hub"} className={tab === "hub" ? "on" : ""} onClick={() => setTab("hub")}>
            SkillHub 商店
          </button>
        </div>

        {tab === "hub" && (
          <SkillHubStore
            installed={skills}
            canAskAI={canAskAI}
            busy={busy}
            notes={notes}
            onAskAI={(item) =>
              onAskAI(
                `帮我从 SkillHub 商店安装技能「${item.name}」，用 install_skills 工具，source 写 skillhub:${item.slug}。` +
                  "装好后用两三句大白话告诉我它能帮我做什么、我该怎么用。",
              )
            }
            onDirect={(item) => void reviewDirectly(`hub:${item.slug}`, () => window.sweet.previewSkills({ kind: "skillhub", slug: item.slug }))}
          />
        )}

        {tab === "picks" && (Object.keys(RESOURCE_CATEGORIES) as ResourceCategory[]).map((cat) => (
          <section key={cat} className="start-section" aria-label={RESOURCE_CATEGORIES[cat].title}>
            <div className="start-section-head">
              <h2>{RESOURCE_CATEGORIES[cat].title}</h2>
              <span className="sub">{RESOURCE_CATEGORIES[cat].hint}</span>
            </div>
            <div className="res-grid">
              {RESOURCES.filter((r) => r.category === cat).map((card) => (
                <Card
                  key={card.id}
                  card={card}
                  stars={stars[card.id] ?? card.stars}
                  installed={installedFrom(card, skills)}
                  canAskAI={canAskAI}
                  busy={busy === card.id}
                  note={notes[card.id]}
                  onAskAI={() => onAskAI(installRequest([card]))}
                  onDirect={() => void reviewCard(card)}
                />
              ))}
            </div>
          </section>
        ))}

        <p className="hint">
          技能里的说明会影响 AI 做事的方式。每个技能安装前都会先做安全审核：规则扫描检查有没有恶意指令、偷数据、删文件、隐藏字符，再让 AI 通读一遍；
          高风险的要你亲自确认才能装。装好的技能在「插件 → 技能」里管理，在新对话里生效。
        </p>
      </div>

      {reviewing && (
        <div className="modal-back" onClick={(e) => e.target === e.currentTarget && setReviewing(null)}>
          <div className="modal review-modal" role="dialog" aria-label="安装前的安全审核">
            <h2>安装前检查</h2>
            <SkillReview
              key={reviewing.preview.previewId}
              preview={reviewing.preview}
              preselect={reviewing.preselect}
              onCancel={() => setReviewing(null)}
              onInstalled={(list) => {
                setSkills(list);
                setNotes((n) => ({ ...n, [reviewing.key]: { ok: true, text: "装好了，新对话里生效" } }));
                setReviewing(null);
              }}
            />
          </div>
        </div>
      )}
    </main>
  );
}

const CATEGORY_NAMES: Record<string, string> = {
  "office-efficiency": "办公效率",
  "ai-agent": "AI 助手",
  "knowledge-management": "知识管理",
  "dev-tools": "开发工具",
  development: "开发",
  lifestyle: "生活",
  design: "设计",
  data: "数据",
};
const QUICK = ["PDF", "Excel", "Word 文档", "PPT", "周报", "前端", "动画", "数据分析", "翻译", "爬虫"];

interface HubProps {
  installed: SkillInfo[];
  canAskAI: boolean;
  busy: string | null;
  notes: Record<string, { ok: boolean; text: string }>;
  onAskAI(item: SkillHubItem): void;
  onDirect(item: SkillHubItem): void;
}

/** Search the SkillHub store (skillhub.cn) and install from it, through the same review. */
function SkillHubStore({ installed, canAskAI, busy, notes, onAskAI, onDirect }: HubProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillHubItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");

  async function search(q: string) {
    if (!q.trim()) return;
    setQuery(q);
    setSearching(true);
    setError("");
    try {
      setResults(await window.sweet.searchSkillHub(q));
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setSearching(false);
    }
  }

  const fromHub = (slug: string) => installed.some((s) => s.source === `SkillHub · ${slug}`);

  return (
    <section className="start-section hub" aria-label="SkillHub 商店">
      <div className="start-section-head">
        <h2>SkillHub 商店</h2>
        <span className="sub">国内的技能商店（skillhub.cn），社区上传 + ClawHub 镜像。谁都能上传，装之前一定看安全审核。</span>
      </div>
      <form
        className="field-row hub-search"
        onSubmit={(e) => {
          e.preventDefault();
          void search(query);
        }}
      >
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜技能，比如：PDF、Excel 报表、react 动画" aria-label="搜索 SkillHub" />
        <button type="submit" className="send" disabled={!query.trim() || searching}>
          {searching ? "搜索中…" : "搜索"}
        </button>
      </form>
      <div className="hub-quick">
        {QUICK.map((q) => (
          <button key={q} type="button" className="ctx-chip" onClick={() => void search(q)}>
            {q}
          </button>
        ))}
      </div>
      {error && <p className="err-text">{error}</p>}
      {results && !results.length && <p className="hint">没搜到。换个说法试试，英文名常常更好搜。</p>}
      {results && results.length > 0 && (
        <div className="res-grid">
          {results.map((item) => {
            const key = `hub:${item.slug}`;
            const done = fromHub(item.slug);
            return (
              <article key={item.slug} className={"res-card hub-card" + (done ? " done" : "")}>
                <header>
                  <span className="res-avatar" aria-hidden="true">
                    {item.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="res-title">
                    <h3>{item.name}</h3>
                    <span className="res-meta">
                      {item.owner || "匿名"} · {item.source === "clawhub" ? "ClawHub 镜像" : "社区"}
                      {item.version && ` · v${item.version}`}
                    </span>
                  </div>
                  {done && (
                    <span className="badge std">
                      <Icon name="check" /> 已安装
                    </span>
                  )}
                </header>
                <p className="res-summary">{item.summary || "（没有简介）"}</p>
                <div className="res-skills">
                  <span className="ctx-chip">
                    <span>{item.downloads.toLocaleString()} 次下载</span>
                  </span>
                  {item.installs > 0 && (
                    <span className="ctx-chip">
                      <span>{item.installs.toLocaleString()} 次安装</span>
                    </span>
                  )}
                  {item.category && (
                    <span className="ctx-chip">
                      <span>{CATEGORY_NAMES[item.category] ?? item.category}</span>
                    </span>
                  )}
                  <code className="res-more">{item.slug}</code>
                </div>
                {item.requiresApiKey && (
                  <p className="res-needs">
                    <Icon name="warning" /> 需要另外申请一个 API Key 才能用
                  </p>
                )}
                {notes[key]?.text && <p className={notes[key].ok ? "hint" : "err-text"}>{notes[key].text}</p>}
                <footer>
                  <button type="button" className="mini-btn" disabled={busy === key} onClick={() => onDirect(item)} title="拉下来先做安全审核，看过结果再决定装不装">
                    {busy === key ? "检查中…" : "检查并安装"}
                  </button>
                  <button type="button" className="icon-btn" disabled={!canAskAI || !!busy} onClick={() => onAskAI(item)} title={canAskAI ? "交给 AI：它会拉取、审核，然后给你确认" : "先打开一个项目并设置好伙伴"}>
                    <Icon name="sparkle" /> 让 AI 装
                  </button>
                  <span className="spacer" />
                  {item.homepage && (
                    <a className="icon-btn" href={item.homepage} target="_blank" rel="noreferrer">
                      详情 ↗
                    </a>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

interface CardProps {
  card: ResourceCard;
  stars: number;
  installed: SkillInfo[];
  canAskAI: boolean;
  busy: boolean;
  note?: { ok: boolean; text: string };
  onAskAI(): void;
  onDirect(): void;
}

function Card({ card, stars, installed, canAskAI, busy, note, onAskAI, onDirect }: CardProps) {
  const names = new Set(installed.map((s) => s.name));
  const done = card.pick.length ? card.pick.every((n) => names.has(n)) : installed.length > 0;
  return (
    <article className={"res-card" + (done ? " done" : "")}>
      <header>
        <span className="res-avatar" aria-hidden="true">
          {card.author.slice(0, 1).toUpperCase()}
        </span>
        <div className="res-title">
          <h3>{card.title}</h3>
          <span className="res-meta">
            {card.author} · <span className="stars">★ {formatStars(stars)}</span>
          </span>
        </div>
        {done && (
          <span className="badge std">
            <Icon name="check" /> 已安装
          </span>
        )}
      </header>
      <p className="res-summary">{card.summary}</p>
      <p className="res-why">{card.why}</p>
      <div className="res-skills">
        {card.pick.length ? (
          card.pick.map((n) => (
            <span key={n} className={"ctx-chip" + (names.has(n) ? " on" : "")}>
              {names.has(n) && <Icon name="check" />}
              <span>{n}</span>
            </span>
          ))
        ) : (
          <span className="ctx-chip">
            <span>全部技能{installed.length ? `（已装 ${installed.length} 个）` : ""}</span>
          </span>
        )}
        {card.more ? <span className="res-more">仓库里另有 {card.more} 个技能没选</span> : null}
      </div>
      {card.needs && (
        <p className="res-needs">
          <Icon name="warning" /> {card.needs}
        </p>
      )}
      {note && <p className={note.ok ? "hint" : "err-text"}>{note.text}</p>}
      <footer>
        <button
          type="button"
          className="send"
          disabled={!canAskAI || busy}
          title={canAskAI ? "把安装任务交给 AI：它会去 GitHub 拉取，给你确认后装好" : "先打开一个项目并设置好伙伴"}
          onClick={onAskAI}
        >
          <Icon name="sparkle" /> {done ? "让 AI 更新" : "让 AI 帮我装"}
        </button>
        <button type="button" className="mini-btn" disabled={busy} title="不经过 AI：从 GitHub 拉下来，先做安全审核，看过结果再装" onClick={onDirect}>
          {busy ? "检查中…" : "直接装"}
        </button>
        <span className="spacer" />
        <a className="icon-btn" href={card.repo} target="_blank" rel="noreferrer">
          GitHub ↗
        </a>
      </footer>
    </article>
  );
}

function formatStars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}
