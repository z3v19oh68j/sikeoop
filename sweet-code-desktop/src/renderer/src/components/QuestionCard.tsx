import { useState } from "react";
import type { AskAnswer, AskQuestion, QuestionResponse } from "@shared/types";
import { Icon } from "./Icon";

interface Props {
  id: string;
  intro?: string;
  questions: AskQuestion[];
  /** Set once answered: the card shows the answers instead of the form. */
  answered?: { answers: AskAnswer[]; usedDefaults: boolean };
  onAnswer(r: QuestionResponse): void;
}

/**
 * The agent's questions before it starts a new project or feature: one click per question, the
 * recommendation marked and pre-selected, a box for "something else", and "都按推荐来" for
 * answering everything at once.
 */
export function QuestionCard({ id, intro, questions, answered, onAnswer }: Props) {
  const [picked, setPicked] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, q.options.filter((o) => o.recommended).map((o) => o.label)])),
  );
  const [other, setOther] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);

  if (answered) return <Answered questions={questions} {...answered} />;

  const toggle = (q: AskQuestion, label: string) =>
    setPicked((p) => {
      const cur = p[q.id] ?? [];
      if (!q.multi) return { ...p, [q.id]: cur[0] === label ? [] : [label] };
      return { ...p, [q.id]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
    });
  const complete = questions.every((q) => (picked[q.id]?.length ?? 0) > 0 || other[q.id]?.trim());

  function submit(usedDefaults: boolean) {
    setSent(true);
    const answers: AskAnswer[] = questions.map((q) =>
      usedDefaults
        ? { id: q.id, choices: [(q.options.find((o) => o.recommended) ?? q.options[0]).label] }
        : { id: q.id, choices: picked[q.id] ?? [], ...(other[q.id]?.trim() ? { other: other[q.id].trim() } : {}) },
    );
    onAnswer({ id, answers, usedDefaults });
  }

  return (
    <section className="question-card" aria-label="AI 想先问你几个问题">
      <header>
        <Icon name="list-check" />
        <b>开始之前，先确认几件事</b>
      </header>
      {intro && <p className="intro">{intro}</p>}
      {questions.map((q, n) => (
        <fieldset key={q.id} className="q">
          <legend>
            <span className="num">{n + 1}</span>
            {q.header && <span className="chip">{q.header}</span>}
            <span>{q.question}</span>
            {q.multi && <span className="hint">（可多选）</span>}
          </legend>
          <div className="opts">
            {q.options.map((o) => {
              const on = (picked[q.id] ?? []).includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  role={q.multi ? "checkbox" : "radio"}
                  aria-checked={on}
                  className={"opt" + (on ? " on" : "")}
                  disabled={sent}
                  onClick={() => toggle(q, o.label)}
                >
                  <span className="mark" aria-hidden="true">
                    {on && <Icon name="check" />}
                  </span>
                  <span className="body">
                    <span className="label">
                      {o.label}
                      {o.recommended && <span className="rec">推荐</span>}
                    </span>
                    {o.description && <span className="desc">{o.description}</span>}
                  </span>
                </button>
              );
            })}
          </div>
          <input
            className="other"
            value={other[q.id] ?? ""}
            disabled={sent}
            onChange={(e) => setOther((x) => ({ ...x, [q.id]: e.target.value }))}
            placeholder="都不是？在这里写你的想法（可选）"
            aria-label={`${q.question} 的其他答案`}
          />
        </fieldset>
      ))}
      <footer>
        <span className="hint">选好后 AI 会列计划再动手。拿不准就点「都按推荐来」。</span>
        <span className="spacer" />
        <button type="button" className="mini-btn" disabled={sent} onClick={() => submit(true)}>
          <Icon name="sparkle" /> 都按推荐来
        </button>
        <button type="button" className="send" disabled={sent || !complete} onClick={() => submit(false)}>
          {sent ? "已发送" : "就这样，开始吧"}
        </button>
      </footer>
    </section>
  );
}

function Answered({ questions, answers, usedDefaults }: { questions: AskQuestion[]; answers: AskAnswer[]; usedDefaults: boolean }) {
  return (
    <section className="question-card done" aria-label="你的回答">
      <header>
        <Icon name="check" />
        <b>{usedDefaults ? "都按推荐来" : "你的选择"}</b>
      </header>
      <ul>
        {questions.map((q) => {
          const a = answers.find((x) => x.id === q.id);
          const text = [a?.choices.join("、"), a?.other ? `“${a.other}”` : ""].filter(Boolean).join("；") || "（没回答）";
          return (
            <li key={q.id}>
              <span className="k">{q.header ?? q.question}</span>
              <span className="v">{text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
