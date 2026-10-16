import { spawn } from "node:child_process";

/** One child process with a hard deadline; the whole process group dies on timeout. Never inherits ANTHROPIC_API_KEY (Claude runs on the plan login). */
export function run(cmd, args, { cwd, env = process.env, timeoutMs = 600_000, input } = {}) {
  const childEnv = { ...env }; delete childEnv.ANTHROPIC_API_KEY;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: childEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + String(e), timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: timedOut ? null : code, stdout, stderr, timedOut }); });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}
