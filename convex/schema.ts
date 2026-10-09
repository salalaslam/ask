import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  sets: defineTable({
    token: v.string(),
    title: v.string(),
    expiresAt: v.number(),
    // open until every question is answered, then complete; expired is set by
    // the poller once expiresAt passes, revoked by `ask revoke`
    status: v.union(
      v.literal("open"),
      v.literal("complete"),
      v.literal("expired"),
      v.literal("revoked"),
    ),
    completedAt: v.optional(v.number()),
    reportedAt: v.optional(v.number()),
  })
    .index("by_token", ["token"])
    .index("by_status", ["status"]),

  questions: defineTable({
    setId: v.id("sets"),
    order: v.number(),
    briefId: v.optional(v.number()),
    title: v.string(),
    context: v.string(),
    options: v.array(
      v.object({ id: v.string(), label: v.string(), detail: v.optional(v.string()) }),
    ),
    answer: v.optional(v.string()),
    answeredAt: v.optional(v.number()),
  }).index("by_set", ["setId", "order"]),
});
