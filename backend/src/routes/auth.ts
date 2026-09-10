import { Router } from "express";
import { z } from "zod";
import { ApiError } from "../errors";
import { asyncHandler, parseBody } from "../http";

export const authRouter = Router();

/**
 * Demo-only credentials. There is no session, no token verification and no
 * password reset — the frontend simply remembers that a login succeeded.
 * Replace this whole module before the app sees a real user.
 */
const DEMO_EMAIL = process.env.DEMO_EMAIL ?? "demo@user.com";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "password";

const loginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = parseBody(loginSchema, req.body);
    if (email.trim().toLowerCase() !== DEMO_EMAIL || password !== DEMO_PASSWORD) {
      throw new ApiError(401, "Invalid demo credentials");
    }
    res.json({ user: { email: DEMO_EMAIL, name: "Demo User", role: "admin" } });
  })
);
