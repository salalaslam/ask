import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";

async function setByToken(ctx: QueryCtx, token: string) {
  return await ctx.db
    .query("sets")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
}

// What the answer page sees: the questions and answers so far, nothing internal.
export const get = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const set = await setByToken(ctx, token);
    if (!set || set.status === "revoked") return null;
    const status = set.status === "open" && set.expiresAt < Date.now() ? "expired" : set.status;
    const questions = await ctx.db
      .query("questions")
      .withIndex("by_set", (q) => q.eq("setId", set._id))
      .collect();
    return {
      title: set.title,
      status,
      questions: questions.map((q) => ({
        id: q._id,
        title: q.title,
        context: q.context,
        options: q.options,
        answer: q.answer ?? null,
      })),
    };
  },
});

export const answer = mutation({
  args: { token: v.string(), questionId: v.id("questions"), optionId: v.string() },
  handler: async (ctx, { token, questionId, optionId }) => {
    const set = await setByToken(ctx, token);
    if (!set || set.status !== "open" || set.expiresAt < Date.now()) {
      throw new ConvexError("This link is closed.");
    }
    const question = await ctx.db.get(questionId);
    if (!question || question.setId !== set._id) throw new ConvexError("Unknown question.");
    if (!question.options.some((o) => o.id === optionId)) throw new ConvexError("Unknown option.");

    const now = Date.now();
    await ctx.db.patch(questionId, { answer: optionId, answeredAt: now });

    const questions = await ctx.db
      .query("questions")
      .withIndex("by_set", (q) => q.eq("setId", set._id))
      .collect();
    if (questions.every((q) => (q._id === questionId ? true : q.answer !== undefined))) {
      await ctx.db.patch(set._id, { status: "complete", completedAt: now });
    }
  },
});
