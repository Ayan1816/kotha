export const PROOF_RECIPIENT = "kotha";
export const DEMO_OWNER_ID = "demo-owner.testnet";
export const PROOF_MAX_AGE_MS = 5 * 60 * 1000;
export const PROOF_FUTURE_SKEW_MS = 60 * 1000;
export const RECORD_GAS = "30000000000000";
export const RECORD_DEPOSIT = "0";
export const DEFAULT_CONTRACT_ID = "kotha-vault-1793945609.testnet";

export const OWNER_ACTIONS = [
  "execute",
  "update_policy",
  "rotate_grant",
  "revoke_grant",
  "emergency_freeze",
  "save_tx",
] as const;

export type OwnerAction = (typeof OWNER_ACTIONS)[number];

export type WalletProofWire = {
  accountId: string;
  publicKey: string;
  signature: string;
  message: string;
  nonce: string;
};

export type FrozenChainReceipt = {
  correlation_id: string;
  agent_id: string;
  action: string;
  origin_asset: string;
  destination_asset: string;
  amount_atomic: string;
  usd_amount_cents: string;
  chat_id: string;
  signing_address: string;
  intent_hash: string;
  signature: string;
  timestamp_ns: string;
};

export type AccessKeyRow = {
  public_key?: string;
  access_key?: { permission?: unknown };
};

export type ProofAssessment =
  | { ok: true; ts: number }
  | { ok: false; code: "proof_invalid" | "proof_expired"; message: string };

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function coerceNetwork(value: string | undefined | null): "testnet" | "mainnet" {
  return value === "mainnet" ? "mainnet" : "testnet";
}

export function publicNetwork(): "testnet" | "mainnet" {
  return coerceNetwork(process.env.NEXT_PUBLIC_NETWORK);
}

export function configuredOwnerId(): string {
  return (process.env.NEXT_PUBLIC_OWNER_ID || process.env.OWNER_ID || "").trim();
}

export function publicContractId(): string {
  return process.env.NEXT_PUBLIC_CONTRACT_ID || process.env.NEXT_PUBLIC_NEAR_CONTRACT_ID || DEFAULT_CONTRACT_ID;
}

export function isOwnerSigned(accountId: string, expected = configuredOwnerId()): boolean {
  const owner = expected.trim();
  return Boolean(owner) && accountId === owner;
}

export function strictOwnerMode(): boolean {
  const flag = process.env.NEXT_PUBLIC_STRICT_OWNER;
  if (flag == null || flag.trim() === "") return true;
  return flag === "true";
}

export function connectedMayAct(accountId: string | null | undefined, expected = configuredOwnerId()): boolean {
  const id = (accountId || "").trim();
  if (strictOwnerMode()) return isOwnerSigned(id, expected);
  return Boolean(id);
}

export function ownerActionsOpen(
  accountId: string | null | undefined,
  options: { sessionOwnerOptIn: boolean; ownerId?: string },
): boolean {
  const id = (accountId || "").trim();
  if (!id) return false;
  const owner = (options.ownerId ?? configuredOwnerId()).trim();
  if (owner && id === owner) return true;
  if (id === DEMO_OWNER_ID) return true;
  if (!owner) return true;
  return options.sessionOwnerOptIn;
}

export function proofUsesSessionOwner(accountId: string, options: { sessionOwnerOptIn: boolean; ownerId?: string }): boolean {
  const id = accountId.trim();
  const owner = (options.ownerId ?? configuredOwnerId()).trim();
  if (!id) return false;
  if (id === DEMO_OWNER_ID) return true;
  if (owner && id === owner) return false;
  return options.sessionOwnerOptIn || !owner;
}

export function proofClaimsSessionOwner(message: string): boolean {
  try {
    const parsed = JSON.parse(message) as { sessionOwner?: unknown };
    return parsed?.sessionOwner === true;
  } catch {
    return false;
  }
}

export function requiresOwnerProof(type: string): boolean {
  return (OWNER_ACTIONS as readonly string[]).includes(type);
}

