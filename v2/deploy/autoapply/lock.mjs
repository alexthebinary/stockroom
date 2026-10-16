import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Hold B1's deploy lock for real: a flock child keeps it until release() closes its stdin. */
export function acquire(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true });
  return new Promise((resolve) => {
    const child = spawn("flock", ["-n", "-E", "75", lockPath, "sh", "-c", "echo LOCKED; exec cat >/dev/null"], { stdio: ["pipe", "pipe", "ignore"] });
    let settled = false;
    child.stdout.on("data", (d) => {
      if (settled || !String(d).includes("LOCKED")) return;
      settled = true;
      resolve(() => new Promise((done) => { child.once("close", () => done()); child.stdin.end(); }));
    });
    child.on("close", () => { if (!settled) { settled = true; resolve(null); } });
  });
}

export async function withLock(lockPath, fn, { tries = 20, waitMs = 30_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 0; i < tries; i++) {
    const release = await acquire(lockPath);
    if (release) { try { return await fn(); } finally { await release(); } }
    await sleep(waitMs);
  }
  return { busy: true };
}
