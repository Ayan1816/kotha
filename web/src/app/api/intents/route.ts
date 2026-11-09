import { NextResponse } from "next/server";
import {
  AgentOperationError,
  executeIntentWithGrant,
  getAgentState,
  simulateDemoExecution,
  getNetworkAndTokens,
  rotateOrRevokeGrant,
  runDryRunPreview,
  setEmergencyFreeze,
  updateOwnerPolicy,
  type TeeProofInput,
} from "@/lib/intents-agent";
import { getVaultInfo, listExecutions, recordVerifiedExecution, type VerifiedExecution } from "@/lib/near-vault-rpc";
import { anchorExecutionReceipt, overlayReceiptRows, saveReceiptTxHash } from "@/lib/receipt-service";
import type { AegisIntent } from "@/lib/dashboard-types";
import { adminCookieInit, adminSessionValid, allowAdminAttempt, checkAdminCode, ownerProofRequired, signAdminSession } from "@/lib/admin-session";
import { configuredOwnerId, DEFAULT_CONTRACT_ID, DEMO_OWNER_ID, isPlausibleTxHash, publicNetwork, strictOwnerMode, walletProofAttached } from "@/lib/wallet-proof";
import { requireOwnerProof, WalletAuthError } from "@/lib/wallet-verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = ["dry_run", "execute", "update_policy", "rotate_grant", "revoke_grant", "emergency_freeze", "save_tx", "admin_unlock", "admin_lock"] as const;
type IntentRouteAction = (typeof ACTIONS)[number];

export async function GET(request: Request) {
  try {
    const [catalog, agentState, vaultInfo, executions] = await Promise.all([
      getNetworkAndTokens(),
      getAgentState(),
      getVaultInfo(),
      listExecutions(),
    ]);
    return NextResponse.json({
      network: labelNetwork(catalog.network),
      tokens: catalog.tokens,
      agentState,
      vaultInfo,
      executions: await overlayReceiptRows(executions),
      admin: adminSessionValid(request.headers.get("cookie")),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: "invalid_json", message: "Request body must be JSON." } }, { status: 400 });
  }
  const record = asRecord(body);
  if (!record) {
    return NextResponse.json({ error: { code: "invalid_json", message: "Request body must be a JSON object." } }, { status: 400 });
  }
  const type = record.type;
  if (!isAction(type)) {
    return NextResponse.json(
      { error: { code: "invalid_action", message: "type must be dry_run, execute, update_policy, rotate_grant, revoke_grant, emergency_freeze, save_tx, admin_unlock, or admin_lock." } },
      { status: 400 },
    );
  }
  const payload = asRecord(record.payload) ?? {};
  if (type === "admin_unlock") return unlockAdmin(request, payload);
  if (type === "admin_lock") return lockAdmin();
  const admin = adminSessionValid(request.headers.get("cookie"));
  const walletAttached = walletProofAttached(record.wallet);
  const useWallet = walletAttached && !admin;
  const enforceOwner = ownerProofRequired({
    action: type,
    admin,
    walletAttached,
    strictOwner: strictOwnerMode(),
    ownerId: configuredOwnerId(),
  });
  if (enforceOwner) {
    try {
      await requireOwnerProof({ proof: record.wallet, action: type, payload });
    } catch (error) {
      if (error instanceof WalletAuthError) {
        return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: 401 });
      }
      return NextResponse.json({ error: { code: "proof_invalid", message: "Wallet proof was rejected." } }, { status: 401 });
    }
  }
  const signerAccountId = useWallet ? proofAccountId(record.wallet) : serverSignerAccount();
  try {
    if (type === "dry_run") {
      const preview = await runDryRunPreview(payload.intent);
      return NextResponse.json({ type, preview });
    }
    if (type === "execute") {
      const tee = (asRecord(payload.teeAttestation) ?? asRecord(payload.attestation) ?? {}) as TeeProofInput;
      if (useWallet && proofAccountId(record.wallet) === DEMO_OWNER_ID) {
        const execution = await simulateDemoExecution(payload.intent, tee);
        return NextResponse.json({
          type,
          simulated: true,
          execution,
          vault: {
            execution: toVaultRecord(execution),
            commands: { record_execution: "", get_execution: "" },
            tx_hash: null,
            receipt_hash: "",
            chain_error: "Demo signer does not broadcast or call record_execution.",
          },
        });
      }
      const execution = await executeIntentWithGrant(payload.intent, tee);
      const vault = await recordVerifiedExecution(toVaultRecord(execution));
      const anchored = await anchorExecutionReceipt(execution, asIntent(payload.intent), {
        skipChain: useWallet,
        signerAccountId,
      });
      return NextResponse.json({
        type,
        execution: { ...execution, signer_account_id: signerAccountId },
        vault: { ...vault, tx_hash: anchored.txHash, receipt_hash: anchored.receiptHash, chain_error: anchored.chainError },
      });
    }
    if (type === "save_tx") {
      const id = typeof payload.id === "string" ? payload.id.trim() : "";
      const txHash = typeof payload.tx_hash === "string" ? payload.tx_hash.trim() : "";
      if (!id || id.length > 200 || !isPlausibleTxHash(txHash)) {
        return NextResponse.json({ error: { code: "invalid_tx", message: "Receipt id and transaction hash are required." } }, { status: 400 });
      }
      const saved = await saveReceiptTxHash(id, txHash);
      if (!saved) {
        return NextResponse.json({ error: { code: "receipt_not_found", message: "No frozen receipt is stored for that id." } }, { status: 404 });
      }
      return NextResponse.json({ type, id, tx_hash: txHash });
    }
    if (type === "update_policy") {
      const policy = await updateOwnerPolicy(payload.policy ?? payload);
      return NextResponse.json({ type, ...policy });
    }
    if (type === "rotate_grant" || type === "revoke_grant") {
      const grant = await rotateOrRevokeGrant(type === "rotate_grant" ? "rotate" : "revoke");
      return NextResponse.json({ type, ...grant });
    }
    if (typeof payload.frozen !== "boolean") {
      return NextResponse.json({ error: { code: "invalid_freeze", message: "payload.frozen must be a boolean." } }, { status: 400 });
    }
    const freeze = await setEmergencyFreeze(payload.frozen);
    return NextResponse.json({ type, ...freeze });
  } catch (error) {
    return errorResponse(error);
  }
}

