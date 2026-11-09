import { extractE164, extractNearAccounts, isNearAccountId } from "./near-account";

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

export function parseAmountToken(message: string): { amount: string; token: string } | null {
  const folded = foldDigits(message);
  const amountMatch = folded.match(/([0-9]+(?:\.[0-9]+)?)\s*(usdc|usdt|near|wnear)\b/i);
  if (!amountMatch?.[1] || !amountMatch[2]) return null;
  const token = amountMatch[2].toLowerCase() === "wnear" ? "wNEAR" : amountMatch[2].toUpperCase();
  return { amount: amountMatch[1].replace(/,/g, ""), token };
}

export function parseTransferCommand(message: string): ParsedTransfer | null {
  const folded = foldDigits(message);
  const recipient = folded.match(RECIPIENT_RE)?.[1] || folded.match(RECIPIENT_BEFORE_RE)?.[1] || "";
  const amount = parseAmountToken(folded);
  if (!recipient || !amount) return null;
  if (/^intents\.(?:near|far)$/i.test(recipient)) return null;
  return { amount: amount.amount, token: amount.token, recipient };
}

/** A NEAR account in the message wins. A phone is a remittance only when no account is present. */
export function messageTransferTarget(message: string): { account: string; phone: string } {
  const folded = foldDigits(message);
  const directed = directedRecipient(folded);
  const account =
    directed && isNearAccountId(directed)
      ? directed
      : extractNearAccounts(folded).find((id) => !/^intents\.(?:near|far)$/i.test(id)) || "";
  return { account, phone: account ? "" : extractE164(folded) };
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

function usableModelRecipient(value: string): string {
  if (!value || /^INVALID_RECIPIENT/i.test(value)) return "";
  return value;
}

/** A parsed NEAR account wins over a model recipient that is not an account id. */
export function readTransferFields(loose: unknown, message: string): TransferFields {
  const parsed = parseTransferCommand(message);
  const target = messageTransferTarget(message);
  const record = asRecord(loose);
  const modelRecipient = usableModelRecipient(
    fieldText(record, "recipient") ||
      fieldText(record, "to") ||
      fieldText(record, "receiver_id") ||
      fieldText(record, "receiverId"),
  );
  const modelAccount = modelRecipient && isNearAccountId(modelRecipient) ? modelRecipient : "";
  return {
    recipient: target.account || modelAccount || target.phone || modelRecipient || parsed?.recipient || "",
    amount: fieldText(record, "amount") || parsed?.amount || "",
    token: fieldText(record, "token") || parsed?.token || "",
  };
}
