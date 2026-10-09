/**
 * A push to the owner's phone through ntfy (https://ntfy.sh): set NOTIFY_URL to
 * https://ntfy.sh/<a private topic name> and subscribe to that topic in the
 * ntfy app. Unset, nothing is sent. Never blocks or fails the request.
 */
export function notify(title: string, message: string, options: { click?: string; tags?: string[] } = {}) {
  const raw = process.env.NOTIFY_URL;
  if (!raw) return;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  const topic = url.pathname.replace(/^\/+/, "");
  fetch(url.origin, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic, title, message, tags: options.tags, click: options.click }),
  }).catch(() => {});
}
