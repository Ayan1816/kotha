import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProofsTable } from "../components/aegis/audit-panel";
import { translate } from "../components/aegis/copy";
import { actionCopyKey, amountSummary, formatTimestamp } from "../components/aegis/format";
import { chainSpentTodayUsd, isSampleExecution } from "./budget-math";
import { compareChainToReceipt } from "./chain-verify";
import type { VerifiedExecution } from "./dashboard-types";
import { isLocalChatPreview } from "./local-command";
import { describeExecuteOutcome, executeAdmission, nativeExecuteBlock } from "./native-transfer";
import { extractNearAccounts, isNearAccountId } from "./near-account";
import { humanizeVisibleCodes } from "./policy-codes";
import { messageTransferTarget } from "./transfer-parse";

const RESPONSE = "19f938442d057546635ab5d4b2e435a91e6037fc1ab1917dc74a732abffa01e0";
const RECEIPT_HASH = "70d3614c7d66465c7f8b7689719b0e7a2e2a511152cae941a13e337f6da68ccf";
const REQUEST = "ab".repeat(32);

test("chain verify compares receipt fields and ignores receipt_hash", () => {
  const chain = {
    response_sha256: RESPONSE,
    request_sha256: REQUEST,
    action_type: "transfer",
    usd_amount_cents: 34,
    amount_atomic: "100000000000000000000000",
    near_ai_chat_id: "local-preview",
    agent_id: "mohin12.testnet",
  };
  const receipt = {
    receipt: {
      response_sha256: RESPONSE,
      request_sha256: REQUEST,
      action: "transfer",
      usd_amount_cents: "34",
      amount_atomic: "100000000000000000000000",
      chat_id: "local-preview",
      agent_id: "mohin12.testnet",
      intent_hash: "ff".repeat(32),
    },
    receipt_hash: RECEIPT_HASH,
  };
  assert.notEqual(RESPONSE, RECEIPT_HASH);
  assert.deepEqual(compareChainToReceipt(chain, receipt), { status: "match", code: "match" });
  assert.equal(compareChainToReceipt({ ...chain, response_sha256: "00".repeat(32) }, receipt).status, "mismatch");
  assert.equal(compareChainToReceipt(null, receipt).status, "missing");
  assert.equal(compareChainToReceipt({ raw: null }, receipt).code, "missing");
});

test("native transfer rows show NEAR and a translated action", () => {
  const transfer: VerifiedExecution = {
    correlation_id: "nt-real",
    agent_id: "mohin12.testnet",
    action_type: "transfer",
    origin_asset: "nep141:wrap.near",
    destination_asset: "nep141:wrap.near",
    amount_atomic: "100000000000000000000000",
    usd_amount_cents: "34",
    near_ai_chat_id: "local-preview",
    tee_signing_address: "0xabc",
    request_sha256: "c1".repeat(32),
    response_sha256: "d2".repeat(32),
    tee_signature: "sig",
    timestamp_ns: "1000",
  };
  assert.equal(amountSummary(transfer), "0.1 NEAR");
  assert.equal(translate("bn", actionCopyKey("transfer")), "ট্রান্সফার");
  assert.equal(translate("en", actionCopyKey("swap")), "Swap");
  const swap = { ...transfer, action_type: "swap", destination_asset: "nep141:usdt.tether-token.near" };
  assert.match(amountSummary(swap), /wNEAR/);
});

test("sample rows stay out of Proofs and a bad timestamp renders as a dash", () => {
  assert.equal(formatTimestamp("1000", "en"), "—");
  assert.equal(formatTimestamp("1000", "bn"), "—");
  assert.equal(isSampleExecution({ correlation_id: "kotha-ci-42174253364-1" }), true);
  assert.equal(isSampleExecution({ correlation_id: "aegis-corr-1" }), true);
  assert.equal(isSampleExecution({ correlation_id: "nt-real", request_sha256: "a".repeat(64) }), true);
  const real: VerifiedExecution = {
    correlation_id: "nt-real",
    agent_id: "mohin12.testnet",
    action_type: "transfer",
    origin_asset: "nep141:wrap.near",
    destination_asset: "nep141:wrap.near",
    amount_atomic: "100000000000000000000000",
    usd_amount_cents: "34",
    near_ai_chat_id: "local-preview",
    tee_signing_address: "0xabc",
    request_sha256: "c1".repeat(32),
    response_sha256: "d2".repeat(32),
    tee_signature: "sig",
    timestamp_ns: "1000",
  };
  const sample: VerifiedExecution = { ...real, correlation_id: "kotha-ci-42174253364-1" };
  const html = renderToStaticMarkup(
    createElement(ProofsTable, {
      lang: "bn",
      executions: [sample, real],
      contractId: "kotha.testnet",
      highlight: null,
      onVerifyChain: async () => ({ status: "match", code: "match" }) as const,
    }),
  );
  assert.equal(html.includes("kotha-ci-42174253364-1"), false);
  assert.match(html, /ট্রান্সফার/);
  assert.match(html, /0\.1 NEAR/);
  assert.match(html, /—/);
  assert.equal(html.includes("০১ জানু"), false);
});

