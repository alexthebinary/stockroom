import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { ApiError, badRequest, conflict, notFound } from "../errors";
import { asyncHandler, parseBody } from "../http";
import { CAN, ROLES, hashPassword, issueToken, requireUsers, verifyPassword } from "../auth";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = parseBody(loginSchema, req.body);
    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });

    // One message and one shape for every failure — a missing account, a wrong
    // password and a deactivated account must be indistinguishable, or the
    // login form becomes a way to enumerate who works here.
    const ok = user && user.isActive && verifyPassword(password, user.passwordHash);
    if (!ok) throw new ApiError(401, "That email and password do not match an active account");

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    res.json({
      token: issueToken(user),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        can: CAN[user.role as keyof typeof CAN] ?? CAN.VIEWER,
      },
    });
  })
);

/** Who am I — used by the UI to restore a session without re-entering a password. */
authRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    if (!req.user) throw new ApiError(401, "Not signed in");
    res.json({ user: { ...req.user, can: CAN[req.user.role] } });
  })
);

const userSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1),
  password: z.string().min(8, "A password needs at least 8 characters"),
  role: z.enum(ROLES),
});

authRouter.get(
  "/users",
  requireUsers,
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      orderBy: { email: "asc" },
      select: { id: true, email: true, name: true, role: true, isActive: true, lastLoginAt: true },
    });
    res.json({ data: users });
  })
);

authRouter.post(
  "/users",
  requireUsers,
  asyncHandler(async (req, res) => {
    const body = parseBody(userSchema, req.body);
    const email = body.email.trim().toLowerCase();
    if (await prisma.user.findUnique({ where: { email } })) {
      throw conflict("Someone already has that email address");
    }
    const user = await prisma.user.create({
      data: { email, name: body.name, role: body.role, passwordHash: hashPassword(body.password) },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });
    res.status(201).json(user);
  })
);

const patchSchema = z.object({
  role: z.enum(ROLES).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

authRouter.patch(
  "/users/:id",
  requireUsers,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw badRequest("id must be an integer");
    const body = parseBody(patchSchema, req.body);

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) throw notFound("User not found");

    // Locking yourself out is the one mistake this endpoint can make
    // irreversible, since only an administrator can undo it.
    if (req.user!.id === id && (body.isActive === false || (body.role && body.role !== "ADMIN"))) {
      throw conflict("You cannot remove your own administrator access — ask another administrator");
    }
    if (target.role === "ADMIN" && (body.isActive === false || (body.role && body.role !== "ADMIN"))) {
      const admins = await prisma.user.count({ where: { role: "ADMIN", isActive: true } });
      if (admins <= 1) throw conflict("That is the last active administrator");
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(body.role ? { role: body.role } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.password ? { passwordHash: hashPassword(body.password) } : {}),
      },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });
    res.json(user);
  })
);
