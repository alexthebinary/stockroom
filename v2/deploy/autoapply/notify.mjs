export async function notify(cfg, title, body, fetchImpl = fetch) {
  if (!cfg.notifyUrl) return;
  try { await fetchImpl(cfg.notifyUrl, { method: "POST", headers: { Title: title }, body, signal: AbortSignal.timeout(10_000) }); } catch { /* an alert must never break the run */ }
}