test("spent today sums today's chain cents and ignores the epoch row", () => {
  const todayNs = `${BigInt(Date.now()) * 1_000_000n}`;
  const spent = chainSpentTodayUsd([
    { correlation_id: "a", timestamp_ns: todayNs, usd_amount_cents: "34" },
    { correlation_id: "b", timestamp_ns: todayNs, usd_amount_cents: 34 },
    { correlation_id: "kotha-ci-42174253364-1", timestamp_ns: "1000", usd_amount_cents: "9999" },
    { correlation_id: "old-real", timestamp_ns: "1000", usd_amount_cents: "5000", request_sha256: "c1".repeat(32), response_sha256: "d2".repeat(32) },
  ]);
  assert.equal(spent, 0.68);
});

test("an in-flight or already executed card cannot start another execute", () => {
  assert.equal(executeAdmission({ inFlight: true, alreadyExecuted: false }), "busy");
  assert.equal(executeAdmission({ inFlight: false, alreadyExecuted: true }), "sent");
  assert.equal(executeAdmission({ inFlight: true, alreadyExecuted: true }), "busy");
  assert.equal(executeAdmission({ inFlight: false, alreadyExecuted: false }), "start");
});

test("visible text replaces PROHORI and PRV_KEY codes", () => {
  const english = humanizeVisibleCodes("en", "Blocked: PROHORI_PER_TX_LIMIT_EXCEEDED and PRV_KEY_TX_LIMIT_EXCEEDED and PRIVATE_KEY_DAILY_BUDGET_EXCEEDED.");
  assert.equal(/PROHORI_|PRV_KEY_|PRIVATE_KEY_/.test(english), false);
  assert.match(english, /per-transaction cap/);
  assert.match(english, /daily budget/);
  const bangla = humanizeVisibleCodes("bn", "PROHORI_DAILY_BUDGET_EXCEEDED");
  assert.match(bangla, /দৈনিক বাজেট/);
  assert.equal(bangla.includes("PROHORI_"), false);
});

test("a Bengali locative still previews a transfer to alice.testnet", () => {
  const suffixed = "alice.testnet-এ ০.১ NEAR পাঠাও";
  const spaced = "alice.testnet এ ০.১ NEAR পাঠাও";
  assert.deepEqual(extractNearAccounts(suffixed), ["alice.testnet"]);
  assert.deepEqual(extractNearAccounts(spaced), ["alice.testnet"]);
  assert.equal(messageTransferTarget(suffixed).account, "alice.testnet");
  assert.equal(messageTransferTarget(spaced).account, "alice.testnet");
  assert.equal(isLocalChatPreview(suffixed), true);
  assert.equal(isLocalChatPreview(spaced), true);
  assert.equal(isNearAccountId("alice.testnet-এ"), false);
  assert.equal(isNearAccountId("alice.testnet"), true);
  assert.deepEqual(extractNearAccounts("pay alice.testnet-extra now"), []);
  assert.equal(
    nativeExecuteBlock({
      action: "transfer",
      origin_asset: "nep141:wrap.near",
      destination_asset: "nep141:wrap.near",
      recipient: "alice.testnet-এ",
    }),
    "executeInvalidRecipient",
  );
});

test("the Bengali success sentence uses the Bengali execute copy", () => {
  const text = describeExecuteOutcome("bn", {
    tone: "ok",
    amount: "0.1",
    recipient: "alice.testnet",
    proofMissing: false,
  });
  assert.match(text, /পাঠানো হয়েছে/);
  assert.equal(text.startsWith("Sent"), false);
  assert.equal(/\bSent\b/.test(text), false);
  assert.match(text, /0\.1 NEAR alice\.testnet/);
});
