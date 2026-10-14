import { parseNotes, type NoteTone } from "./notes";
import "../../styles/release-notes.css";

const TAG: Record<NoteTone, string> = { new: "新增", better: "改进", fix: "修复", warn: "注意", plain: "" };

/**
 * The release notes in full: the tagline, then each section with its bullets (bold lead + the rest).
 * Sized in em and colored through --rn-* variables, so the corner card and the EVA card both use it.
 */
export function ReleaseNotes({ notes }: { notes: string }) {
  const { tagline, sections } = parseNotes(notes);
  if (!tagline && !sections.length) return <p className="rn-empty">这个版本没有写更新说明。</p>;
  return (
    <div className="rn">
      {tagline && <p className="rn-tagline">{tagline}</p>}
      {sections.map((s, i) => (
        <section key={i} className={`rn-section tone-${s.tone}`}>
          {s.heading && (
            <h4 className="rn-heading">
              <span className="rn-tag">{TAG[s.tone] || s.heading}</span>
              {TAG[s.tone] && TAG[s.tone] !== s.heading && <span>{s.heading}</span>}
              <span className="rn-count">{s.items.length ? `${s.items.length} 项` : ""}</span>
            </h4>
          )}
          {s.paragraphs.map((p, j) => (
            <p key={j} className="rn-para">
              {p}
            </p>
          ))}
          {s.items.length > 0 && (
            <ul className="rn-items">
              {s.items.map((it, j) => (
                <li key={j}>
                  {it.lead && <b>{it.lead}</b>}
                  {it.lead && it.text && "："}
                  {it.text}
                  {it.details.length > 0 && (
                    <ul className="rn-details">
                      {it.details.map((d, k) => (
                        <li key={k}>{d}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
