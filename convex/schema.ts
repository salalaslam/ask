import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// chooseIf is the condition shown as "Choose this if …"; suits marks who an
// option works best for: "us" (dev) and/or "you" (products)
export const option = v.object({
  id: v.string(),
  label: v.string(),
  detail: v.optional(v.string()),
  chooseIf: v.optional(v.string()),
  suits: v.optional(v.array(v.union(v.literal("us"), v.literal("you")))),
});

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
    // set once the poller has closed brief items and delivered every notice for
    // a finished set; progressAt is the latest answeredAt a progress notice covered
    reportedAt: v.optional(v.number()),
    progressAt: v.optional(v.number()),
    // Toucan thread key (toucan.toml [threads]) whose agent waits on the answers
    thread: v.optional(v.string()),
    // the link this one was made from with "Make lawyer link"
    parent: v.optional(v.id("sets")),
  })
    .index("by_token", ["token"])
    .index("by_status", ["status"]),

  questions: defineTable({
    setId: v.id("sets"),
    order: v.number(),
    briefId: v.optional(v.number()),
    title: v.string(),
    context: v.string(),
    options: v.array(option),
    answer: v.optional(v.string()),
    answerText: v.optional(v.string()),
    answeredAt: v.optional(v.number()),
    // when the poller closed this question's brief item
    closedAt: v.optional(v.number()),
    // marked "Needs lawyer" on the page; movedTo is the lawyer link it went to,
    // after which this set no longer waits on it
    legal: v.optional(v.boolean()),
    movedTo: v.optional(v.id("sets")),
  }).index("by_set", ["setId", "order"]),
});