function toVaultRecord(execution: {
  correlation_id: string;
  agent_id: string;
  action_type: string;
  origin_asset: string;
  destination_asset: string;
  amount_atomic: string;
  usd_amount_cents: string;
  near_ai_chat_id: string;
  tee_signing_address: string;
  request_sha256: string;
  response_sha256: string;
  tee_signature: string;
  timestamp_ns: string;
}): VerifiedExecution {
  return {
    correlation_id: execution.correlation_id,
    agent_id: execution.agent_id,
    action_type: execution.action_type,
    origin_asset: execution.origin_asset,
    destination_asset: execution.destination_asset,
    amount_atomic: execution.amount_atomic,
    usd_amount_cents: execution.usd_amount_cents,
    near_ai_chat_id: execution.near_ai_chat_id,
    tee_signing_address: execution.tee_signing_address,
    request_sha256: execution.request_sha256,
    response_sha256: execution.response_sha256,
    tee_signature: execution.tee_signature,
    timestamp_ns: execution.timestamp_ns,
  };
}

function errorResponse(error: unknown) {
  if (error instanceof AgentOperationError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, preview: error.preview ?? null } },
      { status: error.status },
    );
  }
  const message = error instanceof Error ? error.message : "Unexpected error.";
  return NextResponse.json({ error: { code: "internal_error", message } }, { status: 500 });
}

function labelNetwork<T extends { network: string; contract_id: string; confidential_contract_id: string }>(network: T): T {
  if (publicNetwork() === "mainnet") return network;
  return {
    ...network,
    network: "demo (testnet)",
    contract_id: "demo (testnet)",
    confidential_contract_id: "demo (testnet)",
  };
}

function unlockAdmin(request: Request, payload: Record<string, unknown>) {
  const ip = clientIp(request);
  if (!allowAdminAttempt(ip)) {
    return NextResponse.json({ error: { code: "admin_rate_limited", message: "Too many tries. Wait a minute." } }, { status: 429 });
  }
  const code = typeof payload.code === "string" ? payload.code : "";
  const expected = process.env.KOTHA_ADMIN_CODE || "";
  const verdict = checkAdminCode(code, expected);
  if (verdict === "missing") {
    return NextResponse.json({ error: { code: "admin_unconfigured", message: "Admin mode is not configured." } }, { status: 503 });
  }
  if (verdict !== "ok") {
    return NextResponse.json({ error: { code: "admin_rejected", message: "That code was not accepted." } }, { status: 401 });
  }
  const token = signAdminSession(Date.now(), expected);
  if (!token) {
    return NextResponse.json({ error: { code: "admin_unconfigured", message: "Admin mode is not configured." } }, { status: 503 });
  }
  const response = NextResponse.json({ type: "admin_unlock", admin: true });
  response.cookies.set(adminCookieInit(token));
  return response;
}

function lockAdmin() {
  const response = NextResponse.json({ type: "admin_lock", admin: false });
  response.cookies.set(adminCookieInit("", true));
  return response;
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (forwarded || request.headers.get("x-real-ip") || "local").slice(0, 80);
}

function serverSignerAccount(): string {
  return (
    process.env.NEAR_ACCOUNT_ID?.trim() ||
    process.env.NEXT_PUBLIC_CONTRACT_ID?.trim() ||
    process.env.NEXT_PUBLIC_NEAR_CONTRACT_ID?.trim() ||
    DEFAULT_CONTRACT_ID
  );
}

function proofAccountId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const accountId = (value as { accountId?: unknown }).accountId;
  return typeof accountId === "string" ? accountId.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function asIntent(value: unknown): AegisIntent | null {
  const record = asRecord(value);
  if (!record || typeof record.action !== "string" || typeof record.origin_asset !== "string") return null;
  return {
    action: record.action as AegisIntent["action"],
    origin_asset: String(record.origin_asset),
    destination_asset: String(record.destination_asset || record.origin_asset),
    amount: String(record.amount ?? ""),
    amount_usd_estimate: typeof record.amount_usd_estimate === "number" ? record.amount_usd_estimate : 0,
    max_slippage_bps: typeof record.max_slippage_bps === "number" ? record.max_slippage_bps : 0,
    recipient: String(record.recipient ?? ""),
    chain: String(record.chain ?? "near"),
    confidential: Boolean(record.confidential),
  };
}

function isAction(value: unknown): value is IntentRouteAction {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}
