import cors from "cors";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { authRouter } from "./routes/auth";
import { catalogsRouter } from "./routes/catalogs";
import { ledgerRouter } from "./routes/ledger";
import { reportsRouter } from "./routes/reports";
import { dashboardRouter } from "./routes/dashboard";
import { inventoryRouter } from "./routes/inventory";
import { productsRouter } from "./routes/products";
import { purchaseOrdersRouter } from "./routes/purchaseOrders";
import { salesOrdersRouter } from "./routes/salesOrders";
import { stockAdjustmentsRouter } from "./routes/stockAdjustments";
import { stockTransfersRouter } from "./routes/stockTransfers";
import { warehousesRouter } from "./routes/warehouses";
import { errorMiddleware } from "./http";
import { basicAuthGate } from "./auth-gate";

const app = express();

// Behind a tunnel or reverse proxy, trust the forwarded headers so redirects
// and logging see the real client rather than the proxy.
app.set("trust proxy", true);

app.use(cors());
app.use(express.json());

// Everything below this line is gated when BASIC_AUTH_* are set.
app.use(basicAuthGate());

app.get("/api/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.use("/api/auth", authRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/products", productsRouter);
app.use("/api/warehouses", warehousesRouter);
app.use("/api/sales-orders", salesOrdersRouter);
app.use("/api/purchase-orders", purchaseOrdersRouter);
app.use("/api/stock-adjustments", stockAdjustmentsRouter);
app.use("/api/stock-transfers", stockTransfersRouter);
app.use("/api/reports", reportsRouter);
// catalogsRouter and ledgerRouter each own several sibling paths, so like
// inventoryRouter they mount at the API root.
app.use("/api", catalogsRouter);
app.use("/api", ledgerRouter);
// inventoryRouter owns two unrelated paths, so it mounts at the API root.
app.use("/api", inventoryRouter);

/**
 * Single-process mode.
 *
 * When the frontend has been built, serve it from here so the whole app is one
 * process on one port. That removes the dev proxy, removes CORS from the
 * picture entirely, and gives a tunnel a single origin to forward — which is
 * what makes remote access straightforward instead of fiddly.
 */
// __dirname differs between running from source (src/) and from the compiled
// output (dist/src/), so try both rather than assuming one layout.
const distDir = [
  path.resolve(__dirname, "../../frontend/dist"),
  path.resolve(__dirname, "../../../frontend/dist"),
].find((candidate) => fs.existsSync(path.join(candidate, "index.html")));
const indexHtml = distDir ? path.join(distDir, "index.html") : null;
const servingUi = Boolean(indexHtml);

if (servingUi && distDir) {
  app.use(express.static(distDir, { index: false }));
}

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

if (servingUi && indexHtml) {
  // Any non-API path is a client-side route, so hand back the SPA shell and
  // let the router decide. Registered last so it cannot shadow the API.
  app.get("*", (_req, res) => res.sendFile(indexHtml));
} else {
  app.use((_req, res) =>
    res.status(404).json({
      error: "Not found. Build the frontend (npm run build) to serve the UI from this port.",
    })
  );
}

app.use(errorMiddleware);

const port = Number(process.env.PORT ?? 4000);
// Bound to loopback on purpose. Every route here is unauthenticated, and the
// browser never calls it directly — the Vite dev server proxies /api to it from
// the same machine. Set HOST=0.0.0.0 only if you know why you want that.
const host = process.env.HOST ?? "127.0.0.1";
app.listen(port, host, () => {
  const gated = Boolean(process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASSWORD);
  console.log(`Stockroom listening on http://${host}:${port}`);
  console.log(`  UI:         ${servingUi ? "served from frontend/dist" : "not built — API only"}`);
  console.log(`  Basic auth: ${gated ? "ON" : "OFF (set BASIC_AUTH_USER/PASSWORD to enable)"}`);
});
