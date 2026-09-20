/**
 * Shared test helpers. Import "./setup" BEFORE this in every test file —
 * setup sets DATABASE_URL and src/db.ts builds PrismaClient at import time.
 */
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { prisma } from "../src/db";
import { syncChartOfAccounts } from "../src/accounts";
import { ensureBootstrapAdmin, SESSION_HEADER } from "../src/auth";
import { ensureDocumentCounters } from "../src/numbering";

let app: Express | null = null;
let token: string | null = null;

/** Boot the reconciliation the real server does at startup, then sign in. */
export async function boot() {
  if (app && token) return { app, token };
  await syncChartOfAccounts();
  await ensureDocumentCounters();
  const admin = await ensureBootstrapAdmin();
  app = createApp();

  const email = admin?.email ?? "admin@stockroom.local";
  const password = admin?.password ?? process.env.ADMIN_PASSWORD!;
  const res = await request(app).post("/api/auth/login").send({ email, password });
  if (res.status !== 200 || !res.body?.token) {
    throw new Error(`test login failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  token = res.body.token as string;
  return { app, token };
}

/** A supertest request with the session header already attached. */
export function as(app: Express, tok: string) {
  return {
    post: (url: string) => request(app).post(url).set(SESSION_HEADER, tok),
    get: (url: string) => request(app).get(url).set(SESSION_HEADER, tok),
  };
}

export { prisma };
