import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { DomainError } from "@pi/domain";
import { createDb, type Db } from "./db";
import { syncChart } from "./ledger";

/**
 * Test companies. The install's own company lives in the default schema
 * ("main"). Each test company is a whole, separate copy of the books in its own
 * Postgres schema (co_1, co_2, ...), so a tester can start from an empty
 * company and run setup from the first screen without touching the real data.
 * The browser picks one with the x-company header; no header means main.
 * Feedback always stays in main, so every note reaches the same queue.
 */

export const MAIN = "main";
const SCHEMA = /^co_[1-9][0-9]{0,5}$/;
const API_DIR = resolve(import.meta.dirname, "..");

type Current = { id: string; db: Db };
const current = new AsyncLocalStorage<Current>();

/** The company this request works in; main outside a request. */
export function currentCompanyId(): string {
  return current.getStore()?.id ?? MAIN;
}

/** A Db that is, on every call, the client of the request's company. */
export function scopedDb(main: Db): Db {
  return new Proxy(main, {
    get(_target, prop) {
      const client = current.getStore()?.db ?? main;
      const value = Reflect.get(client, prop, client);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });
}

export type CompanyInfo = { id: string; name: string; createdAt: Date; setupDone: boolean; test: boolean };

function migrate(url: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn("npx", ["--no-install", "prisma", "migrate", "deploy"], {
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`prisma migrate deploy failed (${code}): ${output.slice(-2000)}`))));
  });
}

function withSchema(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("schema", schema);
  return parsed.toString();
}

export class Companies {
  private clients = new Map<string, Db>();

  constructor(
    readonly main: Db,
    private readonly url: string,
  ) {}

  /** Connect to every test company and bring its schema up to date (on boot). */
  async load() {
    for (const schema of await this.schemas()) {
      await migrate(withSchema(this.url, schema));
      const db = createDb(this.url, schema);
      await syncChart(db);
      this.clients.set(schema, db);
    }
  }

  /** onRequest hook: run the rest of the request inside its company. */
  hook = (request: { headers: Record<string, unknown>; url: string }, _reply: unknown, done: (error?: Error) => void) => {
    const raw = request.headers["x-company"];
    const id = typeof raw === "string" && raw ? raw : MAIN;
    const db = id === MAIN ? undefined : this.clients.get(id);
    // The company list always answers (from main), so a device holding a deleted company can see that and switch back.
    if (!db && (id === MAIN || request.url.startsWith("/api/companies"))) return current.run({ id: MAIN, db: this.main }, done);
    if (!db) return done(new DomainError("That test company no longer exists. Pick a company again.", 404));
    return current.run({ id, db }, done);
  };

  private async schemas(): Promise<string[]> {
    const rows = await this.main.$queryRaw<{ schema_name: string }[]>`SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'co\\_%'`;
    return rows.map((r) => r.schema_name).filter((s) => SCHEMA.test(s)).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
  }

  async list(): Promise<CompanyInfo[]> {
    const info = async (id: string, db: Db): Promise<CompanyInfo> => {
      const row = await db.company.findUnique({ where: { id: 1 } });
      return { id, name: row?.name || (id === MAIN ? "Main company" : "New company"), createdAt: row?.createdAt ?? new Date(0), setupDone: row?.setupCompletedAt != null, test: id !== MAIN };
    };
    return Promise.all([info(MAIN, this.main), ...[...this.clients].map(([id, db]) => info(id, db))]);
  }

  /** A brand-new, empty company: chart of accounts only; the setup wizard opens on first visit. */
  async create(name: string): Promise<CompanyInfo> {
    const taken = await this.schemas();
    const id = `co_${Math.max(0, ...taken.map((s) => Number(s.slice(3)))) + 1}`;
    await this.main.$executeRawUnsafe(`CREATE SCHEMA "${id}"`);
    try {
      await migrate(withSchema(this.url, id));
      const db = createDb(this.url, id);
      await syncChart(db);
      const row = await db.company.upsert({ where: { id: 1 }, create: { id: 1, name }, update: { name } });
      this.clients.set(id, db);
      return { id, name: row.name, createdAt: row.createdAt, setupDone: false, test: true };
    } catch (error) {
      await this.main.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${id}" CASCADE`);
      throw error;
    }
  }

  /** Throw a test company away. The main company can never be removed. */
  async remove(id: string) {
    if (!SCHEMA.test(id)) throw new DomainError("Only test companies can be deleted", 400);
    const db = this.clients.get(id);
    if (!db) throw new DomainError("That company was not found", 404);
    this.clients.delete(id);
    await db.$disconnect();
    await this.main.$executeRawUnsafe(`DROP SCHEMA "${id}" CASCADE`);
  }
}
