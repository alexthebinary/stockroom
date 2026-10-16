/** Nothing is claimed unless the app is healthy on the deploy tip and the implementation lane is ready. */
export async function preflight({ cfg, journal, runner, fetchImpl = fetch }) {
  const halted = journal.halted();
  if (halted) return { ok: false, reason: `halted (${halted})` };

  const fetched = await runner("git", ["-C", cfg.repo, "fetch", "--quiet", "origin", cfg.branch], { timeoutMs: 120_000 });
  if (fetched.code !== 0) return { ok: false, reason: `git fetch: ${fetched.stderr.trim().slice(0, 200)}` };
  const tip = await runner("git", ["-C", cfg.repo, "rev-parse", `origin/${cfg.branch}`], { timeoutMs: 30_000 });
  const base = tip.stdout.trim();
  if (tip.code !== 0 || !base) return { ok: false, reason: "git rev-parse: deploy tip unreadable" };
  const short = base.slice(0, 7);

  let health;
  try {
    const response = await fetchImpl(`${cfg.api}/api/health`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { ok: false, reason: "health check failed (HTTP status)" };
    health = await response.json();
  } catch {
    return { ok: false, reason: "health check failed (app down?)" };
  }
  if (!health?.ok) return { ok: false, reason: "health check failed (database?)" };
  if (health.build !== short) return { ok: false, reason: `live build ${health.build} is not the deploy tip ${short} (mid-deploy?)` };

  if (cfg.implLane === "local") {
    const local = await runner("local-llm", ["status"], { timeoutMs: 30_000 });
    if (local.code !== 0 || local.timedOut || !/^health:\s*ok\s*$/m.test(local.stdout)) return { ok: false, reason: "local model not healthy" };
    if (/\bq36-cpu\b/.test(local.stdout)) return { ok: false, reason: "local model in CPU mode (slow); run: local-llm q36-hybrid" };
  } else {
    let limits;
    try {
      const quota = await runner("python3", ["-c", "import sys,os,json; sys.path.insert(0, os.path.expanduser('~/.claude')); import statusline_agents as s; print(json.dumps(s.codex_limits() or {}))"], { timeoutMs: 60_000 });
      if (quota.code !== 0) return { ok: false, reason: "codex quota unreadable" };
      limits = JSON.parse(quota.stdout);
    } catch {
      return { ok: false, reason: "codex quota unreadable" };
    }
    const primary = limits?.primary?.used_percent;
    const secondary = limits?.secondary?.used_percent;
    if (!Number.isFinite(primary)) return { ok: false, reason: "codex quota unreadable" };
    if (primary >= 90) return { ok: false, reason: `codex quota: 5h window at ${Math.round(primary)}%` };
    if (secondary >= 95) return { ok: false, reason: `codex quota: 7-day window at ${Math.round(secondary)}%` };
  }

  const image = await runner("docker", ["inspect", "profitindex-app-1", "--format", "{{.Image}}"], { timeoutMs: 30_000 });
  const baseImage = image.stdout.trim();
  if (image.code !== 0 || !baseImage) return { ok: false, reason: `live image ${baseImage || "?"} is not build ${short}` };
  const imageEnv = await runner("docker", ["image", "inspect", baseImage, "--format", "{{range .Config.Env}}{{println .}}{{end}}"], { timeoutMs: 30_000 });
  if (imageEnv.code !== 0 || !imageEnv.stdout.split(/\r?\n/).includes(`APP_VERSION=${short}`)) {
    return { ok: false, reason: `live image ${baseImage} is not build ${short}` };
  }
  return { ok: true, base, short, baseImage };
}
