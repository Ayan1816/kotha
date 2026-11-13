import { fillCopy, translate, type CopyKey, type Lang } from "@/components/aegis/copy";
import { humanizeVisibleCodes } from "@/lib/policy-codes";
import { isNativeNearTransfer } from "@/components/aegis/format";
import type { AegisIntent } from "@/lib/dashboard-types";
import { extractE164, isImplicitAccount, isNearAccountId } from "@/lib/near-account";
import { amountIssue } from "@/lib/transfer-parse";
import { isInsufficientBalance, txHashFromOutcome, RECORD_DEPOSIT, RECORD_GAS } from "@/lib/wallet-proof";

/** Extra yoctoNEAR reserved so the sender can pay gas on the transfer and the proof call. 0.02 NEAR. */
export const NATIVE_GAS_BUFFER_YOCTO = 20_000_000_000_000_000_000_000n;

export const PER_TX_CAP_CENTS = 5_000;
export const DAILY_CAP_CENTS = 10_000;

export type NativeProofFields = {
  request_sha256: string;
  response_sha256: string;
  tee_signature: string;
  near_ai_chat_id: string;
  tee_signing_address: string;
};

export type WalletExecution = {
  correlation_id: string;
  agent_id: string;
  action_type: "transfer";
  origin_asset: string;
  destination_asset: string;
  amount_atomic: string;
  usd_amount_cents: number;
  near_ai_chat_id: string;
  tee_signing_address: string;
  request_sha256: string;
  response_sha256: string;
  tee_signature: string;
  timestamp_ns: number;
};

export type NativeTransferBatch = {
  transactions: [
    {
      receiverId: string;
      actions: [{ type: "Transfer"; params: { deposit: string } }];
    },
    {
      receiverId: string;
      actions: [
        {
          type: "FunctionCall";
          params: {
            methodName: "record_execution";
            args: { execution: WalletExecution };
            gas: string;
            deposit: string;
          };
        },
      ];
    },
  ];
};

export type CardOutcome = {
  tone: "ok" | "warn" | "fail";
  text?: string;
  transferHash?: string;
  proofHash?: string;
  faucet?: boolean;
  amount?: string;
  recipient?: string;
  proofMissing?: boolean;
  failKey?: CopyKey;
};

export type ExecuteAdmission = "start" | "busy" | "sent";

/** A second tap while a wallet request is open, or after this card already sent, must not start another payment. */
export function executeAdmission(input: { inFlight: boolean; alreadyExecuted: boolean }): ExecuteAdmission {
  if (input.inFlight) return "busy";
  if (input.alreadyExecuted) return "sent";
  return "start";
}

/** Success and failure copy follows the language on screen, not the language at click time. */
export function describeExecuteOutcome(lang: Lang, outcome: CardOutcome): string {
  if (outcome.failKey) {
    const sentence = translate(lang, outcome.failKey);
    if (sentence) return humanizeVisibleCodes(lang, sentence);
  }
  if (outcome.amount && outcome.recipient && (outcome.tone === "ok" || outcome.tone === "warn")) {
    const sent = fillCopy(lang, "executeSent", { amount: outcome.amount, recipient: outcome.recipient });
    const extra = outcome.proofMissing ? translate(lang, "executeProofMissing") : translate(lang, "executedNotice");
    return humanizeVisibleCodes(lang, `${sent} ${extra}`.trim());
  }
  return humanizeVisibleCodes(lang, outcome.text || "");
}

export type WalletFailureKind = "rejected" | "insufficient" | "unauthorized" | "other";

type TransferIntent = Pick<AegisIntent, "action" | "origin_asset" | "destination_asset" | "recipient">;

/** Why Execute must stay off. Null means this card may send native NEAR. */
export function nativeExecuteBlock(intent: TransferIntent): CopyKey | null {
  if (isNativeNearTransfer(intent)) return null;
  const recipient = intent.recipient.trim();
  if (extractE164(recipient) || looksLikePhone(recipient)) return "executePhoneRecipient";
  if (intent.action === "transfer" && !isNearAccountId(recipient)) return "executeInvalidRecipient";
  return "executeNativeOnly";
}

