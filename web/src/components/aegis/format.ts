import { translate, type CopyKey, type Lang } from "@/components/aegis/copy";
import type { AegisIntent, IntentAction, NetworkComponentStatus, VerifiedExecution } from "@/lib/dashboard-types";

const DATE_LOCALE: Record<Lang, string> = {
  en: "en-US",
  bn: "bn-BD",
  es: "es-ES",
  ar: "ar-SA",
  hi: "hi-IN",
  fr: "fr-FR",
  zh: "zh-CN",
};

const ASSETS: Record<string, { symbol: string; decimals: number }> = {
  "nep141:wrap.near": { symbol: "wNEAR", decimals: 24 },
  "nep141:usdt.tether-token.near": { symbol: "USDT", decimals: 6 },
  "nep141:usdc.near": { symbol: "USDC", decimals: 6 },
};

export function assetLabel(assetId: string): { symbol: string; decimals: number } {
  const known = ASSETS[assetId];
  if (known) return known;
  const tail = assetId.split(":").pop() || assetId;
  return { symbol: tail, decimals: assetId.includes("wrap.near") ? 24 : 6 };
}

/** Card symbol. Plain NEAR transfers display NEAR; wNEAR stays in the route line. Swaps keep wNEAR. */
export function previewSymbol(assetId: string, action?: string): string {
  const symbol = assetLabel(assetId).symbol;
  if (symbol === "wNEAR" && action !== "swap") return "NEAR";
  return symbol;
}

const NEAR_ACCOUNT = /^[a-z0-9](?:[a-z0-9_\-.]{0,61}[a-z0-9])?\.(?:near|testnet|tg)$/i;

export function isNativeNearTransfer(intent: Pick<AegisIntent, "action" | "origin_asset" | "destination_asset" | "recipient">): boolean {
  if (intent.action !== "transfer") return false;
  const origin = assetLabel(intent.origin_asset).symbol;
  const destination = assetLabel(intent.destination_asset).symbol;
  if (origin !== "wNEAR" && origin !== "NEAR") return false;
  if (destination !== "wNEAR" && destination !== "NEAR") return false;
  return NEAR_ACCOUNT.test(intent.recipient.trim());
}

/** Slippage is a swap quote. Plain transfers do not show the row. */
export function showSlippageRow(intent: Pick<AegisIntent, "action">): boolean {
  return intent.action === "swap";
}

/** The wNEAR settlement note is for intent swaps, not a native NEAR transfer. */
export function showWnearLine(intent: Pick<AegisIntent, "action" | "origin_asset" | "destination_asset" | "recipient">): boolean {
  if (intent.action === "transfer" || intent.action === "withdraw") return false;
  return assetLabel(intent.origin_asset).symbol === "wNEAR";
}

export function actionCopyKey(action: string): CopyKey {
  if (action === "swap") return "actionSwap";
  if (action === "transfer") return "actionTransfer";
  if (action === "withdraw") return "actionWithdraw";
  if (action === "shield") return "actionShield";
  if (action === "unshield") return "actionUnshield";
  return "action";
}

export function testnetLabel(lang: Lang, value: string): string {
  if (process.env.NEXT_PUBLIC_NETWORK === "mainnet") return value;
  return value.replace(/\b(?:outlayer\.near|intents\.near|intents\.far)\b/g, translate(lang, "demoTestnet"));
}

export function displayRoute(lang: Lang, intent: Pick<AegisIntent, "action" | "origin_asset" | "destination_asset" | "recipient">, route: string): string {
  const labeled = testnetLabel(lang, route);
  if (!isNativeNearTransfer(intent)) return labeled;
  return labeled.replace(/\bwNEAR\b/g, "NEAR");
}

export function formatAtomic(atomic: string, decimals: number): string {
  const negative = atomic.startsWith("-");
  const digits = (negative ? atomic.slice(1) : atomic).replace(/\D/g, "");
  if (!digits) return "0";
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  const text = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${text}` : text;
}

export function amountSummary(row: VerifiedExecution): string {
  const origin = assetLabel(row.origin_asset);
  const destination = assetLabel(row.destination_asset);
  const human = formatAtomic(row.amount_atomic, origin.decimals);
  if (destination.symbol === origin.symbol) return `${human} ${origin.symbol}`;
  return `${human} ${origin.symbol} → ${destination.symbol}`;
}

export function timestampMs(timestampNs: string): number | null {
  if (!/^\d+$/.test(timestampNs)) return null;
  try {
    const ms = BigInt(timestampNs) / BigInt("1000000");
    const asNumber = Number(ms);
    return Number.isFinite(asNumber) ? asNumber : null;
  } catch {
    return null;
  }
}

export function formatTimestamp(timestampNs: string, lang: Lang): string {
  const ms = timestampMs(timestampNs);
  if (ms == null) return timestampNs;
  return new Date(ms).toLocaleString(DATE_LOCALE[lang], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatIso(iso: string, lang: Lang): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString(DATE_LOCALE[lang], {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function shortHash(value: string, lead = 10, tail = 8): string {
  if (value.length <= lead + tail + 3) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function getExecutionCommand(contractId: string, correlationId: string): string {
  const args = JSON.stringify({ correlation_id: correlationId });
  return `near contract call-function as-read-only ${contractId} get_execution json-args ${shellQuote(args)} network-config testnet now`;
}

export function signatureCurl(baseUrl: string, chatId: string, model: string): string {
  const root = baseUrl.replace(/\/$/, "") || "https://cloud-api.near.ai/v1";
  const url = `${root}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
  return `curl -sS ${shellQuote(url)} -H ${shellQuote("Authorization: Bearer $NEAR_AI_CLOUD_API_KEY")}`;
}

export function attestationCurl(baseUrl: string, model: string, nonce: string): string {
  const root = baseUrl.replace(/\/$/, "") || "https://cloud-api.near.ai/v1";
  const url = `${root}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${encodeURIComponent(nonce)}`;
  return `curl -sS ${shellQuote(url)} -H ${shellQuote("Authorization: Bearer $NEAR_AI_CLOUD_API_KEY")}`;
}

export function statusTone(status: NetworkComponentStatus | undefined): string {
  if (status === "operational") return "bg-[#00EC97] shadow-[0_0_10px_#00EC97]";
  if (status === "degraded") return "bg-[#FF8A00] shadow-[0_0_10px_#FF8A00]";
  if (status === "down") return "bg-[#FF3B5C] shadow-[0_0_10px_#FF3B5C]";
  return "bg-white/40";
}

export function actionTone(action: string): string {
  if (action === "swap") return "text-[#00D2FF] border-[#00D2FF]/40 bg-[#00D2FF]/10";
  if (action === "transfer") return "text-[#C4B5FD] border-[#7B61FF]/40 bg-[#7B61FF]/15";
  if (action === "withdraw") return "text-[#FFB020] border-[#FF8A00]/40 bg-[#FF8A00]/10";
  if (action === "shield") return "text-[#00EC97] border-[#00EC97]/40 bg-[#00EC97]/10";
  if (action === "unshield") return "text-[#7DD3FC] border-[#00D2FF]/30 bg-white/5";
  return "text-white/80 border-white/15 bg-white/5";
}

export function isIntentAction(value: string): value is IntentAction {
  return value === "swap" || value === "transfer" || value === "withdraw" || value === "shield" || value === "unshield";
}
