import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { translate } from "../components/aegis/copy";
import {
  PROOF_MAX_AGE_MS,
  PROOF_FUTURE_SKEW_MS,
  RECORD_DEPOSIT,
  RECORD_GAS,
  assessProof,
  buildProofMessage,
  chainMatches,
  connectedMayAct,
  coerceNetwork,
  decodeBase64,
  displayNetworkName,
  encodeBase64,
  executionViewCall,
  explorerTxUrl,
  findAccessKey,
  isInsufficientBalance,
  isOwnerSigned,
  ownerActionsOpen,
  parseFrozenReceiptJson,
  requiresOwnerProof,
  TESTNET_FAUCET_URL,
  walletProofAttached,
  txHashFromOutcome,
  walletRecordCall,
  type FrozenChainReceipt,
} from "./wallet-proof";

const HASH = "ab".repeat(32);
const receipt: FrozenChainReceipt = {
  correlation_id: "kotha-1",
  agent_id: "kotha-vault-1793945609.testnet",
  action: "swap",
  origin_asset: "nep141:wrap.near",
  destination_asset: "nep141:usdt.tether-token.near",
  amount_atomic: "1",
  usd_amount_cents: "1500",
  chat_id: "chat-1",
  signing_address: "0xabc",
  intent_hash: HASH,
  signature: "cd".repeat(40),
  timestamp_ns: "1700000000000000000",
};

