import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { translate } from "../components/aegis/copy";
import {
  FREE_DAY_LIMIT,
  FREE_HOUR_LIMIT,
  FREE_LIMIT_MESSAGE,
  MAX_REPLY_TOKENS,
  WALLET_HOUR_LIMIT,
  WALLET_LIMIT_MESSAGE,
  aiClientIp,
  aiWindowKeys,
  connectedWalletAccount,
  consumeAiCredit,
  memoryWindowStore,
  parseRedisCounts,
  redisBumpBody,
  redisRestConfig,
  redisWindowStore,
  type AiWindowStore,
} from "./ai-rate-limit";
import { VOICE_TOO_LONG_MESSAGE } from "./wav";

const NOW = Date.UTC(2026, 0, 2, 3, 0, 0);

test("free chat and voice share 20 per hour and 100 per day", async () => {
  const store = memoryWindowStore(() => NOW);
  for (let index = 0; index < FREE_HOUR_LIMIT; index += 1) {
    const decision = await consumeAiCredit({ ip: "203.0.113.10", wallet: false, admin: false, now: NOW, store });
    assert.equal(decision.ok, true);
  }
  const blocked = await consumeAiCredit({ ip: "203.0.113.10", wallet: false, admin: false, now: NOW, store });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.code, "free_limit");
    assert.equal(blocked.message, FREE_LIMIT_MESSAGE);
  }
  const other = await consumeAiCredit({ ip: "203.0.113.11", wallet: false, admin: false, now: NOW, store });
  assert.equal(other.ok, true);
});

test("a connected wallet continues on the same hourly counter up to 100", async () => {
  const store = memoryWindowStore(() => NOW);
  for (let index = 0; index < FREE_HOUR_LIMIT; index += 1) {
    assert.equal((await consumeAiCredit({ ip: "198.51.100.4", wallet: false, admin: false, now: NOW, store })).ok, true);
  }
  assert.equal((await consumeAiCredit({ ip: "198.51.100.4", wallet: false, admin: false, now: NOW, store })).ok, false);
  for (let index = FREE_HOUR_LIMIT + 1; index < WALLET_HOUR_LIMIT; index += 1) {
    const decision = await consumeAiCredit({ ip: "198.51.100.4", wallet: true, admin: false, now: NOW, store });
    assert.equal(decision.ok, true);
    if (decision.ok) assert.equal(decision.tier, "wallet");
  }
  const blocked = await consumeAiCredit({ ip: "198.51.100.4", wallet: true, admin: false, now: NOW, store });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.code, "wallet_limit");
    assert.equal(blocked.message, WALLET_LIMIT_MESSAGE);
  }
});

test("the free daily cap blocks a later hour, and a wallet does not use that cap", async () => {
  const clock = { now: Date.UTC(2026, 0, 3, 0, 0, 0) };
  const store = memoryWindowStore(() => clock.now);
  for (let hour = 0; hour < FREE_DAY_LIMIT / FREE_HOUR_LIMIT; hour += 1) {
    clock.now = Date.UTC(2026, 0, 3, hour, 0, 0);
    for (let index = 0; index < FREE_HOUR_LIMIT; index += 1) {
      assert.equal((await consumeAiCredit({ ip: "203.0.113.20", wallet: false, admin: false, now: clock.now, store })).ok, true);
    }
  }
  clock.now = Date.UTC(2026, 0, 3, 6, 0, 0);
  const blocked = await consumeAiCredit({ ip: "203.0.113.20", wallet: false, admin: false, now: clock.now, store });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.code, "free_limit");
  const wallet = await consumeAiCredit({ ip: "203.0.113.20", wallet: true, admin: false, now: clock.now, store });
  assert.equal(wallet.ok, true);
  clock.now = Date.UTC(2026, 0, 4, 0, 0, 0);
  const nextDay = await consumeAiCredit({ ip: "203.0.113.20", wallet: false, admin: false, now: clock.now, store });
  assert.equal(nextDay.ok, true);
});

test("admin mode does not consume a credit", async () => {
  let bumps = 0;
  const store: AiWindowStore = {
    async bump() {
      bumps += 1;
      return { hour: bumps, day: bumps };
    },
  };
  for (let index = 0; index < 30; index += 1) {
    const decision = await consumeAiCredit({ ip: "203.0.113.30", wallet: false, admin: true, now: NOW, store });
    assert.deepEqual(decision, { ok: true, tier: "admin" });
  }
  assert.equal(bumps, 0);
  const free = await consumeAiCredit({ ip: "203.0.113.30", wallet: false, admin: false, now: NOW, store });
  assert.equal(free.ok, true);
  assert.equal(bumps, 1);
});

