// Every question also offers a free-text answer, saved with this option id.
export const OTHER = "other";
export const OTHER_LABEL = "Something else";
export const MAX_TEXT = 1000;

// A question moved to a lawyer link counts as settled on the link it left.
export const settled = (q: { answer?: string; movedTo?: unknown }) => q.answer !== undefined || q.movedTo !== undefined;