/** True when the client attached a wallet object. A missing proof is server-signer mode, not a 401. */
export function walletProofAttached(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function displayNetworkName(reported: string | null | undefined, network = publicNetwork()): string {
  if (network !== "mainnet") return "testnet";
  const name = (reported || "").trim().toLowerCase();
  return name === "mainnet" ? "mainnet" : name || "mainnet";
}

export const TESTNET_FAUCET_URL = "https://docs.near.org/getting-started/faucet";

export function isInsufficientBalance(message: string): boolean {
  return /does not have enough balance|insufficient balance|পর্যাপ্ত ব্যালেন্স নেই/i.test(message);
}

export function networkBadgeLabel(network = publicNetwork()): string {
  return network === "mainnet" ? "" : "Testnet Demo";
}

export function explorerTxUrl(hash: string, network = publicNetwork()): string {
  const id = encodeURIComponent(hash);
  if (network === "mainnet") return `https://nearblocks.io/txns/${id}`;
  return `https://testnet.nearblocks.io/txns/${id}`;
}

export function buildProofMessage(action: string, payload: unknown, ts: number, sessionOwner = false): string {
  if (!sessionOwner) return JSON.stringify({ action, payload, ts });
  return JSON.stringify({ action, payload, ts, sessionOwner: true });
}

export function randomNonce(): Uint8Array {
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  return nonce;
}

export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += B64[(triple >> 18) & 63];
    out += B64[(triple >> 12) & 63];
    out += index + 1 < bytes.length ? B64[(triple >> 6) & 63] : "=";
    out += index + 2 < bytes.length ? B64[triple & 63] : "=";
  }
  return out;
}

export function decodeBase64(text: string): Uint8Array | null {
  const cleaned = text.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!cleaned || cleaned.length % 4 === 1) return null;
  const pad = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
  if ((cleaned.length - pad) % 1 !== 0) return null;
  const bytes = new Uint8Array((cleaned.length / 4) * 3 - pad);
  let offset = 0;
  for (let index = 0; index < cleaned.length; index += 4) {
    const values = [0, 1, 2, 3].map((step) => {
      const char = cleaned[index + step] ?? "A";
      if (char === "=") return 0;
      const value = B64.indexOf(char);
      return value;
    });
    if (values.some((value) => value < 0)) return null;
    const triple = (values[0] << 18) | (values[1] << 12) | (values[2] << 6) | values[3];
    if (offset < bytes.length) bytes[offset++] = (triple >> 16) & 255;
    if (offset < bytes.length) bytes[offset++] = (triple >> 8) & 255;
    if (offset < bytes.length) bytes[offset++] = triple & 255;
  }
  return bytes;
}

export function assessProof(message: string, expectedAction: string, expectedPayload: unknown, now = Date.now()): ProofAssessment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return { ok: false, code: "proof_invalid", message: "Signed message is not JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "proof_invalid", message: "Signed message must be an object." };
  }
  const row = parsed as Record<string, unknown>;
  if (row.action !== expectedAction) {
    return { ok: false, code: "proof_invalid", message: "Signed action does not match the request." };
  }
  if (!deepEqual(row.payload, expectedPayload)) {
    return { ok: false, code: "proof_invalid", message: "Signed payload does not match the request." };
  }
  if (typeof row.ts !== "number" || !Number.isFinite(row.ts)) {
    return { ok: false, code: "proof_invalid", message: "Signed message is missing ts." };
  }
  if (now - row.ts > PROOF_MAX_AGE_MS) {
    return { ok: false, code: "proof_expired", message: "Wallet proof is older than 5 minutes." };
  }
  if (row.ts - now > PROOF_FUTURE_SKEW_MS) {
    return { ok: false, code: "proof_expired", message: "Wallet proof timestamp is too far in the future." };
  }
  return { ok: true, ts: row.ts };
}

export function findAccessKey(keys: AccessKeyRow[] | null | undefined, publicKey: string): AccessKeyRow | null {
  if (!publicKey || !keys) return null;
  return keys.find((row) => row.public_key === publicKey) ?? null;
}

export function isFullAccess(permission: unknown): boolean {
  return permission === "FullAccess";
}

export function isPlausibleTxHash(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(value);
}

export function txHashFromOutcome(outcome: unknown): string | null {
  if (!outcome || typeof outcome !== "object") return null;
  const row = outcome as { transaction?: { hash?: unknown }; transaction_hash?: unknown };
  const hash = typeof row.transaction?.hash === "string" ? row.transaction.hash : typeof row.transaction_hash === "string" ? row.transaction_hash : "";
  return isPlausibleTxHash(hash) ? hash : null;
}

