import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { notify } from "./notify.mjs";
export async function writeReport({ cfg, result, fetchImpl }) {
  const day = new Date().toISOString().slice(0, 10);
  const line = `${result.dryRun ? "DRY RUN · " : ""}shipped ${result.shipped.map((i) => `#${i}`).join(" ") || "—"} · failed ${result.failed.map((f) => `${f.id ? `#${f.id}` : "run"} (${f.reason})`).join(", ") || "—"} · waiting ${result.waiting.map((i) => `#${i}`).join(" ") || "—"}${result.deferred.length ? ` · deferred ${result.deferred.map((i) => `#${i}`).join(" ")}` : ""}`;
  await notify(cfg, `Auto-apply ${day}: ${result.outcome}`, line, fetchImpl);
  try {
    mkdirSync(cfg.vaultLogDir, { recursive: true });
    const file = join(cfg.vaultLogDir, `${day}-profitindex-autoapply.md`);
    const head = existsSync(file) ? "" : `---\ntitle: ProfitIndex auto-apply ${day}\ntype: log\ndate: ${day}\ntags:\n  - log\n  - profitindex\n---\n\n`;
    writeFileSync(file, `${head}- ${result.runId} **${result.outcome}** — ${line}\n`, { flag: "a" });
  } catch { /* the vault being absent never fails a run */ }
}
