// Internal functions: only callable with deployment access (`convex run --prod`),
// which is what the `ask` CLI uses. The answer page can't reach these.
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { option } from "./schema";

const DAY = 24 * 60 * 60 * 1000;

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
    for (const q of questions) {
      const ids = q.options.map((o) => o.id);
      if (ids.length < 2 || new Set(ids).size !== ids.length) {
        throw new ConvexError(`"${q.title}" needs at least two options with distinct ids.`);
      }
    }
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
      answerLabel: q.options.find((o) => o.id === q.answer)?.label ?? null,
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
