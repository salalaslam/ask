"use client";

import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { use, useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MAX_TEXT, OTHER, OTHER_LABEL } from "@/convex/answers";
import { confetti } from "./confetti";

export function Answers({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const set = useQuery(api.sets.get, { token });
  const answer = useMutation(api.sets.answer);
  const markLegal = useMutation(api.sets.markLegal);
  const makeLawyerLink = useMutation(api.sets.makeLawyerLink);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // free-text drafts, and which questions have the text box open
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [writing, setWriting] = useState<Record<string, boolean>>({});
  // the lawyer link just made on this page, and its errors
  const [lawyer, setLawyer] = useState<{ busy?: boolean; token?: string; error?: string; copied?: boolean }>({});

  // celebrate only when the last answer lands while the page is open, not on a revisit
  const status = set?.status;
  const lastStatus = useRef(status);
  useEffect(() => {
    if (lastStatus.current === "open" && status === "complete") {
      confetti();
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top: 0, behavior: still ? "auto" : "smooth" });
    }
    lastStatus.current = status;
  }, [status]);

  // when the chips overflow (long sets), keep the first unanswered one in view
  const steps = useRef<HTMLOListElement>(null);
  const firstOpen = set?.questions.findIndex((q) => q.answer === null && q.movedTo === null) ?? -1;
  useEffect(() => {
    const list = steps.current;
    const chip = firstOpen >= 0 ? list?.children[firstOpen] : undefined;
    if (!list || !(chip instanceof HTMLElement)) return;
    list.scrollTo({ left: chip.offsetLeft - (list.clientWidth - chip.offsetWidth) / 2, behavior: "smooth" });
  }, [firstOpen]);

  if (set === undefined) return <main className="notice">Loading…</main>;
  if (set === null) return <main className="notice">This link isn&apos;t valid.</main>;

  const open = set.status === "open";
  // questions moved to a lawyer link are answered there, not here
  const here = set.questions.filter((q) => q.movedTo === null);
  const total = here.length;
  const answered = here.filter((q) => q.answer !== null).length;
  const canMark = open && !set.lawyerLink;
  const marked = here.filter((q) => q.legal && q.answer === null).length;

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

  async function toggleLegal(questionId: Id<"questions">, legal: boolean) {
    setErrors((e) => ({ ...e, [questionId]: "" }));
    try {
      await markLegal({ token, questionId, legal });
    } catch (err) {
      const message = err instanceof ConvexError ? String(err.data) : "Couldn't save. Try again.";
      setErrors((e) => ({ ...e, [questionId]: message }));
    }
  }

  async function sendToLawyer() {
    const plural = marked === 1 ? "this question" : `these ${marked} questions`;
    if (!window.confirm(`Move ${plural} to a new link for your lawyer? You'll answer them there, not here.`)) return;
    setLawyer({ busy: true });
    try {
      setLawyer({ token: await makeLawyerLink({ token }) });
      window.scrollTo({ top: 0 });
    } catch (err) {
      setLawyer({ error: err instanceof ConvexError ? String(err.data) : "Couldn't make the link. Try again." });
    }
  }

  const lawyerUrl = lawyer.token ? `${window.location.origin}/${lawyer.token}` : "";

  async function copyLawyerUrl() {
    try {
      await navigator.clipboard.writeText(lawyerUrl);
      setLawyer((l) => ({ ...l, copied: true }));
    } catch {
      window.prompt("Copy the link:", lawyerUrl);
    }
  }

  return (
    <main className={marked > 0 && canMark ? "has-bar" : undefined}>
      <div className="tools">
        <button className="tool" onClick={() => window.print()}>
          Save as PDF
        </button>
      </div>
      <h1>{set.title}</h1>
      <p className={set.status === "complete" ? "lead done" : "lead"}>
        {set.status === "complete"
          ? "All answers are recorded. Thank you!"
          : set.status === "expired"
            ? "This link has expired. Answers given before it expired are recorded."
            : `Tap one option per question, or write your own under "${OTHER_LABEL}". Each answer saves on its own and you can change it until the last one is answered.`}
      </p>
      <p className="note">
        {set.status === "complete"
          ? "The dev team is notified automatically."
          : "The dev team is notified automatically once all decisions are in."}
      </p>
      {set.lawyerLink && open && (
        <p className="note">These questions are for your session with the lawyer. Save as PDF if they need time to look.</p>
      )}
      {canMark && (
        <p className="note">
          Need your lawyer for some? Mark them &ldquo;Needs lawyer&rdquo;, then make a separate link with just those.
        </p>
      )}
      {lawyer.token && (
        <div className="lawyer-ready" role="status">
          <strong>Lawyer link ready</strong>
          <a href={`/${lawyer.token}`}>{lawyerUrl}</a>
          <button className="tool" onClick={copyLawyerUrl}>
            {lawyer.copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}

      <nav className="progress" aria-label="Progress">
        <div className="progress-row">
          <ol className="steps" ref={steps}>
            {set.questions.map((q, i) => (
              <li key={q.id}>
                <a
                  href={`#q${i + 1}`}
                  className={q.movedTo !== null ? "step moved" : q.answer !== null ? "step done" : "step"}
                  aria-label={`Question ${i + 1}, ${q.movedTo !== null ? "moved to the lawyer link" : q.answer !== null ? "answered" : "not answered"}`}
                >
                  {i + 1}
                </a>
              </li>
            ))}
          </ol>
          <span className="count">
            {answered} of {total} answered
          </span>
        </div>
        <div
          className="bar"
          role="progressbar"
          aria-label="Questions answered"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={answered}
        >
          <span style={{ width: `${(answered / total) * 100}%` }} />
        </div>
      </nav>

      {set.questions.map((q, i) => {
        if (q.movedTo !== null) {
          return (
            <section className="card moved" id={`q${i + 1}`} key={q.id} aria-labelledby={`q${i + 1}-title`}>
              <header className="card-head">
                <span className="num" aria-hidden="true">
                  {i + 1}
                </span>
                <div>
                  <div className="eyebrow">
                    <span>
                      Question {i + 1} of {set.questions.length}
                    </span>
                    <span className="state">For the lawyer</span>
                  </div>
                  <h2 id={`q${i + 1}-title`}>{q.title}</h2>
                </div>
              </header>
              <p className="moved-note">
                Moved to the <a href={`/${q.movedTo}`}>lawyer link</a>. Answer it there.
              </p>
            </section>
          );
        }
        const chosen = pending[q.id] ?? q.answer;
        const showText = open && (writing[q.id] ?? chosen === OTHER);
        const text = texts[q.id] ?? q.answerText ?? "";
        const done = q.answer !== null;
        return (
          <section
            className={done ? "card answered" : !open ? "card" : q.legal ? "card waiting legal" : "card waiting"}
            id={`q${i + 1}`}
            key={q.id}
            aria-labelledby={`q${i + 1}-title`}
          >
            <header className="card-head">
              <span className="num" aria-hidden="true">
                {done ? "✓" : i + 1}
              </span>
              <div>
                <div className="eyebrow">
                  <span>
                    Question {i + 1} of {set.questions.length}
                  </span>
                  <span className="state">
                    {q.id in pending ? "Saving…" : done ? "Answered" : q.legal && open ? "Needs lawyer" : "Not answered"}
                  </span>
                </div>
                <h2 id={`q${i + 1}-title`}>{q.title}</h2>
              </div>
            </header>
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
              className="option other"
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
            {canMark && !done && (
              <button className="legal-toggle" aria-pressed={q.legal} onClick={() => toggleLegal(q.id, !q.legal)}>
                {q.legal ? "✓ Needs lawyer (tap to undo)" : "Needs lawyer"}
              </button>
            )}
            {errors[q.id] && <p className="error">{errors[q.id]}</p>}
          </section>
        );
      })}

      {canMark && marked > 0 && (
        <div className="lawyer-bar">
          <span>
            {marked} marked for the lawyer
            {lawyer.error && <em className="error">{lawyer.error}</em>}
          </span>
          <button className="save" disabled={lawyer.busy} onClick={sendToLawyer}>
            {lawyer.busy ? "Making link…" : "Make lawyer link"}
          </button>
        </div>
      )}
    </main>
  );
}
