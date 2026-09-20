import { createApp, servingUiFlag } from "./app";
import { ensureBootstrapAdmin } from "./auth";
import { syncChartOfAccounts } from "./accounts";
import { ensureDocumentCounters } from "./numbering";

const app = createApp();

const port = Number(process.env.PORT ?? 4000);
// Bound to loopback on purpose. Every route here is unauthenticated, and the
// browser never calls it directly — the Vite dev server proxies /api to it from
// the same machine. Set HOST=0.0.0.0 only if you know why you want that.
const host = process.env.HOST ?? "127.0.0.1";
// The chart must match the code before the first request, or a posting path
// that references a newly added account fails at runtime. Insert-only, and a
// no-op once the chart is current.
syncChartOfAccounts()
  .then((added) => {
    if (added.length) console.log(`Chart of accounts: added ${added.join(", ")}`);
    return ensureDocumentCounters();
  })
  .then((seeded) => {
    if (seeded?.length) console.log(`Document counters: seeded ${seeded.join(", ")}`);
    return ensureBootstrapAdmin();
  })
  .then((admin) => {
    if (!admin) return;
    console.log(`Created the first administrator: ${admin.email}`);
    if (admin.password) {
      console.log(`  One-time password: ${admin.password}`);
      console.log("  Change it after signing in, or set ADMIN_PASSWORD and redeploy.");
    }
  })
  .catch((err) => console.error("Startup reconciliation failed:", err));

app.listen(port, host, () => {
  const gated = Boolean(process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASSWORD);
  console.log(`Stockroom listening on http://${host}:${port}`);
  console.log(`  UI:         ${servingUiFlag ? "served from frontend/dist" : "not built — API only"}`);
  console.log(`  Basic auth: ${gated ? "ON" : "OFF (set BASIC_AUTH_USER/PASSWORD to enable)"}`);
});
