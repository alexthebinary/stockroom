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

export type AuthedUser = { id: number; email: string; name: string; role: Role };

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
export async function attachUser(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("Authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return next();
  const claims = readToken(token);
  if (!claims) return next();
  const user = await prisma.user.findUnique({ where: { id: claims.sub } });
  // The ROW is the authority, not the token: deactivating someone must take
  // effect immediately rather than when their token happens to expire.
  if (!user || !user.isActive) return next();
  req.user = { id: user.id, email: user.email, name: user.name, role: user.role as Role };
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
