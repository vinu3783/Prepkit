import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { ObjectId, type Collection, type Db } from "mongodb";
import { ApiError } from "../api/errors.js";

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const SESSION_COOKIE = "pk_session";
const SESSION_TTL_MS = 7 * 86_400_000;

interface UserDoc {
  _id: ObjectId;
  email: string;
  passwordHash: string;
  createdAt: string;
}

interface SessionDoc {
  tokenHash: string;
  userId: ObjectId;
  expiresAt: Date;
  createdAt: Date;
}

export interface AuthedRequest extends Request {
  user: { id: string; email: string };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Session tokens are random; only their SHA-256 is stored, so a DB leak does not leak sessions. */
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export class AuthService {
  private readonly users: Collection<UserDoc>;
  private readonly sessions: Collection<SessionDoc>;

  constructor(db: Db) {
    this.users = db.collection<UserDoc>("users");
    this.sessions = db.collection<SessionDoc>("sessions");
  }

  async register(email: string, password: string) {
    const normalized = email.trim().toLowerCase();
    const doc: UserDoc = { _id: new ObjectId(), email: normalized, passwordHash: await hashPassword(password), createdAt: new Date().toISOString() };
    try {
      await this.users.insertOne(doc);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ApiError(409, "EMAIL_TAKEN", "An account with this email already exists.");
      throw err;
    }
    return { id: doc._id.toHexString(), email: doc.email };
  }

  async login(email: string, password: string) {
    const user = await this.users.findOne({ email: email.trim().toLowerCase() });
    // Same error either way: do not reveal which emails have accounts.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    }
    return { id: user._id.toHexString(), email: user.email };
  }

  async createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.sessions.insertOne({ tokenHash: hashToken(token), userId: new ObjectId(userId), expiresAt, createdAt: new Date() });
    return { token, expiresAt };
  }

  async destroySession(token: string): Promise<void> {
    await this.sessions.deleteOne({ tokenHash: hashToken(token) });
  }

  async resolveSession(token: string): Promise<{ id: string; email: string } | "expired" | null> {
    const session = await this.sessions.findOne({ tokenHash: hashToken(token) });
    if (!session) return null;
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.sessions.deleteOne({ tokenHash: session.tokenHash });
      return "expired";
    }
    const user = await this.users.findOne({ _id: session.userId }, { projection: { email: 1 } });
    return user ? { id: user._id.toHexString(), email: user.email } : null;
  }
}

export function sessionCookieOptions(expiresAt?: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

/** Protect a route: 401 UNAUTHENTICATED with no cookie, 401 SESSION_EXPIRED for a stale one. */
export function requireAuth(auth: AuthService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (!token) return next(new ApiError(401, "UNAUTHENTICATED", "Please sign in."));
    const user = await auth.resolveSession(token);
    if (user === "expired" || user === null) {
      res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
      return next(
        user === "expired"
          ? new ApiError(401, "SESSION_EXPIRED", "Your session has expired. Please sign in again.")
          : new ApiError(401, "UNAUTHENTICATED", "Please sign in."),
      );
    }
    (req as AuthedRequest).user = user;
    next();
  };
}
