import assert from "node:assert/strict";
import test from "node:test";
import { previewIntent, type ActivePolicy } from "./intents-agent";
import { parseTransferCommand } from "./near-ai-tee";

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
