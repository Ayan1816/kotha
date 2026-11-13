import { verifyMessage } from "near-api-js/nep413";
import { VIEW_TIMEOUT_MS, rpcCandidates } from "./near-vault-rpc";
import {
  DEMO_OWNER_ID,
  PROOF_RECIPIENT,
  assessProof,
  configuredOwnerId,
  decodeBase64,
  findAccessKey,
  proofClaimsSessionOwner,
  type AccessKeyRow,
  type WalletProofWire,
} from "./wallet-proof";

export class WalletAuthError extends Error {
  readonly code: "owner_required" | "proof_expired" | "proof_invalid";
  readonly status = 401;

  constructor(code: WalletAuthError["code"], message: string) {
    super(message);
    this.name = "WalletAuthError";
    this.code = code;
  }
}

type RpcFetch = (url: string, init: { method: string; body: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

const defaultFetch: RpcFetch = async (url, init) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: init.body,
    signal: AbortSignal.timeout(VIEW_TIMEOUT_MS),
  });
  return { ok: response.ok, json: () => response.json() };
};

export async function requireOwnerProof(input: {
  proof: unknown;
  action: string;
  payload: unknown;
  now?: number;
  ownerId?: string;
  rpcUrl?: string;
  fetchImpl?: RpcFetch;
  allowedAccounts?: string[];
}): Promise<void> {
  const proof = readProof(input.proof);
  if (!proof) throw new WalletAuthError("proof_invalid", "Wallet proof is missing.");
  const nonce = decodeBase64(proof.nonce);
  if (!nonce || nonce.length !== 32) throw new WalletAuthError("proof_invalid", "Wallet nonce must be 32 bytes.");
  const signature = decodeBase64(proof.signature);
  if (!signature || (signature.length !== 64 && signature.length !== 65)) {
    throw new WalletAuthError("proof_invalid", "Wallet signature could not be read.");
  }
  const assessed = assessProof(proof.message, input.action, input.payload, input.now ?? Date.now());
  if (!assessed.ok) throw new WalletAuthError(assessed.code, assessed.message);
  if (proof.accountId === DEMO_OWNER_ID) {
    await verifySignedProof(proof, nonce, signature, "FullAccess");
    return;
  }
  const owner = (input.ownerId ?? configuredOwnerId()).trim();
  const allowed = new Set((input.allowedAccounts ?? []).map((id) => id.trim()).filter((id) => id.length > 0));
  const sessionOwner = proofClaimsSessionOwner(proof.message);
  if (!(sessionOwner && proof.accountId) && !allowed.has(proof.accountId) && (!owner || proof.accountId !== owner)) {
    throw new WalletAuthError("owner_required", "Connect the owner wallet.");
  }
  const urls = input.rpcUrl?.trim() ? [input.rpcUrl.trim()] : rpcUrlsForAccount(proof.accountId);
  let keys: AccessKeyRow[] | null = null;
  let lastError: unknown;
  for (const rpcUrl of urls) {
    try {
      keys = await loadAccessKeys(proof.accountId, rpcUrl, input.fetchImpl ?? defaultFetch);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!keys) {
    if (lastError instanceof WalletAuthError) throw lastError;
    throw new WalletAuthError("proof_invalid", "Could not read the account access keys.");
  }
  const listed = findAccessKey(keys, proof.publicKey);
  if (!listed) throw new WalletAuthError("proof_invalid", "Public key is not on the account.");
  await verifySignedProof(proof, nonce, signature, listed.access_key?.permission);
}

function rpcUrlsForAccount(accountId: string): string[] {
  if (accountId.endsWith(".near")) return ["https://rpc.mainnet.near.org"];
  return rpcCandidates();
}

async function verifySignedProof(proof: WalletProofWire, nonce: Uint8Array, signature: Uint8Array, permission: unknown): Promise<void> {
  try {
    await verifyMessage({
      signerAccountId: proof.accountId,
      signerPublicKey: proof.publicKey,
      payload: { message: proof.message, recipient: PROOF_RECIPIENT, nonce },
      signature,
      provider: {
        viewAccessKey: async () => ({ permission }),
      } as never,
    });
  } catch (error) {
    if (error instanceof WalletAuthError) throw error;
    throw new WalletAuthError("proof_invalid", "Wallet signature was rejected.");
  }
}

async function loadAccessKeys(accountId: string, rpcUrl: string, fetchImpl: RpcFetch): Promise<AccessKeyRow[]> {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "kotha-wallet",
      method: "query",
      params: {
        request_type: "view_access_key_list",
        finality: "final",
        account_id: accountId,
      },
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new WalletAuthError("proof_invalid", "Could not read the account access keys.");
  const result = (body as { result?: { keys?: AccessKeyRow[] } } | null)?.result;
  if (!result || !Array.isArray(result.keys)) throw new WalletAuthError("proof_invalid", "Could not read the account access keys.");
  return result.keys;
}

function readProof(value: unknown): WalletProofWire | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const accountId = row.accountId;
  const publicKey = row.publicKey;
  const signature = row.signature;
  const message = row.message;
  const nonce = row.nonce;
  if (
    typeof accountId !== "string" ||
    typeof publicKey !== "string" ||
    typeof signature !== "string" ||
    typeof message !== "string" ||
    typeof nonce !== "string"
  ) {
    return null;
  }
  if (!accountId || !publicKey || !signature || !message || !nonce || message.length > 20_000) return null;
  return { accountId, publicKey, signature, message, nonce };
}
