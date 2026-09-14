import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { ApiError } from "./errors";
import { prisma } from "./db";

/**
 * Authentication and roles.
 *
 * Deliberately built from node:crypto rather than bcrypt and a JWT library:
 * scrypt and HMAC are in the standard library, and two fewer dependencies on a
 * security path is worth more than the convenience. There is no password reset,
 * no MFA, no refresh tokens and no session table — those are real features with
 * real surface, and this is the smallest thing that is honestly an
 * authorisation model rather than a decoration.
 *
 * NOTE this sits INSIDE the HTTP Basic gate on a hosted instance. Basic auth
 * says who may reach the app at all; this says what they may do once inside.
 */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export const ROLES = ["VIEWER", "WAREHOUSE", "FINANCE", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Who may do what.
 *
 * Read is open to anyone signed in. Writes split on the question a warehouse
 * actually asks: did you move stock, or did you move money? ADMIN is both plus
 * user management — not a third kind of work, just the union.
 */
export const CAN: Record<Role, { stock: boolean; money: boolean; users: boolean }> = {
  VIEWER:    { stock: false, money: false, users: false },
  WAREHOUSE: { stock: true,  money: false, users: false },
  FINANCE:   { stock: false, money: true,  users: false },
  ADMIN:     { stock: true,  money: true,  users: true  },
};

export function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string) {
  const [scheme, N, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  // Constant time: a length check first leaks only the length, which the stored
  // format already fixes.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * The signing secret.
 *
 * Falls back to a value generated at boot when AUTH_SECRET is unset, which
 * means tokens do not survive a restart in development — the correct failure.
 * A hardcoded default would be a published secret.
 */
const SECRET = process.env.AUTH_SECRET || randomBytes(32).toString("hex");
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

export function issueToken(user: { id: number; role: string }) {
  const body = Buffer.from(
    JSON.stringify({ sub: user.id, role: user.role, exp: Date.now() + TOKEN_TTL_MS })
  ).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readToken(token: string): { sub: number; role: Role; exp: number } | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", SECRET).update(body).digest("base64url");
  // Compare the signature before parsing the body: an unverified body is
  // attacker-controlled JSON and should never reach JSON.parse decisions.
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    if (typeof claims.exp !== "number" || claims.exp < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

export type AuthedUser = {
  id: number;
  email: string;
  name: string;
  /** The EFFECTIVE role — what this request may do. */
  role: Role;
  /** The role the account actually holds. Differs only while acting as another. */
  actualRole: Role;
  /** Set when an administrator is deliberately working as a lesser role. */
  actingAs?: Role;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

/**
 * Attach the signed-in user when a valid token is present. Never rejects —
 * routes decide what they require, so a public route stays public.
 */
export const SESSION_HEADER = "X-Stockroom-Session";

export async function attachUser(req: Request, _res: Response, next: NextFunction) {
  /**
   * The session token has its OWN header, not Authorization.
   *
   * A hosted instance sits behind HTTP Basic, and `Authorization` holds exactly
   * one credential — sending `Bearer <session>` REPLACES the Basic credential,
   * so the request is rejected by the outer gate and never reaches this code.
   * That broke the deployed app, not just a test: the browser satisfies Basic
   * once and then fetch() overwrote it on every API call.
   *
   * Authorization: Bearer is still accepted as a fallback, for API clients on
   * an instance with no Basic gate in front.
   */
  const auth = req.header("Authorization") ?? "";
  const [scheme, bearer] = auth.split(" ");
  const token = req.header(SESSION_HEADER)?.trim() || (scheme === "Bearer" ? bearer : "");
  if (!token) return next();
  const claims = readToken(token);
  if (!claims) return next();
  const user = await prisma.user.findUnique({ where: { id: claims.sub } });
  // The ROW is the authority, not the token: deactivating someone must take
  // effect immediately rather than when their token happens to expire.
  if (!user || !user.isActive) return next();
  const actualRole = user.role as Role;
  req.user = { id: user.id, email: user.email, name: user.name, role: actualRole, actualRole };

  /**
   * Acting as another role.
   *
   * An administrator cannot see what a warehouse user sees without becoming
   * one, and "log in as somebody else" is how shared credentials start. This
   * lets them drop into a lesser role on their own account.
   *
   * Three properties hold it safe:
   *  - only an ADMIN may do it, so a lesser role sending the header is ignored;
   *  - the assumed role must grant a SUBSET of what the real role grants, so
   *    this can only ever take capability away. Checked, not assumed, because
   *    the role table will be edited by someone who has not read this;
   *  - the audit trail keeps the REAL account. Impersonation that rewrites who
   *    did something is a way to launder actions, not a convenience.
   */
  const requested = req.header("X-Act-As-Role")?.trim().toUpperCase();
  if (requested && requested !== actualRole && (ROLES as readonly string[]).includes(requested)) {
    const assumed = requested as Role;
    const real = CAN[actualRole];
    const wanted = CAN[assumed];
    const isSubset = (Object.keys(wanted) as (keyof typeof wanted)[]).every(
      (k) => !wanted[k] || real[k]
    );
    if (CAN[actualRole].users && isSubset) {
      req.user.role = assumed;
      req.user.actingAs = assumed;
    }
  }

  next();
}

/**
 * Everything under /api needs a session, except the two things that cannot.
 *
 * Without this, reads were open to anyone who could reach the port and the
 * VIEWER role meant nothing — you got viewer access by not having an account.
 * On a hosted instance HTTP Basic sits in front, but "another layer happens to
 * cover it" is not the same as the app having an authorisation model.
 */
const OPEN_PATHS = new Set(["/health", "/auth/login"]);

export function requireSession(req: Request, _res: Response, next: NextFunction) {
  if (OPEN_PATHS.has(req.path)) return next();
  if (!req.user) return next(new ApiError(401, "Sign in to use Stockroom"));
  next();
}

/** Require a signed-in user with one of the listed capabilities. */
export function require$(capability: "stock" | "money" | "users") {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ApiError(401, "Sign in to do that"));
    }
    if (!CAN[req.user.role]?.[capability]) {
      const needed = { stock: "warehouse", money: "finance", users: "administrator" }[capability];
      return next(
        new ApiError(403, `Your role (${req.user.role.toLowerCase()}) cannot do that — it needs ${needed} access`)
      );
    }
    next();
  };
}

export const requireStock = require$("stock");
export const requireMoney = require$("money");
export const requireUsers = require$("users");


/**
 * Create the first administrator when there are none.
 *
 * The seed writes users, and the seed only runs on an EMPTY database — so
 * deploying roles to a database that already had data locked everyone out:
 * every route needs a session and no account existed to start one. Exactly the
 * trap the chart of accounts hit, and the same answer.
 *
 * Fires ONLY when the user table is empty, so it cannot resurrect an
 * administrator somebody deliberately removed. Uses ADMIN_EMAIL and
 * ADMIN_PASSWORD when set; otherwise mints a random password and prints it
 * once, because a hardcoded default would be a published credential.
 */
export async function ensureBootstrapAdmin() {
  const { prisma } = await import("./db");
  if ((await prisma.user.count()) > 0) return null;

  const email = (process.env.ADMIN_EMAIL ?? "admin@user.com").trim().toLowerCase();
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD ?? randomBytes(9).toString("base64url");

  await prisma.user.create({
    data: {
      email,
      name: process.env.ADMIN_NAME ?? "Administrator",
      role: "ADMIN",
      passwordHash: hashPassword(password),
    },
  });

  return { email, password: generated ? password : null };
}
