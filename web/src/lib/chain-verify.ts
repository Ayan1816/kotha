import type { CopyKey } from "@/components/aegis/copy";

export type VerifyCode =
  | "match"
  | "missing"
  | "no_receipt"
  | "response"
  | "request"
  | "action"
  | "cents"
  | "amount"
  | "chat"
  | "agent";

export type VerifyResult = {
  status: "match" | "mismatch" | "missing";
  code: VerifyCode;
};

const REASON_KEY: Record<VerifyCode, CopyKey> = {
  match: "chainMatch",
  missing: "chainMissing",
  no_receipt: "verifyNoReceipt",
  response: "verifyResponse",
  request: "verifyRequest",
  action: "verifyAction",
  cents: "verifyCents",
  amount: "verifyAmount",
  chat: "verifyChat",
  agent: "verifyAgent",
};

export function verifyReasonKey(code: VerifyCode): CopyKey {
  return REASON_KEY[code];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "null") return null;
    try {
      return asRecord(JSON.parse(trimmed) as unknown);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.receipt && typeof row.receipt === "object") return asRecord(row.receipt);
  if ("raw" in row && (typeof row.raw === "string" || (row.raw && typeof row.raw === "object"))) return asRecord(row.raw);
  return row;
}

function textField(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function normHash(value: string): string {
  return value.trim().toLowerCase();
}

function normInt(value: string): string {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return trimmed;
  return trimmed.replace(/^(-?)0+(?=\d)/, "$1");
}

/**
 * Compare a chain execution to a frozen receipt by the fields both sides store.
 * `receipt_hash` and `intent_hash` are different values and are not part of this check.
 * A missing chain record is "missing", even when a receipt exists.
 */
export function compareChainToReceipt(chain: unknown, receipt: unknown): VerifyResult {
  const chainRow = asRecord(chain);
  if (!chainRow || !normHash(textField(chainRow, ["response_sha256"]))) {
    return { status: "missing", code: "missing" };
  }
  const receiptRow = asRecord(receipt);
  if (!receiptRow) return { status: "mismatch", code: "no_receipt" };

  const required: Array<[VerifyCode, string, string]> = [
    ["response", normHash(textField(chainRow, ["response_sha256"])), normHash(textField(receiptRow, ["response_sha256"]))],
    ["request", normHash(textField(chainRow, ["request_sha256"])), normHash(textField(receiptRow, ["request_sha256"]))],
    ["action", textField(chainRow, ["action_type", "action"]), textField(receiptRow, ["action", "action_type"])],
    ["cents", normInt(textField(chainRow, ["usd_amount_cents"])), normInt(textField(receiptRow, ["usd_amount_cents"]))],
  ];
  for (const [code, left, right] of required) {
    if (!left || !right || left !== right) return { status: "mismatch", code };
  }

  const chainAmount = textField(chainRow, ["amount_atomic"]);
  const receiptAmount = textField(receiptRow, ["amount_atomic"]);
  if (chainAmount && receiptAmount && chainAmount !== receiptAmount) return { status: "mismatch", code: "amount" };

  const chainChat = textField(chainRow, ["near_ai_chat_id", "chat_id"]);
  const receiptChat = textField(receiptRow, ["chat_id", "near_ai_chat_id"]);
  if (chainChat && receiptChat && chainChat !== receiptChat) return { status: "mismatch", code: "chat" };

  const chainAgent = textField(chainRow, ["agent_id"]);
  const receiptAgent = textField(receiptRow, ["agent_id"]);
  if (chainAgent && receiptAgent && chainAgent !== receiptAgent) return { status: "mismatch", code: "agent" };

  return { status: "match", code: "match" };
}
