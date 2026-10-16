/** The ProfitIndex feedback API as the daily job uses it (Plan A routes). */
export function createFeedback({ api, token, fetchImpl = fetch }) {
  const call = async (method, path, body) => {
    try {
      const r = await fetchImpl(`${api}${path}`, { method, headers: { "content-type": "application/json", "x-auto-token": token }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      if (!r.ok) return { ok: false, status: r.status };
      return { ok: true, row: await r.json() };
    } catch { return { ok: false, status: 0 }; }
  };
  return {
    list: () => call("GET", "/api/feedback?turns=1"),
    claim: (id, runId, revision) => call("POST", `/api/feedback/${id}/auto/claim`, { runId, revision }),
    outcome: (id, body) => call("POST", `/api/feedback/${id}/auto/outcome`, body),
    question: (id, runId, revision, text) => call("POST", `/api/feedback/${id}/auto/question`, { runId, revision, text }),
    release: (id, runId, revision) => call("POST", `/api/feedback/${id}/auto/release`, { runId, revision }),
  };
}
