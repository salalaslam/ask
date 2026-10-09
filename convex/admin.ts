// Internal functions: only callable with deployment access (`convex run --prod`),
// which is what the `ask` CLI uses. The answer page can't reach these.
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { OTHER, OTHER_LABEL } from "./answers";
import { option } from "./schema";

const DAY = 24 * 60 * 60 * 1000;

function checkOptions(q: { title: string; options: { id: string }[] }) {
  const ids = q.options.map((o) => o.id);
  if (ids.length < 2 || new Set(ids).size !== ids.length) {
    throw new ConvexError(`"${q.title}" needs at least two options with distinct ids.`);
  }
  if (ids.includes(OTHER)) throw new ConvexError(`"${OTHER}" is reserved for the free-text answer.`);
}

export const create = internalMutation({
  args: {
    token: v.string(),
    title: v.string(),
    ttlDays: v.number(),
    questions: v.array(
      v.object({
        briefId: v.optional(v.number()),
        title: v.string(),
        context: v.string(),
        options: v.array(option),
      }),
    ),
  },
  handler: async (ctx, { token, title, ttlDays, questions }) => {
    if (token.length < 20) throw new ConvexError("Token too short.");
    if (questions.length === 0) throw new ConvexError("No questions.");
    questions.forEach(checkOptions);
    const setId = await ctx.db.insert("sets", {
      token,
      title,
      expiresAt: Date.now() + ttlDays * DAY,
      status: "open",
    });
    for (const [order, q] of questions.entries()) {
      await ctx.db.insert("questions", { setId, order, ...q });
    }
    return setId;
  },
});

export const revoke = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const set = await ctx.db
      .query("sets")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!set) throw new ConvexError("No set with that token.");
    if (set.status !== "open") throw new ConvexError(`Set is already ${set.status}.`);
    await ctx.db.patch(set._id, { status: "revoked", reportedAt: Date.now() });
  },
});

async function openSetQuestions(ctx: QueryCtx, token: string) {
  const set = await ctx.db
    .query("sets")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (!set) throw new ConvexError("No set with that token.");
  if (set.status !== "open") throw new ConvexError(`Set is already ${set.status}.`);
  const questions = await ctx.db
    .query("questions")
    .withIndex("by_set", (q) => q.eq("setId", set._id))
    .collect();
  return { set, questions };
}

export const retitle = internalMutation({
  args: { token: v.string(), title: v.string() },
  handler: async (ctx, { token, title }) => {
    const { set } = await openSetQuestions(ctx, token);
    await ctx.db.patch(set._id, { title });
  },
});

// Only open sets can change. Questions are addressed by their 1-based number on the page.
export const addOption = internalMutation({
  args: { token: v.string(), question: v.number(), option },
  handler: async (ctx, { token, question, option }) => {
    const { questions } = await openSetQuestions(ctx, token);
    const target = questions[question - 1];
    if (!target) throw new ConvexError(`No question ${question}.`);
    if (option.id === OTHER || target.options.some((o) => o.id === option.id)) {
      throw new ConvexError(`Question ${question} already has an option "${option.id}".`);
    }
    await ctx.db.patch(target._id, { options: [...target.options, option] });
  },
});

export const addQuestion = internalMutation({
  args: {
    token: v.string(),
    after: v.optional(v.number()),
    question: v.object({
      briefId: v.optional(v.number()),
      title: v.string(),
      context: v.string(),
      options: v.array(option),
    }),
  },
  handler: async (ctx, { token, after, question }) => {
    checkOptions(question);
    const { set, questions } = await openSetQuestions(ctx, token);
    const at = after ?? questions.length;
    if (at < 0 || at > questions.length) throw new ConvexError(`No question ${at}.`);
    const before = at === 0 ? -1 : questions[at - 1].order;
    const next = questions[at]?.order ?? before + 2;
    await ctx.db.insert("questions", { setId: set._id, order: (before + next) / 2, ...question });
  },
});

// If every remaining question is answered, the set completes as if the last answer just came in.
export const removeQuestion = internalMutation({
  args: { token: v.string(), question: v.number() },
  handler: async (ctx, { token, question }) => {
    const { set, questions } = await openSetQuestions(ctx, token);
    const target = questions[question - 1];
    if (!target) throw new ConvexError(`No question ${question}.`);
    if (questions.length === 1) throw new ConvexError("Can't remove the only question; revoke the link instead.");
    await ctx.db.delete(target._id);
    if (questions.every((q) => q._id === target._id || q.answer !== undefined)) {
      await ctx.db.patch(set._id, { status: "complete", completedAt: Date.now() });
    }
  },
});

async function withQuestions(ctx: QueryCtx, set: Doc<"sets">) {
  const questions = await ctx.db
    .query("questions")
    .withIndex("by_set", (q) => q.eq("setId", set._id))
    .collect();
  return {
    id: set._id,
    token: set.token,
    title: set.title,
    status: set.status,
    expiresAt: set.expiresAt,
    reportedAt: set.reportedAt ?? null,
    questions: questions.map((q) => ({
      briefId: q.briefId ?? null,
      title: q.title,
      answer: q.answer ?? null,
      answerLabel:
        q.answer === OTHER
          ? `${OTHER_LABEL}: ${q.answerText}`
          : (q.options.find((o) => o.id === q.answer)?.label ?? null),
    })),
  };
}

export const list = internalQuery({
  args: {},
  handler: async (ctx) => {
    const sets = await ctx.db.query("sets").order("desc").take(50);
    return await Promise.all(sets.map((s) => withQuestions(ctx, s)));
  },
});

// Marks open sets past their expiry as expired, then returns every complete or
// expired set the poller hasn't reported yet.
export const collect = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const set of await ctx.db
      .query("sets")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .collect()) {
      if (set.expiresAt < now) await ctx.db.patch(set._id, { status: "expired" });
    }
    const done = [
      ...(await ctx.db.query("sets").withIndex("by_status", (q) => q.eq("status", "complete")).collect()),
      ...(await ctx.db.query("sets").withIndex("by_status", (q) => q.eq("status", "expired")).collect()),
    ].filter((s) => s.reportedAt === undefined);
    return await Promise.all(done.map((s) => withQuestions(ctx, s)));
  },
});

export const markReported = internalMutation({
  args: { id: v.id("sets") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { reportedAt: Date.now() });
  },
});