/** Decimal NEAR to a yocto string. Throws on empty, negative, zero, or more than 24 fractional digits. */
export function nearToYoctoString(amount: string): string {
  const trimmed = amount.trim().replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(trimmed) || amountIssue(trimmed, "NEAR")) {
    throw new Error("invalid_amount");
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > 24) throw new Error("invalid_amount");
  const digits = `${whole}${frac.padEnd(24, "0")}`.replace(/^0+/, "") || "0";
  if (digits === "0") throw new Error("invalid_amount");
  return digits;
}

export function notionalCents(txUsd: number | null | undefined, estimate?: number): number {
  const usd = positiveUsd(txUsd) ?? positiveUsd(estimate) ?? 0;
  if (usd <= 0) return 0;
  return Math.max(0, Math.round(usd * 100));
}

export function namedAccountMustExist(recipient: string): boolean {
  return !isImplicitAccount(recipient);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function localTransferProof(attestation: {
  requestSha256?: string;
  responseSha256?: string;
  signature?: string;
  chatId?: string;
  signing_address?: string;
}): Promise<NativeProofFields> {
  const request = await hex64(attestation.requestSha256, "local-preview-request");
  const response = await hex64(attestation.responseSha256, `local-preview-response:${request}`);
  const given = (attestation.signature || "").trim();
  const signature = given.length >= 64 ? given : await sha256Hex(`local-preview:${request}${response}`);
  return {
    request_sha256: request,
    response_sha256: response,
    tee_signature: signature,
    near_ai_chat_id: (attestation.chatId || "").trim() || "local-preview",
    tee_signing_address: (attestation.signing_address || "").trim() || "local-preview",
  };
}

export function proofMeetsContract(fields: NativeProofFields): boolean {
  return /^[0-9a-f]{64}$/.test(fields.request_sha256) && /^[0-9a-f]{64}$/.test(fields.response_sha256) && fields.tee_signature.length >= 64;
}

export function buildNativeTransferBatch(recipient: string, yocto: string, contractId: string, execution: WalletExecution): NativeTransferBatch {
  return {
    transactions: [
      {
        receiverId: recipient,
        actions: [{ type: "Transfer", params: { deposit: yocto } }],
      },
      {
        receiverId: contractId,
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: "record_execution",
              args: { execution },
              gas: RECORD_GAS,
              deposit: RECORD_DEPOSIT,
            },
          },
        ],
      },
    ],
  };
}

export function hashesFromOutcomes(outcomes: unknown): { transferHash: string; proofHash: string } {
  const list = Array.isArray(outcomes) ? outcomes : [outcomes];
  return {
    transferHash: txHashFromOutcome(list[0]) || "",
    proofHash: txHashFromOutcome(list[1]) || "",
  };
}

/** True when a resolved wallet outcome says the transaction itself failed. */
export function executionFailed(outcome: unknown): boolean {
  if (!outcome || typeof outcome !== "object") return false;
  const status = (outcome as { status?: unknown }).status;
  if (status === "Failure") return true;
  return Boolean(status && typeof status === "object" && "Failure" in status);
}

export function classifyWalletError(error: unknown): WalletFailureKind {
  const message = errorText(error);
  if (/reject|cancel|dismiss|denied by user|user denied/i.test(message)) return "rejected";
  if (isInsufficientBalance(message) || /not enough (?:near|balance|tokens)|insufficient funds/i.test(message)) return "insufficient";
  if (/unauthorized|PROHORI_UNAUTHORIZED/i.test(message)) return "unauthorized";
  return "other";
}

export function accountMissingError(error: unknown): boolean {
  return /does not exist|doesn't exist|do not exist|unknown account|AccountDoesNotExist|account .{0,40}not found/i.test(errorText(error));
}

export function unsupportedBatchError(error: unknown): boolean {
  const message = errorText(error);
  if (/reject|cancel|denied/i.test(message)) return false;
  return /not support|unsupported|not implemented/i.test(message);
}

export function senderCovers(balance: bigint, yocto: string, buffer = NATIVE_GAS_BUFFER_YOCTO): boolean {
  return balance >= BigInt(yocto) + buffer;
}

export function asYocto(value: unknown): bigint | null {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function looksLikePhone(value: string): boolean {
  const compact = value.replace(/[\s().-]/g, "");
  return /^\+\d{8,15}$/.test(compact);
}

function positiveUsd(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

async function hex64(value: string | undefined, fallback: string): Promise<string> {
  const trimmed = (value || "").trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(trimmed)) return trimmed;
  return sha256Hex(trimmed || fallback);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}
