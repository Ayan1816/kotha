import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { OWNER_ACTIONS } from "./wallet-proof";

export const ADMIN_COOKIE = "kotha_admin";
export const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;
export const ADMIN_MAX_AGE_S = 12 * 60 * 60;
const ATTEMPT_LIMIT = 5;
const ATTEMPT_WINDOW_MS = 60_000;
const MAX_CODE_LENGTH = 200;

type Attempt = { count: number; resetAt: number };
const attempts = new Map<string, Attempt>();

export function resetAdminAttempts(): void {
  attempts.clear();
}

/** Five unlock tries per key per minute. A limited caller is rejected before the code is compared. */
export function allowAdminAttempt(key: string, now = Date.now()): boolean {
  const id = key.trim().slice(0, 80) || "unknown";
  const current = attempts.get(id);
  if (!current || now >= current.resetAt) {
    attempts.set(id, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return true;
  }
  if (current.count >= ATTEMPT_LIMIT) return false;
  current.count += 1;
  return true;
}

export function checkAdminCode(given: string, expected: string): "ok" | "missing" | "bad" {
  const secret = expected.trim();
  if (!secret) return "missing";
  const code = given.trim();
  if (!code || code.length > MAX_CODE_LENGTH) return "bad";
  return hashesEqual(code, secret) ? "ok" : "bad";
}

function hashesEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** HMAC over the expiry only. The admin code is the key and is not written into the cookie. */
export function signAdminSession(now: number, secret: string): string | null {
  const key = secret.trim();
  if (!key) return null;
  const exp = now + ADMIN_TTL_MS;
  const payload = `v1.${exp}`;
  const sig = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyAdminSession(token: string, now: number, secret: string): boolean {
  const key = secret.trim();
  if (!token || !key) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const exp = Number(parts[1]);
  if (!Number.isInteger(exp) || exp <= now) return false;
  const expected = createHmac("sha256", key).update(`v1.${parts[1]}`).digest("base64url");
  return fixedEqual(parts[2] || "", expected);
}

function fixedEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function readCookieValue(header: string | null | undefined, name: string): string {
  if (!header) return "";
  for (const piece of header.split(";")) {
    const trimmed = piece.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return "";
}

export function adminSessionValid(cookieHeader: string | null | undefined, now = Date.now(), secret = process.env.KOTHA_ADMIN_CODE?.trim() || ""): boolean {
  return verifyAdminSession(readCookieValue(cookieHeader, ADMIN_COOKIE), now, secret);
}

export function adminCookieInit(value: string, clear = false): {
  name: string;
  value: string;
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
} {
  return {
    name: ADMIN_COOKIE,
    value: clear ? "" : value,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: clear ? 0 : ADMIN_MAX_AGE_S,
  };
}

/** Owner actions need a wallet proof unless Admin mode is unlocked. Dry-run never does. */
export function ownerProofRequired(input: {
  action: string;
  admin: boolean;
  walletAttached: boolean;
  strictOwner: boolean;
  ownerId: string;
}): boolean {
  if (!(OWNER_ACTIONS as readonly string[]).includes(input.action)) return false;
  if (input.admin) return false;
  if (input.walletAttached) return true;
  return input.strictOwner && input.ownerId.trim().length > 0;
}
