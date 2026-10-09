"use client";

import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { use, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MAX_TEXT, OTHER, OTHER_LABEL } from "@/convex/answers";

export function Answers({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const set = useQuery(api.sets.get, { token });
  const answer = useMutation(api.sets.answer);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // free-text drafts, and which questions have the text box open
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [writing, setWriting] = useState<Record<string, boolean>>({});

  if (set === undefined) return <main className="notice">Loading…</main>;
  if (set === null) return <main className="notice">This link isn&apos;t valid.</main>;

  const open = set.status === "open";
  const answered = set.questions.filter((q) => q.answer !== null).length;

  async function choose(questionId: Id<"questions">, optionId: string, text?: string) {
    setPending((p) => ({ ...p, [questionId]: optionId }));
    setErrors((e) => ({ ...e, [questionId]: "" }));
    try {
      await answer({ token, questionId, optionId, text });
      if (optionId !== OTHER) setWriting((w) => ({ ...w, [questionId]: false }));
    } catch (err) {
      const message = err instanceof ConvexError ? String(err.data) : "Couldn't save. Try again.";
      setErrors((e) => ({ ...e, [questionId]: message }));
    } finally {
      setPending(({ [questionId]: _, ...rest }) => rest);
    }
  }

  return (
    <main>
      <h1>{set.title}</h1>
      <p className="lead">
        {set.status === "complete"
          ? "All answers are recorded. Thank you!"
          : set.status === "expired"
            ? "This link has expired. Answers given before it expired are recorded."
            : `Tap one option per question, or write your own under "${OTHER_LABEL}". Each answer saves on its own and you can change it until the last one is answered. ${answered} of ${set.questions.length} answered.`}
      </p>
      <p className="note">
        {set.status === "complete"
          ? "The dev team is notified automatically."
          : "The dev team is notified automatically once all decisions are in."}
      </p>

      {set.questions.map((q, i) => {
        const chosen = pending[q.id] ?? q.answer;
        const showText = open && (writing[q.id] ?? chosen === OTHER);
        const text = texts[q.id] ?? q.answerText ?? "";
        return (
          <section className="card" key={q.id}>
            <h2>
              <span>
                {i + 1}. {q.title}
              </span>
              {q.answer !== null && !pending[q.id] && <span className="saved">Saved ✓</span>}
            </h2>
            <p className="context">{q.context}</p>
            {q.options.map((o) => (
              <button
                key={o.id}
                className="option"
                aria-pressed={chosen === o.id}
                disabled={!open || q.id in pending}
                onClick={() => choose(q.id, o.id)}
              >
                <strong>{o.label}</strong>
                {o.detail && <span>{o.detail}</span>}
                {o.chooseIf && (
                  <span className="if">
                    <b>Choose this if</b> {o.chooseIf}
                  </span>
                )}
                {o.suits && o.suits.length > 0 && (
                  <span className="tags">
                    {o.suits.includes("us") && <em className="tag us">Suits us (dev)</em>}
                    {o.suits.includes("you") && <em className="tag you">Suits you (products)</em>}
                  </span>
                )}
              </button>
            ))}
            <button
              className="option"
              aria-pressed={chosen === OTHER}
              disabled={!open || q.id in pending}
              onClick={() => setWriting((w) => ({ ...w, [q.id]: !showText }))}
            >
              <strong>{OTHER_LABEL}</strong>
              {q.answer === OTHER && !showText ? (
                <span className="written">{q.answerText}</span>
              ) : (
                <span>None of these fit? Write your answer.</span>
              )}
            </button>
            {showText && (
              <div className="write">
                <textarea
                  value={text}
                  maxLength={MAX_TEXT}
                  rows={3}
                  placeholder="Your answer"
                  disabled={q.id in pending}
                  onChange={(e) => setTexts((t) => ({ ...t, [q.id]: e.target.value }))}
                />
                <button
                  className="save"
                  disabled={!text.trim() || q.id in pending || (q.answer === OTHER && text.trim() === q.answerText)}
                  onClick={() => choose(q.id, OTHER, text)}
                >
                  {q.answer === OTHER && text.trim() === q.answerText ? "Saved" : "Save answer"}
                </button>
              </div>
            )}
            {errors[q.id] && <p className="error">{errors[q.id]}</p>}
          </section>
        );
      })}
    </main>
  );
}
