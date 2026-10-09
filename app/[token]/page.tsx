import { Suspense } from "react";
import { Answers } from "./Answers";

export default function AnswerPage({ params }: PageProps<"/[token]">) {
  return (
    <Suspense fallback={<main className="notice">Loading…</main>}>
      <Answers params={params} />
    </Suspense>
  );
}
