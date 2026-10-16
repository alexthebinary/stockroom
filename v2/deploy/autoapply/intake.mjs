/** Decide eligibility before applying the cap, so waiting notes cannot starve new work. */
export function eligible(notes, { authors, maxPerRun }) {
  const retryable = new Set(["NEEDS_ANSWER", "FAILED", "SHIPPED"]);
  return notes
    .filter((n) => n.status === "OPEN" && authors.includes(n.author) && n.autoClaim == null)
    .filter((n) => !retryable.has(n.autoState) || n.revision > (n.autoRevision ?? 0))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id - b.id)
    .slice(0, maxPerRun);
}
