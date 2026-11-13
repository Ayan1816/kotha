import { createHash } from "node:crypto";
import { adminSessionValid } from "./admin-session";

/** Anonymous callers share one bucket across chat and voice. */
export const FREE_HOUR_LIMIT = 30;
export const FREE_DAY_LIMIT = 120;
/** A connected wallet raises the hourly ceiling. The daily cap stays on the free tier. */
export const WALLET_HOUR_LIMIT = 100;
export const MAX_REPLY_TOKENS = 800;
/** General questions do not need a long JSON action card. */
export const GENERAL_QA_MAX_TOKENS = 400;

export const FREE_LIMIT_MESSAGE = "Free limit reached. Connect your wallet to continue.";
export const WALLET_LIMIT_MESSAGE = "Hourly limit reached. Try again in an hour.";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HOUR_TTL_S = 2 * 60 * 60;
const DAY_TTL_S = 2 * 24 * 60 * 60;
const ACCOUNT_RE = /^[a-z0-9._-]{2,64}\.(?:near|testnet)$/i;

export type AiWindowStore = {
  bump(hourKey: string, hourTtl: number, dayKey: string, dayTtl: number): Promise<{ hour: number; day: number }>;
};

export type AiLimitDecision =
  | { ok: true; tier: "admin" | "wallet" | "free" }
  | { ok: false; tier: "wallet" | "free"; code: "wallet_limit" | "free_limit"; message: string };

type Bucket = { count: number; expiresAt: number };

const memoryFallback = memoryWindowStore();

export function memoryWindowStore(now: () => number = Date.now): AiWindowStore {
  const buckets = new Map<string, Bucket>();
  return {
    async bump(hourKey, hourTtl, dayKey, dayTtl) {
      const ts = now();
      return {
        hour: bumpMemory(buckets, hourKey, hourTtl, ts),
        day: bumpMemory(buckets, dayKey, dayTtl, ts),
      };
    },
  };
}

function bumpMemory(buckets: Map<string, Bucket>, key: string, ttlSeconds: number, now: number): number {
  if (buckets.size > 2000) {
    for (const [stored, value] of buckets) {
      if (value.expiresAt <= now) buckets.delete(stored);
    }
  }
  const current = buckets.get(key);
  if (!current || current.expiresAt <= now) {
    buckets.set(key, { count: 1, expiresAt: now + ttlSeconds * 1000 });
    return 1;
  }
  current.count += 1;
  return current.count;
}

/** Vercel KV wins when both KV and Upstash are set. Empty values mean in-memory. */
export function redisRestConfig(env: Record<string, string | undefined>): { url: string; token: string } | null {
  const kvUrl = env.KV_REST_API_URL?.trim() || "";
  const kvToken = env.KV_REST_API_TOKEN?.trim() || "";
  if (kvUrl && kvToken) return { url: kvUrl.replace(/\/+$/, ""), token: kvToken };
  const upUrl = env.UPSTASH_REDIS_REST_URL?.trim() || "";
  const upToken = env.UPSTASH_REDIS_REST_TOKEN?.trim() || "";
  if (upUrl && upToken) return { url: upUrl.replace(/\/+$/, ""), token: upToken };
  return null;
}

export function redisBumpBody(hourKey: string, hourTtl: number, dayKey: string, dayTtl: number): unknown[] {
  return [
    ["INCR", hourKey],
    ["EXPIRE", hourKey, hourTtl, "NX"],
    ["INCR", dayKey],
    ["EXPIRE", dayKey, dayTtl, "NX"],
  ];
}

export function parseRedisCounts(body: unknown): { hour: number; day: number } | null {
  if (!Array.isArray(body) || body.length < 3) return null;
  const hour = readRedisResult(body[0]);
  const day = readRedisResult(body[2]);
  if (hour == null || day == null) return null;
  return { hour, day };
}

function readRedisResult(entry: unknown): number | null {
  if (!entry || typeof entry !== "object") return null;
  const result = (entry as { result?: unknown }).result;
  if (typeof result === "number" && Number.isFinite(result)) return result;
  if (typeof result === "string" && /^\d+$/.test(result)) return Number(result);
  return null;
}

export function redisWindowStore(config: { url: string; token: string }, fetchImpl: typeof fetch = fetch): AiWindowStore {
  return {
    async bump(hourKey, hourTtl, dayKey, dayTtl) {
      const response = await fetchImpl(`${config.url}/pipeline`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(redisBumpBody(hourKey, hourTtl, dayKey, dayTtl)),
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) throw new Error(`redis ${response.status}`);
      const parsed = parseRedisCounts(await response.json());
      if (!parsed) throw new Error("redis shape");
      return parsed;
    },
  };
}

export function aiClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
  const real = headers.get("x-real-ip")?.trim() || "";
  return (forwarded || real || "local").slice(0, 80);
}

/** A plausible account id selects the wallet tier. It does not grant admin. */
export function connectedWalletAccount(value: string | null | undefined): string | null {
  const account = (value || "").trim();
  if (!ACCOUNT_RE.test(account)) return null;
  return account.toLowerCase();
}

export function aiWindowKeys(ip: string, now: number): { hourKey: string; dayKey: string } {
  const hash = createHash("sha256").update((ip || "local").slice(0, 80)).digest("hex").slice(0, 24);
  return {
    hourKey: `kotha:ai:${hash}:h:${Math.floor(now / HOUR_MS)}`,
    dayKey: `kotha:ai:${hash}:d:${Math.floor(now / DAY_MS)}`,
  };
}

function defaultStore(): AiWindowStore {
  const config = redisRestConfig(process.env);
  return config ? redisWindowStore(config) : memoryFallback;
}

export async function consumeAiCredit(input: {
  ip: string;
  wallet: boolean;
  admin: boolean;
  now?: number;
  store?: AiWindowStore;
  fallback?: AiWindowStore;
}): Promise<AiLimitDecision> {
  if (input.admin) return { ok: true, tier: "admin" };
  const now = input.now ?? Date.now();
  const keys = aiWindowKeys(input.ip, now);
  const primary = input.store ?? defaultStore();
  const fallback = input.fallback ?? memoryFallback;
  let counts: { hour: number; day: number };
  try {
    counts = await primary.bump(keys.hourKey, HOUR_TTL_S, keys.dayKey, DAY_TTL_S);
  } catch {
    if (fallback === primary) return deny(input.wallet);
    counts = await fallback.bump(keys.hourKey, HOUR_TTL_S, keys.dayKey, DAY_TTL_S);
  }
  return judge(input.wallet, counts.hour, counts.day);
}

function judge(wallet: boolean, hour: number, day: number): AiLimitDecision {
  if (wallet) {
    if (hour > WALLET_HOUR_LIMIT) return deny(true);
    return { ok: true, tier: "wallet" };
  }
  if (hour > FREE_HOUR_LIMIT || day > FREE_DAY_LIMIT) return deny(false);
  return { ok: true, tier: "free" };
}

function deny(wallet: boolean): AiLimitDecision {
  if (wallet) return { ok: false, tier: "wallet", code: "wallet_limit", message: WALLET_LIMIT_MESSAGE };
  return { ok: false, tier: "free", code: "free_limit", message: FREE_LIMIT_MESSAGE };
}

/** POST /api/tee-chat and POST /api/voice-transcribe share this check. GET does not. */
export async function limitAiRequest(request: Request): Promise<AiLimitDecision> {
  return consumeAiCredit({
    ip: aiClientIp(request.headers),
    wallet: connectedWalletAccount(request.headers.get("x-kotha-account")) != null,
    admin: adminSessionValid(request.headers.get("cookie")),
  });
}
