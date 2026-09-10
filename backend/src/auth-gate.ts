import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * HTTP Basic auth across the whole app.
 *
 * The demo login is a UI formality — it gates no API route. The moment this
 * app is reachable from outside the machine, something has to actually stop a
 * stranger from reading and writing the database, and Basic auth over HTTPS is
 * the smallest honest answer.
 *
 * Enabled by setting BASIC_AUTH_USER and BASIC_AUTH_PASSWORD. When they are
 * absent the gate is a no-op, so local development is unchanged.
 */
export function basicAuthGate() {
  const user = process.env.BASIC_AUTH_USER;
  const password = process.env.BASIC_AUTH_PASSWORD;

  if (!user || !password) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  const expected = Buffer.from(`${user}:${password}`);

  return (req: Request, res: Response, next: NextFunction) => {
    // The health check stays open so a tunnel or uptime probe can see the
    // process is alive without holding a credential.
    if (req.path === "/api/health") return next();

    const header = req.header("Authorization") ?? "";
    const [scheme, encoded] = header.split(" ");

    if (scheme === "Basic" && encoded) {
      const supplied = Buffer.from(encoded, "base64");
      // Length must match before timingSafeEqual, and comparing lengths first
      // leaks only the length, which the header already reveals.
      if (
        supplied.length === expected.length &&
        timingSafeEqual(supplied, expected)
      ) {
        return next();
      }
    }

    res.setHeader("WWW-Authenticate", 'Basic realm="Stockroom", charset="UTF-8"');
    res.status(401).json({ error: "Authentication required" });
  };
}
