"use client";

import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { use, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export function Answers({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const set = useQuery(api.sets.get, { token });
  const answer = useMutation(api.sets.answer);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (set === undefined) return <main className="notice">Loading…</main>;
  if (set === null) return <main className="notice">This link isn&apos;t valid.</main>;

  const open = set.status === "open";
  const answered = set.questions.filter((q) => q.answer !== null).length;

  async function choose(questionId: Id<"questions">, optionId: string) {
    setPending((p) => ({ ...p, [questionId]: optionId }));
    setErrors((e) => ({ ...e, [questionId]: "" }));
    try {
      await answer({ token, questionId, optionId });
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
            : `Tap one option per question. Each answer saves on its own and you can change it until the last one is answered. ${answered} of ${set.questions.length} answered.`}
      </p>

      {set.questions.map((q, i) => {
        const chosen = pending[q.id] ?? q.answer;
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
                {o.suits && o.suits.length > 0 && (
                  <span className="tags">
                    {o.suits.includes("us") && <em className="tag us">Suits us (dev)</em>}
                    {o.suits.includes("you") && <em className="tag you">Suits you (products)</em>}
                  </span>
                )}
              </button>
            ))}
            {errors[q.id] && <p className="error">{errors[q.id]}</p>}
          </section>
        );
      })}
    </main>
  );
}