test("redis errors fall back to the in-memory counter", async () => {
  const fallback = memoryWindowStore(() => NOW);
  const down: AiWindowStore = {
    async bump() {
      throw new Error("redis down");
    },
  };
  for (let index = 0; index < FREE_HOUR_LIMIT; index += 1) {
    assert.equal((await consumeAiCredit({ ip: "203.0.113.40", wallet: false, admin: false, now: NOW, store: down, fallback })).ok, true);
  }
  const blocked = await consumeAiCredit({ ip: "203.0.113.40", wallet: false, admin: false, now: NOW, store: down, fallback });
  assert.equal(blocked.ok, false);
});

test("rate-limit keys hash the IP and redis uses INCR with EXPIRE NX", async () => {
  const seen: string[] = [];
  const store: AiWindowStore = {
    async bump(hourKey, hourTtl, dayKey, dayTtl) {
      seen.push(hourKey, dayKey, String(hourTtl), String(dayTtl));
      return { hour: 1, day: 1 };
    },
  };
  await consumeAiCredit({ ip: "203.0.113.9", wallet: false, admin: false, now: NOW, store });
  assert.equal(seen.some((item) => item.includes("203.0.113.9")), false);
  assert.match(seen[0] || "", /^kotha:ai:[0-9a-f]{24}:h:\d+$/);
  assert.match(seen[1] || "", /^kotha:ai:[0-9a-f]{24}:d:\d+$/);
  assert.equal(seen[2], "7200");
  assert.equal(seen[3], "172800");
  const keys = aiWindowKeys("203.0.113.9", NOW);
  assert.equal(seen[0], keys.hourKey);
  assert.equal(aiClientIp(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })), "203.0.113.9");
  assert.equal(aiClientIp(new Headers({ "x-real-ip": "198.51.100.8" })), "198.51.100.8");
  assert.equal(aiClientIp(new Headers()), "local");
  assert.equal(connectedWalletAccount("Bob.Testnet"), "bob.testnet");
  assert.equal(connectedWalletAccount("not-an-account"), null);
  assert.equal(connectedWalletAccount("a.near"), null);
  assert.equal(redisRestConfig({}), null);
  assert.deepEqual(
    redisRestConfig({
      KV_REST_API_URL: "https://kv.example/",
      KV_REST_API_TOKEN: "kv-token",
      UPSTASH_REDIS_REST_URL: "https://upstash.example",
      UPSTASH_REDIS_REST_TOKEN: "up-token",
    }),
    { url: "https://kv.example", token: "kv-token" },
  );
  assert.deepEqual(redisRestConfig({ UPSTASH_REDIS_REST_URL: "https://upstash.example/", UPSTASH_REDIS_REST_TOKEN: "up-token" }), {
    url: "https://upstash.example",
    token: "up-token",
  });
  const body = redisBumpBody("hour", 7200, "day", 172800);
  assert.deepEqual(body[0], ["INCR", "hour"]);
  assert.deepEqual(body[1], ["EXPIRE", "hour", 7200, "NX"]);
  assert.deepEqual(parseRedisCounts([{ result: 4 }, { result: 1 }, { result: "9" }, { result: 1 }]), { hour: 4, day: 9 });
  assert.equal(parseRedisCounts([{ result: null }]), null);
});

test("the redis store posts a pipeline and reads the counters", async () => {
  let posted = "";
  let auth = "";
  const store = redisWindowStore({ url: "https://kv.example", token: "secret-token" }, (async (url: string | URL | Request, init?: RequestInit) => {
    posted = String(url);
    auth = new Headers(init?.headers).get("authorization") || "";
    assert.equal(init?.method, "POST");
    return new Response(JSON.stringify([{ result: 2 }, { result: 1 }, { result: 2 }, { result: 1 }]), { status: 200 });
  }) as typeof fetch);
  const counts = await store.bump("kotha:ai:abc:h:1", 7200, "kotha:ai:abc:d:1", 172800);
  assert.deepEqual(counts, { hour: 2, day: 2 });
  assert.equal(posted, "https://kv.example/pipeline");
  assert.equal(auth, "Bearer secret-token");
  assert.equal(posted.includes("secret-token"), false);
});

test("reply tokens are capped and the limit copy is bilingual", () => {
  assert.equal(MAX_REPLY_TOKENS, 800);
  const tee = readFileSync(new URL("./near-ai-tee.ts", import.meta.url), "utf8");
  assert.match(tee, /max_tokens:\s*MAX_REPLY_TOKENS/);
  assert.equal(translate("en", "freeLimit"), FREE_LIMIT_MESSAGE);
  assert.equal(translate("en", "freeLimit"), "Free limit reached. Connect your wallet to continue.");
  assert.match(translate("bn", "freeLimit"), /[\u0980-\u09FF]/);
  assert.notEqual(translate("bn", "freeLimit"), translate("en", "freeLimit"));
  assert.equal(translate("en", "walletLimit"), WALLET_LIMIT_MESSAGE);
  assert.match(translate("bn", "walletLimit"), /[\u0980-\u09FF]/);
  assert.equal(translate("en", "voiceTooLong"), VOICE_TOO_LONG_MESSAGE);
  assert.match(translate("bn", "voiceTooLong"), /[\u0980-\u09FF]/);
});
