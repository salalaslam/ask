import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { MAX_TEXT, OTHER, settled } from "./answers";

const DAY = 24 * 60 * 60 * 1000;
// lawyers may need longer than the usual 14 days
const LAWYER_DAYS = 30;

async function setByToken(ctx: QueryCtx, token: string) {
  return await ctx.db
    .query("sets")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
}

async function openSet(ctx: QueryCtx, token: string) {
  const set = await setByToken(ctx, token);
  if (!set || set.status !== "open" || set.expiresAt < Date.now()) {
    throw new ConvexError("This link is closed.");
  }
  return set;
}

async function questionsOf(ctx: QueryCtx, set: Doc<"sets">) {
  return await ctx.db
    .query("questions")
    .withIndex("by_set", (q) => q.eq("setId", set._id))
    .collect();
}

// The tokens of the lawyer links questions moved to, by set id.
export async function movedTokens(ctx: QueryCtx, questions: Doc<"questions">[]) {
  const moved = new Map<string, string>();
  for (const id of new Set(questions.flatMap((q) => (q.movedTo ? [q.movedTo] : [])))) {
    const target = await ctx.db.get(id);
    if (target) moved.set(id, target.token);
  }
  return moved;
}

// Letters and digits only, like the CLI's tokens. Convex seeds this server-side.
function randomToken(length = 24) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  while (token.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < 248 && token.length < length) token += alphabet[byte % 62]; // 248 = 4 * 62, no modulo bias
    }
  }
  return token;
}

// What the answer page sees: the questions and answers so far, nothing internal.
export const get = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const set = await setByToken(ctx, token);
    if (!set || set.status === "revoked") return null;
    const status = set.status === "open" && set.expiresAt < Date.now() ? "expired" : set.status;
    const questions = await questionsOf(ctx, set);
    const moved = await movedTokens(ctx, questions);
    return {
      title: set.title,
      status,
      // a lawyer link can't send its questions on again
      lawyerLink: set.parent !== undefined,
      questions: questions.map((q) => ({
        id: q._id,
        title: q.title,
        context: q.context,
        options: q.options,
        answer: q.answer ?? null,
        answerText: q.answerText ?? null,
        legal: q.legal ?? false,
        movedTo: (q.movedTo && moved.get(q.movedTo)) ?? null,
      })),
    };
  },
});

export const answer = mutation({
  args: {
    token: v.string(),
    questionId: v.id("questions"),
    optionId: v.string(),
    text: v.optional(v.string()),
  },
  handler: async (ctx, { token, questionId, optionId, text }) => {
    const set = await openSet(ctx, token);
    const question = await ctx.db.get(questionId);
    if (!question || question.setId !== set._id) throw new ConvexError("Unknown question.");
    if (question.movedTo) throw new ConvexError("This question moved to the lawyer link.");
    const answerText = text?.trim() ?? "";
    if (optionId === OTHER) {
      if (!answerText) throw new ConvexError("Write your answer first.");
      if (answerText.length > MAX_TEXT) throw new ConvexError(`Keep it under ${MAX_TEXT} characters.`);
    } else if (!question.options.some((o) => o.id === optionId)) {
      throw new ConvexError("Unknown option.");
    }

    const now = Date.now();
    // answering it here means it no longer needs the lawyer
    await ctx.db.patch(questionId, {
      answer: optionId,
      answerText: optionId === OTHER ? answerText : undefined,
      answeredAt: now,
      legal: undefined,
    });

    const questions = await questionsOf(ctx, set);
    if (questions.every((q) => q._id === questionId || settled(q))) {
      await ctx.db.patch(set._id, { status: "complete", completedAt: now });
    }
  },
});

// Marks an unanswered question as needing the lawyer, or unmarks it.
export const markLegal = mutation({
  args: { token: v.string(), questionId: v.id("questions"), legal: v.boolean() },
  handler: async (ctx, { token, questionId, legal }) => {
    const set = await openSet(ctx, token);
    if (set.parent !== undefined) throw new ConvexError("This is already the lawyer link.");
    const question = await ctx.db.get(questionId);
    if (!question || question.setId !== set._id) throw new ConvexError("Unknown question.");
    if (question.movedTo) throw new ConvexError("This question moved to the lawyer link.");
    if (legal && question.answer !== undefined) throw new ConvexError("This question is already answered.");
    await ctx.db.patch(questionId, { legal: legal || undefined });
  },
});

// Moves the marked questions to a new link of their own, which keeps their brief
// items and Toucan thread so answering it closes them like the original would.
export const makeLawyerLink = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const set = await openSet(ctx, token);
    if (set.parent !== undefined) throw new ConvexError("This is already the lawyer link.");
    const questions = await questionsOf(ctx, set);
    const marked = questions.filter((q) => q.legal && q.answer === undefined && !q.movedTo);
    if (marked.length === 0) throw new ConvexError("Mark the questions that need the lawyer first.");

    const now = Date.now();
    const lawyerToken = randomToken();
    const lawyerId = await ctx.db.insert("sets", {
      token: lawyerToken,
      title: `For the lawyer: ${set.title}`,
      expiresAt: now + LAWYER_DAYS * DAY,
      status: "open",
      parent: set._id,
      ...(set.thread && { thread: set.thread }),
    });
    for (const [order, q] of marked.entries()) {
      await ctx.db.insert("questions", {
        setId: lawyerId,
        order,
        ...(q.briefId !== undefined && { briefId: q.briefId }),
        title: q.title,
        context: q.context,
        options: q.options,
      });
      await ctx.db.patch(q._id, { legal: undefined, movedTo: lawyerId });
    }
    if (questions.every((q) => settled(q) || marked.includes(q))) {
      await ctx.db.patch(set._id, { status: "complete", completedAt: now });
    }
    return lawyerToken;
  },
});
