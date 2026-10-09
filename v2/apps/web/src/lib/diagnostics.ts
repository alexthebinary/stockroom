/**
 * What the device knew when someone reported a problem: the last few errors
 * (script errors and failed API calls), the screen and the build. Sent with
 * beta feedback so a bug report arrives with its evidence.
 */
declare const __APP_BUILD__: string;

type Problem = { at: string; message: string };
const recent: Problem[] = [];

export function recordProblem(message: string) {
  recent.push({ at: new Date().toISOString().slice(11, 19), message: message.slice(0, 300) });
  if (recent.length > 15) recent.shift();
}

export function watchProblems() {
  window.addEventListener("error", (event) => recordProblem(event.message));
  window.addEventListener("unhandledrejection", (event) => recordProblem(String(event.reason?.message ?? event.reason)));
}

export function deviceContext() {
  return {
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}×${window.innerHeight}`,
    colorScheme: document.documentElement.dataset.mantineColorScheme ?? "",
    standalone: window.matchMedia("(display-mode: standalone)").matches,
    build: typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : "dev",
    errors: [...recent],
  };
}
