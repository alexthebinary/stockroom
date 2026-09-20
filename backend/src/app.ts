import cors from "cors";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { authRouter } from "./routes/auth";
import { catalogsRouter } from "./routes/catalogs";
import { ledgerRouter } from "./routes/ledger";
import { metaRouter } from "./routes/meta";
import { reportsRouter } from "./routes/reports";
import { dashboardRouter } from "./routes/dashboard";
import { inventoryRouter } from "./routes/inventory";
import { productsRouter } from "./routes/products";
import { purchaseOrdersRouter } from "./routes/purchaseOrders";
import { salesOrdersRouter } from "./routes/salesOrders";
import { stockAdjustmentsRouter } from "./routes/stockAdjustments";
import { stockCountsRouter } from "./routes/stockCounts";
import { stockTransfersRouter } from "./routes/stockTransfers";
import { warehousesRouter } from "./routes/warehouses";
import { receivingRouter } from "./routes/receiving";
import { errorMiddleware } from "./http";
import { basicAuthGate } from "./auth-gate";
import { attachUser, ensureBootstrapAdmin, requireSession } from "./auth";
import { syncChartOfAccounts } from "./accounts";
import { ensureDocumentCounters } from "./numbering";

/**
 * Build the Express app without starting it.
 *
 * Extracted from index.ts on 2026-09-19 so the app can be exercised by tests.
 * Before this, the app was constructed at module scope and `listen()` ran on
 * import, so importing it to test a route started a real server on a real port.
 * index.ts now owns startup and this file owns wiring; middleware order is
 * unchanged, which is the part that matters for auth and the error handler.
 */
/** Whether a built frontend was found. Set by createApp(); read by index.ts for its
 *  startup banner. Module-level because the banner is a startup concern, not an app one. */
export let servingUiFlag = false;

export function createApp() {

  const app = express();

  // Behind a tunnel or reverse proxy, trust the forwarded headers so redirects
  // and logging see the real client rather than the proxy.
  app.set("trust proxy", true);

  app.use(cors());
  app.use(express.json());

  // Everything below this line is gated when BASIC_AUTH_* are set.
  app.use(basicAuthGate());

  app.get("/api/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

  // Identify the caller before any router runs. Never rejects — each route
  // declares what it requires, so reads stay open to anyone signed in and the
  // login route stays reachable to nobody.
  app.use("/api", attachUser);
  app.use("/api", requireSession);

  app.use("/api/auth", authRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/products", productsRouter);
  app.use("/api/warehouses", warehousesRouter);
  app.use("/api/sales-orders", salesOrdersRouter);
  app.use("/api/purchase-orders", purchaseOrdersRouter);
  app.use("/api/stock-adjustments", stockAdjustmentsRouter);
  app.use("/api/stock-counts", stockCountsRouter);
  app.use("/api/stock-transfers", stockTransfersRouter);
  app.use("/api/reports", reportsRouter);
  // catalogsRouter and ledgerRouter each own several sibling paths, so like
  // inventoryRouter they mount at the API root.
  app.use("/api", metaRouter);
  app.use("/api", catalogsRouter);
  app.use("/api", ledgerRouter);
  // inventoryRouter owns two unrelated paths, so it mounts at the API root.
  app.use("/api", inventoryRouter);
  app.use("/api", receivingRouter);

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
  servingUiFlag = servingUi;

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


  return app;
}
