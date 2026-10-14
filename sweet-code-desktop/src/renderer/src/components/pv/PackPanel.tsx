import { Icon } from "../Icon";
import { STEPS, type PvKind, type PvPack, type PvStep } from "./types";

const STEP_LABEL = Object.fromEntries(STEPS.map((s) => [s.id, s.label])) as Record<PvStep, string>;
const KIND_LABEL = { common: "通用", promo: "宣传片", music: "音乐 PV" } as const;
type Entry = PvPack["entries"][number];

/** Experience packs for this kind of video, one collapsible group per pack. Only groups with
 *  something for the current step start open; inside them the other steps' entries stay folded. */
export function PackPanel({ packs, kind, step }: { packs: PvPack[]; kind: PvKind; step: PvStep }) {
  const groups = packs
    .filter((p) => p.kind === "common" || p.kind === kind)
    .map((pack) => ({ pack, here: pack.entries.filter((e) => e.steps.includes(step)), rest: pack.entries.filter((e) => !e.steps.includes(step)) }))
    // Packs with something for this step first; among those, the video's own kind before the common ones.
    .sort((a, b) => rank(a, kind) - rank(b, kind));
  const here = groups.reduce((n, g) => n + g.here.length, 0);
  const total = groups.reduce((n, g) => n + g.pack.entries.length, 0);

  return (
    <details className="st-disclosure pv-pack" open>
      <summary><Icon name="chevron-right" /> 经验包 · {STEP_LABEL[step]}（这一步 {here} 条，一共 {total} 条）</summary>
      {groups.length === 0 ? <p className="hint">还没读到经验包。</p> : (
        // Keyed by step so each step starts from its own default open / folded groups.
        <div className="pv-pack-groups" key={step}>
          {!groups.some((g) => g.pack.kind === kind) && <p className="hint">还没读到「{KIND_LABEL[kind]}」专用的经验包，先看通用的。</p>}
          {here === 0 && <p className="hint">这一步还没有对应的经验条目，其他步骤的可以点开看。</p>}
          {groups.map((g) => (
            <details key={`${g.pack.kind}/${g.pack.id}`} className="st-disclosure pv-pack-group" open={g.here.length > 0}>
              <summary>
                <Icon name="chevron-right" />
                <b>{g.pack.name}</b>
                <span className="st-count">{KIND_LABEL[g.pack.kind]}</span>
                <span className="hint">{g.here.length > 0 ? `这一步 ${g.here.length} 条` : "这一步用不上"} · 共 {g.pack.entries.length} 条</span>
              </summary>
              {g.here.length > 0 && <Entries list={g.here} />}
              {g.rest.length > 0 && (g.here.length === 0 ? <Entries list={g.rest} steps /> : (
                <details className="st-disclosure pv-pack-rest">
                  <summary><Icon name="chevron-right" /> 其他步骤的 {g.rest.length} 条</summary>
                  <Entries list={g.rest} steps />
                </details>
              ))}
              {g.pack.entries.length === 0 && <p className="hint">这个包还是空的。</p>}
            </details>
          ))}
        </div>
      )}
    </details>
  );
}

const rank = (g: { pack: PvPack; here: Entry[] }, kind: PvKind) => (g.here.length > 0 ? 0 : 2) + (g.pack.kind === kind ? 0 : 1);

function Entries({ list, steps }: { list: Entry[]; steps?: boolean }) {
  return (
    <ul>
      {list.map((e) => (
        <li key={e.id}>
          <b>{e.title}</b>
          {steps && <span className="hint">{e.steps.map((s) => STEP_LABEL[s]).join("、")}</span>}
          <p>{e.body}</p>
        </li>
      ))}
    </ul>
  );
}
