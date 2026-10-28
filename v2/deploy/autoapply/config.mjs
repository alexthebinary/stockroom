import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const envFile = (path, read) => {
  try { return Object.fromEntries(read(path, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])); }
  catch { return {}; }
};

/** Everything the daily job needs to know, from the environment and the deploy .env. */
export function loadConfig(env = process.env, read = readFileSync) {
  const repo = env.PI_REPO ?? "/opt/stockroom";
  const base = env.PI_STATE_DIR ?? join(homedir(), ".local/state");
  const stateDir = join(base, "profitindex-autoapply");
  const dot = envFile(join(repo, "v2/deploy/.env"), read);
  const minutes = (name, d) => Number(env[name] ?? d) * 60_000;
  const implLane = env.AUTO_IMPL_LANE ?? "claude";   // claude | local | codex; claude falls back to local (Codex replaced 2026-10-28)
  return {
    repo, branch: env.PI_BRANCH ?? "profitindex", api: env.PI_API ?? "http://127.0.0.1:4100",
    base, stateDir, workDir: join(stateDir, "work"), deployLock: join(base, "profitindex-deploy.lock"),
    receiptsDir: join(base, "profitindex-deploy"), haltFile: join(stateDir, "HALT"),
    authors: (env.AUTO_AUTHORS ?? "Serhii,t").split(",").map((s) => s.trim()).filter(Boolean),
    implLane, maxPerRun: Number(env.AUTO_MAX_PER_RUN ?? 3), token: env.AUTO_TOKEN ?? dot.AUTO_TOKEN ?? "", notifyUrl: env.NOTIFY_URL ?? dot.NOTIFY_URL ?? "",
    vaultLogDir: env.PI_VAULT_LOGS ?? join(homedir(), "Documents/obsidian-vault/openclaw-vault/logs"),
    dryRun: env.AUTO_DRY_RUN === "1",
    timeouts: { model: minutes("AUTO_MODEL_MIN", 10), codex: minutes("AUTO_CODEX_MIN", 90), gate: minutes("AUTO_GATE_MIN", 25), migration: minutes("AUTO_MIGRATION_MIN", 30), deploy: minutes("AUTO_DEPLOY_MIN", 20) },
  };
}
