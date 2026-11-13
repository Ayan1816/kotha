import assert from "node:assert/strict";
import test from "node:test";
import { translate } from "../components/aegis/copy";
import { isNativeNearTransfer } from "../components/aegis/format";
import type { AegisIntent } from "./dashboard-types";
import { humanToAtomic } from "./intents-agent";
import {
  NATIVE_GAS_BUFFER_YOCTO,
  accountMissingError,
  buildNativeTransferBatch,
  classifyWalletError,
  executionFailed,
  localTransferProof,
  nativeExecuteBlock,
  nearToYoctoString,
  notionalCents,
  proofMeetsContract,
  senderCovers,
  unsupportedBatchError,
  type WalletExecution,
} from "./native-transfer";
import { explorerTxUrl, walletRecordCall, type FrozenChainReceipt } from "./wallet-proof";

const NEAR = "nep141:wrap.near";

function intent(partial: Partial<AegisIntent> & Pick<AegisIntent, "action" | "recipient">): AegisIntent {
  return {
    origin_asset: NEAR,
    destination_asset: NEAR,
    amount: "0.1",
    amount_usd_estimate: 0.342,
    max_slippage_bps: 0,
    chain: "near",
    confidential: false,
    ...partial,
  };
}

test("nearToYoctoString uses exact integer yocto and rejects bad amounts", () => {
  assert.equal(nearToYoctoString("0.1"), "100000000000000000000000");
  assert.equal(nearToYoctoString("0.1"), (10n ** 23n).toString());
  assert.equal(nearToYoctoString("1"), (10n ** 24n).toString());
  assert.equal(nearToYoctoString("0.1"), humanToAtomic("0.1", 24).toString());
  assert.equal(nearToYoctoString("1"), humanToAtomic("1", 24).toString());
  assert.throws(() => nearToYoctoString(""), /invalid_amount/);
  assert.throws(() => nearToYoctoString("0"), /invalid_amount/);
  assert.throws(() => nearToYoctoString("-5"), /invalid_amount/);
  assert.throws(() => nearToYoctoString(`1.${"1".repeat(25)}`), /invalid_amount/);
  assert.notEqual(humanToAtomic(`1.${"1".repeat(25)}`, 24).toString(), nearToYoctoString("1"));
});

test("native NEAR transfers are the only executable cards", () => {
  const send = intent({ action: "transfer", recipient: "alice.testnet" });
  assert.equal(isNativeNearTransfer(send), true);
  assert.equal(nativeExecuteBlock(send), null);
  assert.equal(nativeExecuteBlock(intent({ action: "transfer", recipient: "+14155550199" })), "executePhoneRecipient");
  assert.equal(nativeExecuteBlock(intent({ action: "transfer", recipient: `0x${"ab".repeat(20)}` })), "executeInvalidRecipient");
  assert.equal(nativeExecuteBlock(intent({ action: "swap", recipient: "alice.testnet" })), "executeNativeOnly");
  assert.equal(nativeExecuteBlock(intent({ action: "shield", recipient: "intents.far" })), "executeNativeOnly");
  assert.equal(isNativeNearTransfer(intent({ action: "transfer", recipient: "+14155550199" })), false);
  assert.equal(isNativeNearTransfer(intent({ action: "withdraw", recipient: "alice.testnet" })), false);
});

test("the wallet batch sends NEAR and records a numeric proof with zero deposit", () => {
  const yocto = nearToYoctoString("0.1");
  const execution: WalletExecution = {
    correlation_id: "nt-1",
    agent_id: "mohin12.testnet",
    action_type: "transfer",
    origin_asset: NEAR,
    destination_asset: NEAR,
    amount_atomic: yocto,
    usd_amount_cents: notionalCents(0.342),
    near_ai_chat_id: "local-preview",
    tee_signing_address: "local-preview",
    request_sha256: "ab".repeat(32),
    response_sha256: "cd".repeat(32),
    tee_signature: "ef".repeat(32),
    timestamp_ns: 1_700_000_000_000_000_000,
  };
  const batch = buildNativeTransferBatch("alice.testnet", yocto, "kotha-vault-1793945609.testnet", execution);
  const transfer = batch.transactions[0].actions[0];
  const proof = batch.transactions[1].actions[0];
  assert.equal(transfer.type, "Transfer");
  assert.equal(transfer.params.deposit, yocto);
  assert.equal(proof.params.methodName, "record_execution");
  assert.equal(proof.params.deposit, "0");
  assert.equal(proof.params.gas, "100000000000000");
  assert.equal(typeof proof.params.args.execution.usd_amount_cents, "number");
  assert.equal(proof.params.args.execution.usd_amount_cents, 34);
  assert.equal(typeof proof.params.args.execution.timestamp_ns, "number");
  assert.equal(JSON.stringify(proof.params.args.execution.usd_amount_cents).includes('"'), false);
  const receipt: FrozenChainReceipt = {
    correlation_id: "kotha-1",
    agent_id: "kotha-vault-1793945609.testnet",
    action: "transfer",
    origin_asset: NEAR,
    destination_asset: NEAR,
    amount_atomic: yocto,
    usd_amount_cents: "34",
    chat_id: "local-preview",
    signing_address: "local-preview",
    intent_hash: "ab".repeat(32),
    signature: "ef".repeat(32),
    timestamp_ns: "1700000000000000000",
  };
  const call = walletRecordCall("kotha-vault-1793945609.testnet", receipt, "cd".repeat(32));
  assert.equal(call.method, "record_execution");
  assert.equal(call.deposit, "0");
  assert.equal(call.gas, "100000000000000");
  assert.equal(typeof call.args.execution.usd_amount_cents, "number");
  assert.equal(typeof call.args.execution.timestamp_ns, "number");
});

