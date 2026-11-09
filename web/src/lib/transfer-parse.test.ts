import assert from "node:assert/strict";
import test from "node:test";
import { previewIntent, type ActivePolicy } from "./intents-agent";
import { guardTransferCommand } from "./near-ai-tee";
import { answerAsQuestion, isGeneralQuestion, normalizeVoiceSpelling } from "./question-intent";
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

const nearBook = {
  public: { "nep141:wrap.near": 5n * 10n ** 24n },
  confidential: {},
  prices: { "nep141:wrap.near": 3.42 },
};

test("NEAR account transfers stay public and are not phone remittances", () => {
  const phrases: Array<[string, string, string]> = [
    ["Send 0.01 NEAR to alice.testnet", "alice.testnet", "0.01"],
    ["alice.testnet কে 0.01 NEAR পাঠাও", "alice.testnet", "0.01"],
    ["send 1 NEAR to bob.near", "bob.near", "1"],
  ];
  for (const [message, recipient, amount] of phrases) {
    const guarded = guardTransferCommand(
      message,
      { action: "transfer", recipient: "INVALID_RECIPIENT_FORMAT", amount: "", token: "" },
      policy,
      nearBook,
      "en",
    );
    assert.ok(guarded, message);
    assert.equal(guarded.intent.recipient, recipient, message);
    assert.equal(guarded.intent.amount, amount, message);
    assert.equal(guarded.intent.action, "transfer", message);
    assert.equal(guarded.intent.confidential, false, message);
    assert.equal(guarded.preview.allowed, true, message);
    assert.equal(guarded.policy_status, "PASS", message);
    assert.equal(/INVALID_RECIPIENT/i.test(guarded.policy_reason), false, message);
    assert.equal(/INVALID_RECIPIENT/i.test(guarded.explanation), false, message);
    assert.equal(/phone number/i.test(guarded.explanation), false, message);
    assert.equal(/is blocked/i.test(guarded.explanation), false, message);
  }
});

test("an E.164 phone is a remittance and confidential only when asked", () => {
  const publicRemit = guardTransferCommand(
    "Send 1 NEAR to +14155550199",
    { action: "none", recipient: "", amount: "" },
    policy,
    nearBook,
    "en",
  );
  assert.ok(publicRemit);
  assert.equal(publicRemit.intent.recipient, "+14155550199");
  assert.equal(publicRemit.intent.action, "transfer");
  assert.equal(publicRemit.intent.confidential, false);
  assert.equal(publicRemit.preview.allowed, true);
  assert.equal(/INVALID_RECIPIENT/i.test(publicRemit.explanation), false);

  const privateRemit = guardTransferCommand("Send 1 NEAR confidential to +14155550199", { action: "transfer" }, policy, nearBook, "en");
  assert.equal(privateRemit?.intent.confidential, true);
  assert.equal(privateRemit?.intent.recipient, "+14155550199");
});

test("an unknown balance does not invent available 0", () => {
  const guarded = guardTransferCommand(
    "Send 0.01 NEAR to alice.testnet",
    { action: "transfer", recipient: "INVALID_RECIPIENT_FORMAT" },
    policy,
    { public: {}, confidential: {}, prices: {} },
    "en",
  );
  assert.ok(guarded);
  assert.equal(guarded.intent.recipient, "alice.testnet");
  assert.equal(guarded.intent.confidential, false);
  assert.equal(guarded.policy_reason, "BALANCE_UNAVAILABLE");
  assert.equal(/available 0/i.test(guarded.explanation), false);
  assert.match(guarded.explanation, /unavailable/i);
});

test("general questions are not rejected as transfers", () => {
  for (const text of ["নিয়ার কি", "নিয়ার কি", "নেয়ার কী", "নেয়ার কী?"]) {
    const normalized = normalizeVoiceSpelling(text);
    assert.equal(normalized.includes("NEAR"), true, text);
    assert.equal(normalized.includes("কী"), false, text);
  }
  for (const text of ["নিয়ার কি", "নিয়ার কি", "নেয়ার কী", "নেয়ার কী?", "NEAR কী?", "what is near"]) {
    assert.equal(isGeneralQuestion(text), true, text);
    assert.equal(
      guardTransferCommand(text, { action: "transfer", recipient: "INVALID_RECIPIENT_FORMAT", amount: "1", token: "NEAR" }, policy, nearBook),
      null,
      text,
    );
  }
  assert.equal(isGeneralQuestion("Send 0.01 NEAR to alice.testnet"), false);
  const rejected = answerAsQuestion("I couldn't understand your message. Try swap/transfer/withdraw.", "en");
  assert.equal(rejected.policy_status, "PASS");
  assert.equal(rejected.intent, null);
  assert.equal(rejected.policy_reason, "QUESTION");
  assert.equal(/couldn'?t understand/i.test(rejected.explanation), false);
  assert.equal(/swap\/transfer\/withdraw/i.test(rejected.explanation), false);
  assert.equal(answerAsQuestion("NEAR is a layer-1 blockchain.", "bn").explanation, "NEAR is a layer-1 blockchain.");
});
