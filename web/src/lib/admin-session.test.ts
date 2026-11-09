import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_COOKIE,
  ADMIN_MAX_AGE_S,
  ADMIN_TTL_MS,
  adminCookieInit,
  allowAdminAttempt,
  checkAdminCode,
  ownerProofRequired,
  readCookieValue,
  resetAdminAttempts,
  signAdminSession,
  verifyAdminSession,
} from "./admin-session";

const SECRET = "owner-code-not-in-cookie";

test("admin session signs a 12h cookie without embedding the code", () => {
  const now = 1_700_000_000_000;
  const token = signAdminSession(now, SECRET);
  assert.ok(token);
  assert.equal(token.includes(SECRET), false);
  assert.equal(token.includes("owner-code"), false);
  assert.equal(verifyAdminSession(token, now, SECRET), true);
  assert.equal(verifyAdminSession(token, now + ADMIN_TTL_MS - 1, SECRET), true);
  assert.equal(verifyAdminSession(token, now + ADMIN_TTL_MS, SECRET), false);
  assert.equal(verifyAdminSession(token, now, "other-code"), false);
  assert.equal(verifyAdminSession(`${token}x`, now, SECRET), false);
  assert.equal(signAdminSession(now, "  "), null);
  assert.equal(verifyAdminSession(token, now, ""), false);
  const cookie = adminCookieInit(token);
  assert.equal(cookie.name, ADMIN_COOKIE);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, "lax");
  assert.equal(cookie.path, "/");
  assert.equal(cookie.maxAge, ADMIN_MAX_AGE_S);
  assert.equal(cookie.value.includes(SECRET), false);
  assert.equal(adminCookieInit(token, true).maxAge, 0);
  const header = `theme=dark; ${ADMIN_COOKIE}=${token}; other=1`;
  assert.equal(readCookieValue(header, ADMIN_COOKIE), token);
  assert.equal(readCookieValue(null, ADMIN_COOKIE), "");
});

test("admin code compare fails closed and the rate limit stops the sixth try", () => {
  assert.equal(checkAdminCode("right", ""), "missing");
  assert.equal(checkAdminCode("", SECRET), "bad");
  assert.equal(checkAdminCode("wrong", SECRET), "bad");
  assert.equal(checkAdminCode(`  ${SECRET}  `, SECRET), "ok");
  assert.equal(checkAdminCode("x".repeat(201), SECRET), "bad");
  resetAdminAttempts();
  const now = 5_000;
  for (let i = 0; i < 5; i += 1) assert.equal(allowAdminAttempt("203.0.113.8", now), true);
  assert.equal(allowAdminAttempt("203.0.113.8", now + 1_000), false);
  assert.equal(allowAdminAttempt("203.0.113.9", now + 1_000), true);
  assert.equal(allowAdminAttempt("203.0.113.8", now + 60_000), true);
  resetAdminAttempts();
});

test("admin mode skips the owner proof and dry-run stays open", () => {
  const owner = { action: "execute", admin: false, walletAttached: false, strictOwner: true, ownerId: "boss.testnet" };
  assert.equal(ownerProofRequired(owner), true);
  assert.equal(ownerProofRequired({ ...owner, admin: true, walletAttached: true }), false);
  assert.equal(ownerProofRequired({ ...owner, walletAttached: true, ownerId: "" }), true);
  assert.equal(ownerProofRequired({ ...owner, strictOwner: false, ownerId: "" }), false);
  assert.equal(ownerProofRequired({ ...owner, action: "dry_run" }), false);
  assert.equal(ownerProofRequired({ ...owner, action: "admin_unlock" }), false);
  assert.equal(ownerProofRequired({ ...owner, action: "update_policy" }), true);
  assert.equal(ownerProofRequired({ ...owner, action: "rotate_grant", admin: true }), false);
});
