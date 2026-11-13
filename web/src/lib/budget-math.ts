export const SPEND_ACTIONS = ["swap", "transfer", "shield", "unshield", "withdraw"] as const;
export type SpendAction = (typeof SPEND_ACTIONS)[number];

export const ZERO_AMOUNT_WARNING = "Amount must be greater than zero.";

export function roundUsd(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

export function utcDayStamp(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function projectSpend(
  currentSpentUsd: number,
  txUsd: number,
): { currentSpentUsd: number; txUsd: number; projectedSpentUsd: number } {
  const current = roundUsd(currentSpentUsd);
  const tx = roundUsd(txUsd);
  return {
    currentSpentUsd: current,
    txUsd: tx,
    projectedSpentUsd: roundUsd(current + tx),
  };
}

export function projectActionSpend(action: SpendAction, currentSpentUsd: number, txUsd: number) {
  return { action, ...projectSpend(currentSpentUsd, txUsd) };
}

export function invalidAmountReason(
  intent: { amount: string; amount_usd_estimate?: number },
  warnings: readonly string[],
): string | null {
  const warned = warnings.find((warning) => warning === ZERO_AMOUNT_WARNING || /^Invalid amount\b/i.test(warning));
  if (warned) return warned;
  const raw = intent.amount.trim().replace(/,/g, "");
  if (raw.startsWith("-")) return ZERO_AMOUNT_WARNING;
  if (raw === "" || /^0+(?:\.0+)?$/.test(raw)) {
    if (typeof intent.amount_usd_estimate === "number" && intent.amount_usd_estimate > 0) return null;
    return ZERO_AMOUNT_WARNING;
  }
  return null;
}

export function dayFromTimestampNs(timestampNs: string): string | null {
  if (!/^\d+$/.test(timestampNs)) return null;
  let ms: bigint;
  try {
    ms = BigInt(timestampNs) / 1_000_000n;
  } catch {
    return null;
  }
  if (ms > 8_640_000_000_000_000n) return null;
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return null;
  return utcDayStamp(date);
}

export function sumTodayReceiptUsd(records: Iterable<{ bytes: string }>, day: string): number {
  let cents = 0n;
  for (const record of records) {
    const part = receiptCentsOnDay(record.bytes, day);
    if (part == null) continue;
    cents += part;
  }
  return centsToNumber(cents);
}

function receiptCentsOnDay(bytes: string, day: string): bigint | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const receipt = (parsed as { receipt?: unknown }).receipt;
  if (!receipt || typeof receipt !== "object") return null;
  const body = receipt as { timestamp_ns?: unknown; usd_amount_cents?: unknown; amount_usd?: unknown };
  if (dayFromTimestampNs(String(body.timestamp_ns ?? "")) !== day) return null;
  const cents = centsOf(body);
  if (cents == null || cents < 0n) return null;
  return cents;
}

function centsOf(body: { usd_amount_cents?: unknown; amount_usd?: unknown }): bigint | null {
  const raw = body.usd_amount_cents;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return BigInt(raw);
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return BigInt(Math.round(raw));
  if (typeof body.amount_usd === "string" && /^\d+(\.\d+)?$/.test(body.amount_usd)) {
    const [whole, frac = ""] = body.amount_usd.split(".");
    return BigInt(whole) * 100n + BigInt(`${frac}00`.slice(0, 2));
  }
  return null;
}

const SPEND_EPOCH = "2020-01-01";

export function isSampleExecution(row: { correlation_id?: string; request_sha256?: string; response_sha256?: string }): boolean {
  const id = row.correlation_id || "";
  if (id.startsWith("kotha-ci-") || id.startsWith("aegis-corr-")) return true;
  return placeholderHash(row.request_sha256) || placeholderHash(row.response_sha256);
}

function placeholderHash(value: string | undefined): boolean {
  const text = (value || "").trim();
  return text.length >= 16 && /^(?:a+|b+)$/i.test(text);
}

/** Sum today's chain executions. Sample rows and timestamps before 2020 do not count. */
export function chainSpentTodayUsd(
  rows: Iterable<{
    correlation_id?: string;
    request_sha256?: string;
    response_sha256?: string;
    timestamp_ns?: string;
    usd_amount_cents?: string | number;
  }>,
  day = utcDayStamp(),
): number {
  let cents = 0n;
  for (const row of rows) {
    if (isSampleExecution(row)) continue;
    const stamp = dayFromTimestampNs(String(row.timestamp_ns ?? ""));
    if (!stamp || stamp < SPEND_EPOCH || stamp !== day) continue;
    const part = centsFromUnknown(row.usd_amount_cents);
    if (part == null || part < 0n) continue;
    cents += part;
  }
  return centsToNumber(cents);
}

function centsFromUnknown(raw: string | number | undefined): bigint | null {
  if (typeof raw === "string" && /^\d+$/.test(raw)) return BigInt(raw);
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return BigInt(Math.round(raw));
  return null;
}

function centsToNumber(cents: bigint): number {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const text = `${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
  const value = Number(text);
  return negative ? -value : value;
}
