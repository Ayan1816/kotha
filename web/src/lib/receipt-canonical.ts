export type ReceiptBody = {
  action: string;
  agent_id: string;
  amount_atomic: string;
  amount_usd: string;
  chat_id: string;
  correlation_id: string;
  destination_asset: string;
  intent_hash: string;
  origin_asset: string;
  request_sha256: string;
  response_sha256: string;
  signature: string;
  signing_address: string;
  timestamp_ns: string;
  usd_amount_cents: string;
  signer_account_id?: string;
};

export type ChainExecutionView = {
  action_type: string;
  near_ai_chat_id: string;
  request_sha256: string;
  response_sha256: string;
  timestamp_ns: string;
  usd_amount_cents: string;
};

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (!value || typeof value !== "object") return "null";
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function centsToUsd(cents: string): string {
  const value = BigInt(cents);
  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  const whole = abs / BigInt(100);
  const fraction = (abs % BigInt(100)).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

export function intentDocument(input: {
  action: string;
  amount: string;
  origin_asset: string;
  destination_asset: string;
  recipient: string;
  confidential: string;
}): Record<string, string> {
  return {
    action: input.action,
    amount: input.amount,
    confidential: input.confidential,
    destination_asset: input.destination_asset,
    origin_asset: input.origin_asset,
    recipient: input.recipient,
  };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildFrozenReceipt(body: ReceiptBody): Promise<{ bytes: string; receipt_hash: string }> {
  const receipt_hash = await sha256Hex(canonicalJson(body));
  const bytes = canonicalJson({ receipt: body, receipt_hash });
  return { bytes, receipt_hash };
}

export function parseFrozenReceipt(bytes: string): { receipt: ReceiptBody; receipt_hash: string } | null {
  try {
    const parsed = JSON.parse(bytes) as { receipt?: ReceiptBody; receipt_hash?: string };
    if (!parsed?.receipt || typeof parsed.receipt_hash !== "string") return null;
    return { receipt: parsed.receipt, receipt_hash: parsed.receipt_hash };
  } catch {
    return null;
  }
}

export async function rehashReceipt(bytes: string): Promise<{ receipt: ReceiptBody; embedded: string; recomputed: string } | null> {
  const parsed = parseFrozenReceipt(bytes);
  if (!parsed) return null;
  const recomputed = await sha256Hex(canonicalJson(parsed.receipt));
  return { receipt: parsed.receipt, embedded: parsed.receipt_hash, recomputed };
}

export function readChainExecution(raw: string): ChainExecutionView | null {
  if (!raw || raw.trim() === "null") return null;
  const text = (name: string) => raw.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`))?.[1] ?? "";
  const digits = (name: string) => raw.match(new RegExp(`"${name}"\\s*:\\s*"?(\\d+)"?`))?.[1] ?? "";
  const view = {
    action_type: text("action_type"),
    near_ai_chat_id: text("near_ai_chat_id"),
    request_sha256: text("request_sha256").toLowerCase(),
    response_sha256: text("response_sha256").toLowerCase(),
    timestamp_ns: digits("timestamp_ns"),
    usd_amount_cents: digits("usd_amount_cents"),
  };
  if (!view.response_sha256) return null;
  return view;
}

export function judgeReceipt(
  receipt: ReceiptBody,
  embeddedHash: string,
  recomputedHash: string,
  chain: ChainExecutionView | null,
): { match: boolean; reason: string } {
  if (recomputedHash !== embeddedHash.toLowerCase()) {
    return { match: false, reason: "Downloaded receipt hash does not match its canonical JSON." };
  }
  if (!chain) return { match: false, reason: "get_execution returned no record." };
  if (chain.response_sha256 !== recomputedHash) {
    return { match: false, reason: "receipt_hash does not match get_execution." };
  }
  if (chain.request_sha256 !== receipt.intent_hash.toLowerCase()) {
    return { match: false, reason: "intent hash does not match get_execution." };
  }
  if (chain.near_ai_chat_id !== receipt.chat_id) return { match: false, reason: "chat_id does not match get_execution." };
  if (chain.action_type !== receipt.action) return { match: false, reason: "action does not match get_execution." };
  if (chain.usd_amount_cents !== receipt.usd_amount_cents) return { match: false, reason: "amount_usd does not match get_execution." };
  if (chain.timestamp_ns !== receipt.timestamp_ns) return { match: false, reason: "timestamp does not match get_execution." };
  return { match: true, reason: "receipt_hash matches get_execution." };
}
