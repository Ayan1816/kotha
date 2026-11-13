import type { AegisIntent, VerifiedExecution } from "./dashboard-types";
import { findExecution, type VerifiedExecution as VaultExecution } from "./near-vault-rpc";
import { chainSignerConfigured, recordExecutionArgs, submitRecordExecution } from "./near-function-call";
import {
  buildFrozenReceipt,
  canonicalJson,
  centsToUsd,
  intentDocument,
  parseFrozenReceipt,
  sha256Hex,
  type ReceiptBody,
} from "./receipt-canonical";
import { getReceipt, listReceiptRecords, putReceipt, setReceiptStatus, type ReceiptRecord } from "./receipt-store";
import { readTxLinks } from "./tx-link-store";

type IntentView = {
  action: string;
  amount: string;
  origin_asset: string;
  destination_asset: string;
  recipient: string;
  confidential: string;
};

export async function anchorExecutionReceipt(
  execution: {
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
  },
  intent: AegisIntent | null,
  options?: { skipChain?: boolean; signerAccountId?: string },
): Promise<{ receiptHash: string; txHash: string | null; chainError: string | null }> {
  const body = await receiptBodyFromExecution(execution, intentView(intent, execution), options?.signerAccountId);
  const frozen = await buildFrozenReceipt(body);
  const saved = await putReceipt(execution.correlation_id, { bytes: frozen.bytes, tx_hash: null, chain_error: null });
  const storedHash = parseFrozenReceipt(saved.bytes)?.receipt_hash || frozen.receipt_hash;
  if (saved.tx_hash) return { receiptHash: storedHash, txHash: saved.tx_hash, chainError: null };
  if (options?.skipChain) return { receiptHash: storedHash, txHash: null, chainError: null };
  if (!chainSignerConfigured()) {
    const chainError = "NEAR_ACCOUNT_ID or NEAR_PRIVATE_KEY is not set.";
    await setReceiptStatus(execution.correlation_id, { tx_hash: null, chain_error: chainError });
    return { receiptHash: storedHash, txHash: null, chainError };
  }
  try {
    const parsed = parseFrozenReceipt(saved.bytes);
    if (!parsed) throw new Error("Stored receipt could not be read.");
    const args = recordExecutionArgs({
      correlation_id: parsed.receipt.correlation_id,
      agent_id: parsed.receipt.agent_id,
      action: parsed.receipt.action,
      origin_asset: parsed.receipt.origin_asset,
      destination_asset: parsed.receipt.destination_asset,
      amount_atomic: parsed.receipt.amount_atomic,
      usd_amount_cents: parsed.receipt.usd_amount_cents,
      chat_id: parsed.receipt.chat_id,
      signing_address: parsed.receipt.signing_address,
      intent_hash: parsed.receipt.intent_hash,
      receipt_hash: parsed.receipt_hash,
      signature: parsed.receipt.signature,
      timestamp_ns: parsed.receipt.timestamp_ns,
    });
    const submitted = await submitRecordExecution(args);
    await setReceiptStatus(execution.correlation_id, { tx_hash: submitted.txHash, chain_error: null });
    return { receiptHash: storedHash, txHash: submitted.txHash, chainError: null };
  } catch (error) {
    const chainError = error instanceof Error ? error.message : "record_execution failed.";
    await setReceiptStatus(execution.correlation_id, { tx_hash: null, chain_error: chainError });
    return { receiptHash: storedHash, txHash: null, chainError };
  }
}

export async function saveReceiptTxHash(id: string, txHash: string): Promise<boolean> {
  const existing = await getReceipt(id);
  if (!existing) return false;
  await setReceiptStatus(id, { tx_hash: txHash, chain_error: null });
  return true;
}

export async function receiptBytesForDownload(id: string): Promise<string | null> {
  const existing = await getReceipt(id);
  if (existing) return existing.bytes;
  const row = await findExecution(id);
  if (!row) return null;
  const frozen = await freezeRow(row);
  return frozen.bytes;
}

export async function overlayReceiptRows(rows: VaultExecution[]): Promise<VerifiedExecution[]> {
  const records = await listReceiptRecords();
  const links = readTxLinks();
  return rows.map((row) => {
    const record = records[row.correlation_id];
    const link = links[row.correlation_id];
    const txHash = link?.transferHash || record?.tx_hash || undefined;
    const proofHash = link?.proofHash || undefined;
    const parsed = record ? parseFrozenReceipt(record.bytes) : null;
    if (!parsed) {
      return { ...row, tx_hash: txHash, proof_tx_hash: proofHash, receipt_hash: undefined };
    }
    return {
      ...row,
      near_ai_chat_id: parsed.receipt.chat_id,
      tee_signing_address: parsed.receipt.signing_address,
      tee_signature: parsed.receipt.signature,
      timestamp_ns: parsed.receipt.timestamp_ns,
      request_sha256: parsed.receipt.request_sha256,
      response_sha256: parsed.receipt.response_sha256,
      tx_hash: txHash,
      proof_tx_hash: proofHash,
      receipt_hash: parsed.receipt_hash,
    };
  });
}

async function freezeRow(row: VaultExecution): Promise<ReceiptRecord> {
  const body = await receiptBodyFromExecution(row, {
    action: row.action_type,
    amount: row.amount_atomic,
    origin_asset: row.origin_asset,
    destination_asset: row.destination_asset,
    recipient: "",
    confidential: "false",
  });
  const frozen = await buildFrozenReceipt(body);
  return putReceipt(row.correlation_id, { bytes: frozen.bytes, tx_hash: null, chain_error: null });
}

async function receiptBodyFromExecution(
  execution: {
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
  },
  intent: IntentView,
  signerAccountId = "",
): Promise<ReceiptBody> {
  const intent_hash = await sha256Hex(canonicalJson(intentDocument(intent)));
  const body: ReceiptBody = {
    action: execution.action_type,
    agent_id: execution.agent_id,
    amount_atomic: execution.amount_atomic,
    amount_usd: centsToUsd(execution.usd_amount_cents),
    chat_id: execution.near_ai_chat_id,
    correlation_id: execution.correlation_id,
    destination_asset: execution.destination_asset,
    intent_hash,
    origin_asset: execution.origin_asset,
    request_sha256: execution.request_sha256,
    response_sha256: execution.response_sha256,
    signature: execution.tee_signature,
    signing_address: execution.tee_signing_address,
    timestamp_ns: execution.timestamp_ns,
    usd_amount_cents: execution.usd_amount_cents,
  };
  const signer = signerAccountId.trim();
  if (signer) body.signer_account_id = signer;
  return body;
}

function intentView(
  intent: AegisIntent | null,
  execution: { action_type: string; origin_asset: string; destination_asset: string; amount_atomic: string },
): IntentView {
  return {
    action: intent?.action || execution.action_type,
    amount: intent?.amount || execution.amount_atomic,
    origin_asset: intent?.origin_asset || execution.origin_asset,
    destination_asset: intent?.destination_asset || execution.destination_asset,
    recipient: intent?.recipient || "",
    confidential: intent?.confidential ? "true" : "false",
  };
}