test("local preview proof fields satisfy the vault checks", async () => {
  const empty = await localTransferProof({ signature: "", chatId: "", signing_address: "" });
  assert.equal(proofMeetsContract(empty), true);
  assert.equal(empty.near_ai_chat_id, "local-preview");
  assert.equal(empty.tee_signing_address, "local-preview");
  assert.equal(empty.tee_signature.length >= 64, true);
  const hash = "ab".repeat(32);
  const reused = await localTransferProof({
    requestSha256: hash.toUpperCase(),
    responseSha256: hash,
    signature: "c".repeat(64),
    chatId: "chat-1",
    signing_address: "signer",
  });
  assert.equal(reused.request_sha256, hash);
  assert.equal(reused.response_sha256, hash);
  assert.equal(reused.tee_signature, "c".repeat(64));
  assert.equal(reused.near_ai_chat_id, "chat-1");
});

test("explorer links stay on testnet nearblocks", () => {
  assert.equal(explorerTxUrl("abc123", "testnet"), "https://testnet.nearblocks.io/txns/abc123");
});

test("wallet errors classify as rejected, insufficient, or a fallback", () => {
  assert.equal(classifyWalletError(new Error("User rejected the transaction")), "rejected");
  assert.equal(classifyWalletError(new Error("The request was cancelled")), "rejected");
  assert.equal(classifyWalletError(new Error("Account bob.testnet does not have enough balance")), "insufficient");
  assert.equal(classifyWalletError(new Error("PROHORI_UNAUTHORIZED")), "unauthorized");
  assert.equal(classifyWalletError(new Error("The RPC timed out")), "other");
  assert.equal(accountMissingError(new Error("Account alice.testnet doesn't exist")), true);
  assert.equal(accountMissingError(new Error("The RPC timed out")), false);
  assert.equal(unsupportedBatchError(new Error("signAndSendTransactions is not supported")), true);
  assert.equal(unsupportedBatchError(new Error("User rejected")), false);
  assert.equal(executionFailed({ status: "Failure" }), true);
  assert.equal(executionFailed({ status: { Failure: { error_message: "fail", error_type: "ActionError" } } }), true);
  assert.equal(executionFailed({ status: { SuccessValue: "" } }), false);
  assert.equal(executionFailed(null), false);
  assert.equal(senderCovers(NATIVE_GAS_BUFFER_YOCTO + 10n ** 23n, (10n ** 23n).toString()), true);
  assert.equal(senderCovers(10n ** 23n, (10n ** 23n).toString()), false);
});

test("new execute copy exists in English and Bengali", () => {
  const keys = [
    "executeNativeOnly",
    "executePhoneRecipient",
    "executeInvalidRecipient",
    "executeAccountMissing",
    "executeRejected",
    "executeSent",
    "executeProofMissing",
    "executeFailed",
    "executeCheckFailed",
    "executeProofLink",
  ] as const;
  assert.equal(translate("en", "executeNativeOnly"), "Execute sends native NEAR only. Swaps are not broadcast from this button.");
  assert.equal(translate("en", "executePhoneRecipient"), "This recipient is a phone number, not a NEAR account.");
  assert.match(translate("en", "executedNotice"), /NEAR was sent/);
  for (const key of keys) {
    assert.notEqual(translate("en", key), "");
    assert.notEqual(translate("bn", key), "");
    assert.notEqual(translate("bn", key), translate("en", key));
  }
});