describe("wallet proof helpers", () => {
  it("keeps testnet as the only network unless the env is exactly mainnet", () => {
    assert.equal(coerceNetwork(undefined), "testnet");
    assert.equal(coerceNetwork("testnet"), "testnet");
    assert.equal(coerceNetwork("foo"), "testnet");
    assert.equal(coerceNetwork("mainnet"), "mainnet");
  });

  it("never returns the word mainnet while the public network is testnet", () => {
    for (const reported of ["mainnet", "MAINNET", "testnet", "", null]) {
      const shown = displayNetworkName(reported, "testnet");
      assert.equal(shown.includes("mainnet"), false);
      assert.equal(shown, "testnet");
    }
  });

  it("links testnet transactions on testnet.nearblocks.io", () => {
    const url = explorerTxUrl("4tgG9r1t3o8v8vYQq6oS7m1oYw2mQh3oP", "testnet");
    assert.equal(url.startsWith("https://testnet.nearblocks.io/txns/"), true);
    assert.equal(url.includes("mainnet"), false);
  });

  it("fails closed when the owner id is empty", () => {
    assert.equal(isOwnerSigned("kotha-vault-1793945609.testnet", ""), false);
    assert.equal(isOwnerSigned("", ""), false);
    assert.equal(isOwnerSigned("kotha-vault-1793945609.testnet", "kotha-vault-1793945609.testnet"), true);
    assert.equal(isOwnerSigned("other.testnet", "kotha-vault-1793945609.testnet"), false);
    const previous = process.env.NEXT_PUBLIC_STRICT_OWNER;
    process.env.NEXT_PUBLIC_STRICT_OWNER = "true";
    assert.equal(connectedMayAct("mohina.near", "kotha-vault-1793945609.testnet"), false);
    assert.equal(connectedMayAct("kotha-vault-1793945609.testnet", "kotha-vault-1793945609.testnet"), true);
    process.env.NEXT_PUBLIC_STRICT_OWNER = "false";
    assert.equal(connectedMayAct("mohina.near", "kotha-vault-1793945609.testnet"), true);
    assert.equal(connectedMayAct("  ", "kotha-vault-1793945609.testnet"), false);
    if (previous == null) delete process.env.NEXT_PUBLIC_STRICT_OWNER;
    else process.env.NEXT_PUBLIC_STRICT_OWNER = previous;
  });

  it("opens a session for another wallet only when the owner is unlocked or the toggle is on", () => {
    const owner = "kotha-vault-1793945609.testnet";
    assert.equal(ownerActionsOpen("mohina.near", { sessionOwnerOptIn: false, ownerId: "" }), true);
    assert.equal(ownerActionsOpen("mohina.near", { sessionOwnerOptIn: false, ownerId: owner }), false);
    assert.equal(ownerActionsOpen("mohina.near", { sessionOwnerOptIn: true, ownerId: owner }), true);
    assert.equal(ownerActionsOpen("demo-owner.testnet", { sessionOwnerOptIn: false, ownerId: owner }), true);
    assert.equal(ownerActionsOpen("", { sessionOwnerOptIn: true, ownerId: "" }), false);
    assert.equal(isOwnerSigned("mohina.near", owner), false);
    assert.equal(buildProofMessage("execute", { a: 1 }, 5), JSON.stringify({ action: "execute", payload: { a: 1 }, ts: 5 }));
    const flagged = buildProofMessage("execute", { a: 1 }, 5, true);
    assert.equal(JSON.parse(flagged).sessionOwner, true);
    assert.equal(assessProof(flagged, "execute", { a: 1 }, 5).ok, true);
  });

  it("requires a wallet proof for owner actions and not for dry-run", () => {
    assert.equal(requiresOwnerProof("dry_run"), false);
    for (const action of ["execute", "update_policy", "rotate_grant", "revoke_grant", "emergency_freeze", "save_tx"]) {
      assert.equal(requiresOwnerProof(action), true);
    }
    assert.equal(walletProofAttached(null), false);
    assert.equal(walletProofAttached(undefined), false);
    assert.equal(walletProofAttached({ accountId: "mohina.near" }), true);
  });

  it("rejects a stale timestamp, future skew, and a mismatched action or payload", () => {
    const now = 1_700_000_000_000;
    const payload = { policy: { dailyBudgetUsd: 10 } };
    const fresh = buildProofMessage("update_policy", payload, now);
    assert.equal(assessProof(fresh, "update_policy", payload, now).ok, true);
    assert.equal(assessProof(fresh, "update_policy", { dailyBudgetUsd: 10, policy: undefined }, now).ok, false);
    const reordered = buildProofMessage("update_policy", { dailyBudgetUsd: 10, note: "a" }, now);
    assert.equal(assessProof(reordered, "update_policy", { note: "a", dailyBudgetUsd: 10 }, now).ok, true);
    const stale = buildProofMessage("update_policy", payload, now - PROOF_MAX_AGE_MS - 1);
    const staleResult = assessProof(stale, "update_policy", payload, now);
    assert.equal(staleResult.ok, false);
    if (!staleResult.ok) assert.equal(staleResult.code, "proof_expired");
    const edge = buildProofMessage("update_policy", payload, now - PROOF_MAX_AGE_MS);
    assert.equal(assessProof(edge, "update_policy", payload, now).ok, true);
    const future = buildProofMessage("update_policy", payload, now + PROOF_FUTURE_SKEW_MS + 1);
    const futureResult = assessProof(future, "update_policy", payload, now);
    assert.equal(futureResult.ok, false);
    if (!futureResult.ok) assert.equal(futureResult.code, "proof_expired");
    const wrongAction = assessProof(fresh, "execute", payload, now);
    assert.equal(wrongAction.ok, false);
    if (!wrongAction.ok) assert.equal(wrongAction.code, "proof_invalid");
  });

  it("round-trips a 32-byte nonce and finds a listed public key", () => {
    const nonce = new Uint8Array(32);
    nonce[0] = 9;
    nonce[31] = 4;
    const decoded = decodeBase64(encodeBase64(nonce));
    assert.deepEqual(decoded, nonce);
    assert.equal(decodeBase64(encodeBase64(new Uint8Array(31)))?.length, 31);
    assert.equal(findAccessKey([{ public_key: "ed25519:abc" }], "ed25519:abc")?.public_key, "ed25519:abc");
    assert.equal(findAccessKey([{ public_key: "ed25519:abc" }], "ed25519:nope"), null);
  });

  it("maps the receipt hash into VerifiedExecution and reads it back by correlation id", () => {
    const call = walletRecordCall("kotha-vault-1793945609.testnet", receipt, HASH);
    assert.equal(call.method, "record_execution");
    assert.equal(call.gas, RECORD_GAS);
    assert.equal(call.deposit, RECORD_DEPOSIT);
    assert.equal(call.gas, "100000000000000");
    assert.equal(call.deposit, "0");
    assert.equal(Object.hasOwn(call.args, "receipt_hash"), false);
    assert.equal(call.args.execution.response_sha256, HASH);
    assert.equal(call.args.execution.request_sha256, receipt.intent_hash);
    assert.equal(call.args.execution.usd_amount_cents, 1500);
    assert.equal(typeof call.args.execution.usd_amount_cents, "number");
    assert.equal(typeof call.args.execution.timestamp_ns, "number");
    assert.match(JSON.stringify(call.args.execution.timestamp_ns), /^\d+$/);
    assert.match(JSON.stringify(call.args.execution.usd_amount_cents), /^\d+$/);
    const view = executionViewCall(call.contractId, receipt.correlation_id);
    assert.equal(view.method, "get_execution");
    assert.deepEqual(view.args, { correlation_id: "kotha-1" });
    assert.equal(Object.hasOwn(view.args, "receipt_hash"), false);
  });

  it("matches the chain only when response_sha256 equals the receipt hash", () => {
    assert.equal(chainMatches({ response_sha256: HASH }, HASH), true);
    assert.equal(chainMatches({ response_sha256: HASH.toUpperCase() }, HASH), true);
    assert.equal(chainMatches({ execution: { response_sha256: HASH } }, HASH), true);
    assert.equal(chainMatches({ response_sha256: "ff".repeat(32) }, HASH), false);
    assert.equal(chainMatches(null, HASH), false);
    assert.equal(chainMatches({ receipt_hash: HASH }, HASH), true);
  });

  it("reads a transaction hash from the wallet outcome and ignores a missing one", () => {
    assert.equal(txHashFromOutcome({ transaction: { hash: "4tgG9r1t3o8v8vYQq6oS7m1oYw2mQh3oP" } }), "4tgG9r1t3o8v8vYQq6oS7m1oYw2mQh3oP");
    assert.equal(txHashFromOutcome({ transaction_outcome: { id: "4tgG9r1t3o8v8vYQq6oS7m1oYw2mQh3oP" } }), "4tgG9r1t3o8v8vYQq6oS7m1oYw2mQh3oP");
    assert.equal(txHashFromOutcome({}), null);
    assert.equal(txHashFromOutcome({ transaction: { hash: "not a hash" } }), null);
  });

  it("parses a frozen receipt for the wallet call", () => {
    const text = JSON.stringify({ receipt, receipt_hash: HASH });
    const parsed = parseFrozenReceiptJson(text);
    assert.equal(parsed?.receipt_hash, HASH);
    assert.equal(parsed?.receipt.timestamp_ns, receipt.timestamp_ns);
    assert.equal(parseFrozenReceiptJson("{"), null);
  });

  it("keeps the Bangla wallet labels in both languages", () => {
    assert.equal(translate("en", "connectWallet"), "Connect Wallet");
    assert.equal(translate("bn", "connectWallet"), "ওয়ালেট যুক্ত করুন");
    assert.equal(translate("en", "disconnectWallet"), "Disconnect");
    assert.equal(translate("bn", "disconnectWallet"), "ওয়ালেট বিচ্ছিন্ন করুন");
    assert.equal(translate("en", "connectOwner"), "Connect the owner wallet");
    assert.equal(translate("bn", "connectOwner"), "মালিকের ওয়ালেট যুক্ত করুন");
    assert.equal(translate("en", "grantLocked"), "Connect the owner wallet or unlock Admin mode");
    assert.equal(isInsufficientBalance("Account bob.testnet does not have enough balance for the transaction"), true);
    assert.equal(isInsufficientBalance("Insufficient balance."), true);
    assert.equal(isInsufficientBalance("The RPC timed out"), false);
    assert.equal(TESTNET_FAUCET_URL, "https://docs.near.org/getting-started/faucet");
    assert.equal(translate("en", "faucetLink"), "Get free testnet NEAR");
    assert.equal(translate("bn", "grantTitle"), "সক্রিয় সেশন গ্রান্ট");
    assert.equal(translate("en", "walletLoading"), "Loading...");
    assert.equal(translate("en", "chainMatch"), "Matches chain");
    assert.equal(translate("en", "chainMismatch"), "Mismatch");
    assert.equal(translate("en", "testnetBadge"), "TESTNET");
    assert.equal(translate("en", "testnetDemo"), "Testnet Demo");
  });
});
