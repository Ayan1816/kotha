import assert from "node:assert/strict";
import test from "node:test";
import { previewIntent, type ActivePolicy } from "./intents-agent";
import { guardTransferCommand } from "./near-ai-tee";
import { parseTransferCommand } from "./transfer-parse";

const policy: ActivePolicy = {
  dailyBudgetUsd: 100,
  spentTodayUsd: 10,
  perTxCapUsd: 50,
  allowedActions: ["swap", "transfer", "withdraw", "shield", "unshield"],
  allowedAssets: ["nep141:wrap.near", "nep141:usdt.tether-token.near", "nep141:usdc.near"],
  confidentialShardEnabled: true,
  frozen: false,
};

test("parses an English USDC transfer and keeps the recipient", () => {
  const parsed = parseTransferCommand("Send 1 USDC to bob.testnet");
  assert.deepEqual(parsed, { amount: "1", token: "USDC", recipient: "bob.testnet" });
  assert.ok(parsed);
  const preview = previewIntent(
    {
      action: "transfer",
      origin_asset: "usdc",
      destination_asset: "usdc",
      amount: parsed.amount,
      amount_usd_estimate: 1,
      max_slippage_bps: 0,
      recipient: parsed.recipient,
      chain: "near",
      confidential: false,
    },
    policy,
    { public: { "nep141:usdc.near": 2_000_000n }, confidential: {}, prices: { "nep141:usdc.near": 1 } },
  );
  assert.equal(preview.warnings.some((warning) => /recipient is required/i.test(warning)), false);
  assert.equal(preview.budgetImpact.projectedSpentUsd, preview.budgetImpact.currentSpentUsd + preview.budgetImpact.txUsd);
});

test("parses a Bengali transfer with digits before the recipient marker", () => {
  const parsed = parseTransferCommand("bob.testnet কে ১ USDC পাঠাও");
  assert.deepEqual(parsed, { amount: "1", token: "USDC", recipient: "bob.testnet" });
});

const balances = { public: { "nep141:usdc.near": 2_000_000n }, confidential: {}, prices: { "nep141:usdc.near": 1 } };

test("Send 1 USDC to bob.testnet keeps the recipient and matches the guard", () => {
  const modelSaidAllowed = "This transfer is allowed.";
  const guarded = guardTransferCommand(
    "Send 1 USDC to bob.testnet",
    { action: "transfer", amount: "1", token: "USDC", recipient: "", to: "bob.testnet", origin_asset: "usdc", destination_asset: "usdc" },
    policy,
    balances,
    "en",
  );
  assert.ok(guarded);
  assert.equal(guarded.intent.recipient, "bob.testnet");
  assert.equal(guarded.intent.amount, "1");
  assert.equal(guarded.preview.allowed, true);
  assert.equal(guarded.preview.warnings.some((warning) => /recipient is required/i.test(warning)), false);
  assert.equal(guarded.explanation.includes(modelSaidAllowed), false);
  assert.match(guarded.explanation, /bob\.testnet/);
  assert.equal(/is blocked/i.test(guarded.explanation), false);
  assert.ok(guarded.risk_score < 90);
  const fromReceiver = guardTransferCommand(
    "Send 1 USDC to bob.testnet",
    { action: "transfer", amount: "1", token: "USDC", recipient: "", receiver_id: "bob.testnet" },
    policy,
    balances,
  );
  const fromCamel = guardTransferCommand(
    "Send 1 USDC to bob.testnet",
    { action: "transfer", amount: "1", token: "USDC", recipient: "", receiverId: "bob.testnet" },
    policy,
    balances,
  );
  assert.equal(fromReceiver?.intent.recipient, "bob.testnet");
  assert.equal(fromCamel?.intent.recipient, "bob.testnet");
});

test("bob.testnet কে ১ USDC পাঠাও keeps the recipient and a blocked reply says why", () => {
  const guarded = guardTransferCommand(
    "bob.testnet কে ১ USDC পাঠাও",
    { action: "transfer", recipient: "", amount: "", token: "" },
    policy,
    balances,
    "bn",
  );
  assert.ok(guarded);
  assert.equal(guarded.intent.recipient, "bob.testnet");
  assert.equal(guarded.intent.amount, "1");
  assert.equal(guarded.intent.origin_asset, "nep141:usdc.near");
  assert.equal(guarded.preview.allowed, true);
  assert.match(guarded.explanation, /bob\.testnet/);
  assert.equal(/is blocked/i.test(guarded.explanation), false);

  const blocked = guardTransferCommand(
    "Send 1 USDC",
    { action: "transfer", amount: "1", token: "USDC", recipient: "", origin_asset: "usdc", destination_asset: "usdc" },
    policy,
    balances,
    "en",
  );
  assert.ok(blocked);
  assert.equal(blocked.intent.recipient, "");
  assert.equal(blocked.preview.allowed, false);
  assert.equal(blocked.policy_status, "BLOCKED");
  assert.ok(blocked.risk_score >= 90);
  assert.match(blocked.explanation, /is blocked/i);
  assert.match(blocked.explanation, /recipient is required/i);
  assert.equal(blocked.explanation.includes("This transfer is allowed."), false);
});