export function chainMatches(result: unknown, receiptHash: string): boolean {
  const row = unwrapExecution(result);
  if (!row || !receiptHash) return false;
  const chainHash = stringField(row, "response_sha256") || stringField(row, "receipt_hash");
  return Boolean(chainHash) && chainHash.toLowerCase() === receiptHash.toLowerCase();
}

export function executionViewCall(contractId: string, correlationId: string): {
  contractId: string;
  method: "get_execution";
  args: { correlation_id: string };
} {
  return { contractId, method: "get_execution", args: { correlation_id: correlationId } };
}

export function walletRecordCall(contractId: string, receipt: FrozenChainReceipt, receiptHash: string): {
  contractId: string;
  method: "record_execution";
  args: { execution: Record<string, string> };
  gas: string;
  deposit: string;
} {
  // The deployed method is record_execution(execution: VerifiedExecution).
  // receipt_hash is stored as response_sha256. usd_amount_cents and timestamp_ns
  // stay digit strings so a value above 2^53 is not rounded in JavaScript.
  // Wallet JSON encoding quotes those strings. The server signer path still
  // writes unquoted digits when it is the broadcaster.
  return {
    contractId,
    method: "record_execution",
    gas: RECORD_GAS,
    deposit: RECORD_DEPOSIT,
    args: {
      execution: {
        correlation_id: receipt.correlation_id,
        agent_id: receipt.agent_id,
        action_type: receipt.action,
        origin_asset: receipt.origin_asset,
        destination_asset: receipt.destination_asset,
        amount_atomic: receipt.amount_atomic,
        usd_amount_cents: receipt.usd_amount_cents,
        near_ai_chat_id: receipt.chat_id,
        tee_signing_address: receipt.signing_address,
        request_sha256: receipt.intent_hash,
        response_sha256: receiptHash,
        tee_signature: receipt.signature,
        timestamp_ns: receipt.timestamp_ns,
      },
    },
  };
}

export function parseFrozenReceiptJson(text: string): { receipt: FrozenChainReceipt; receipt_hash: string } | null {
  try {
    const parsed = JSON.parse(text) as { receipt?: Record<string, unknown>; receipt_hash?: unknown };
    if (!parsed || typeof parsed.receipt_hash !== "string" || !parsed.receipt || typeof parsed.receipt !== "object") return null;
    const source = parsed.receipt;
    const fields = [
      "correlation_id",
      "agent_id",
      "action",
      "origin_asset",
      "destination_asset",
      "amount_atomic",
      "usd_amount_cents",
      "chat_id",
      "signing_address",
      "intent_hash",
      "signature",
      "timestamp_ns",
    ] as const;
    const receipt = {} as FrozenChainReceipt;
    for (const field of fields) {
      const value = source[field];
      if (typeof value !== "string" || !value) return null;
      receipt[field] = value;
    }
    if (!/^\d+$/.test(receipt.usd_amount_cents) || !/^\d+$/.test(receipt.timestamp_ns)) return null;
    if (!/^[0-9a-f]{64}$/i.test(parsed.receipt_hash) || !/^[0-9a-f]{64}$/i.test(receipt.intent_hash)) return null;
    return { receipt, receipt_hash: parsed.receipt_hash };
  } catch {
    return null;
  }
}

export async function createWalletProof(
  sign: (params: { message: string; recipient: string; nonce: Uint8Array }) => Promise<{ accountId: string; publicKey: string; signature: string }>,
  action: string,
  payload: unknown,
  now = Date.now(),
  sessionOwner = false,
): Promise<WalletProofWire> {
  const message = buildProofMessage(action, payload, now, sessionOwner);
  const nonce = randomNonce();
  const signed = await sign({ message, recipient: PROOF_RECIPIENT, nonce });
  return {
    accountId: signed.accountId,
    publicKey: signed.publicKey,
    signature: signed.signature,
    message,
    nonce: encodeBase64(nonce),
  };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function unwrapExecution(result: unknown): Record<string, unknown> | null {
  if (typeof result === "string") {
    try {
      return unwrapExecution(JSON.parse(result));
    } catch {
      return null;
    }
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const row = result as Record<string, unknown>;
  if (row.execution && typeof row.execution === "object" && !Array.isArray(row.execution)) {
    return row.execution as Record<string, unknown>;
  }
  return row;
}

function stringField(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  return typeof value === "string" ? value : "";
}
