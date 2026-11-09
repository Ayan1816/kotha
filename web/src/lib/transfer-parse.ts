const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
const RECIPIENT_RE = /(?:to|কে)\s+([a-z0-9_\-.]+\.(?:near|testnet))/i;
const RECIPIENT_BEFORE_RE = /([a-z0-9_\-.]+\.(?:near|testnet))\s*(?:কে|(?:to)\b)/i;

export type ParsedTransfer = { amount: string; token: string; recipient: string };
export type TransferFields = { recipient: string; amount: string; token: string };

export function foldDigits(text: string): string {
  return text.replace(/[০-৯]/g, (digit) => {
    const index = BN_DIGITS.indexOf(digit);
    return index >= 0 ? String(index) : digit;
  });
}

export function directedRecipient(text: string): string {
  const folded = foldDigits(text);
  const recipient = folded.match(RECIPIENT_RE)?.[1] || folded.match(RECIPIENT_BEFORE_RE)?.[1] || "";
  if (!recipient || /^intents\.(?:near|far)$/i.test(recipient)) return "";
  return recipient;
}

export function parseTransferCommand(message: string): ParsedTransfer | null {
  const folded = foldDigits(message);
  const recipient = folded.match(RECIPIENT_RE)?.[1] || folded.match(RECIPIENT_BEFORE_RE)?.[1] || "";
  const amountMatch = folded.match(/([0-9]+(?:\.[0-9]+)?)\s*(usdc|usdt|near|wnear)\b/i);
  if (!recipient || !amountMatch?.[1] || !amountMatch[2]) return null;
  if (/^intents\.(?:near|far)$/i.test(recipient)) return null;
  const token = amountMatch[2].toLowerCase() === "wnear" ? "wNEAR" : amountMatch[2].toUpperCase();
  return { amount: amountMatch[1].replace(/,/g, ""), token, recipient };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function fieldText(record: Record<string, unknown> | null, key: string): string {
  if (!record || !(key in record)) return "";
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return "";
  return value.trim();
}

/** Message parse runs first. Empty model fields fall through to the parsed command. */
export function readTransferFields(loose: unknown, message: string): TransferFields {
  const parsed = parseTransferCommand(message);
  const record = asRecord(loose);
  return {
    recipient:
      fieldText(record, "recipient") ||
      fieldText(record, "to") ||
      fieldText(record, "receiver_id") ||
      fieldText(record, "receiverId") ||
      parsed?.recipient ||
      "",
    amount: fieldText(record, "amount") || parsed?.amount || "",
    token: fieldText(record, "token") || parsed?.token || "",
  };
}
