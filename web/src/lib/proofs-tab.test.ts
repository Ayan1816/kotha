import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatWarning, ProofsTable } from "../components/aegis/audit-panel";
import type { VerifiedExecution } from "./dashboard-types";

function renderProofs(lang: "en" | "bn", executions: VerifiedExecution[]) {
  return renderToStaticMarkup(
    createElement(ProofsTable, {
      lang,
      executions,
      contractId: "kotha.testnet",
      highlight: null,
      onVerifyChain: async () => ({ status: "match", code: "match" }) as const,
    }),
  );
}

const sample: VerifiedExecution = {
  correlation_id: "corr-1",
  agent_id: "agent.testnet",
  action_type: "swap",
  origin_asset: "nep141:wrap.near",
  destination_asset: "nep141:usdt.tether-token.near",
  amount_atomic: "2000000000000000000000000",
  usd_amount_cents: "1000",
  near_ai_chat_id: "chat-1",
  tee_signing_address: "0xabc",
  request_sha256: "c1".repeat(32),
  response_sha256: "d2".repeat(32),
  tee_signature: "sig",
  timestamp_ns: "1700000000000000000",
};

test("Proofs renders the localized empty state in English and Bengali", () => {
  const english = renderProofs("en", []);
  const bangla = renderProofs("bn", []);
  assert.match(english, /Proofs appear here after an executed \(signed\) transaction\./);
  assert.match(english, /Show details/);
  assert.match(bangla, /স্বাক্ষরিত/);
  assert.match(bangla, /বিস্তারিত দেখুন/);
  assert.equal(english.includes("<table"), false);
  assert.equal(bangla.includes("<table"), false);
});

test("Spending Guard warnings fill the real dollar amounts", () => {
  const warning = "PROHORI_PER_TX_LIMIT_EXCEEDED: this transfer is $80.00 and the on-chain per-transaction cap is $50.00.";
  const english = formatWarning("en", warning);
  const bangla = formatWarning("bn", warning);
  assert.match(english, /80\.00/);
  assert.match(english, /50\.00/);
  assert.equal(english.includes("{tx}"), false);
  assert.equal(english.includes("{cap}"), false);
  assert.match(bangla, /80\.00/);
  assert.match(bangla, /50\.00/);
  assert.match(bangla, /ডলার/);
  assert.equal(bangla.includes("{tx}"), false);
  const daily = formatWarning(
    "bn",
    "PROHORI_DAILY_BUDGET_EXCEEDED: spent today is $10.00, this transfer is $80.00, projected $90.00 of the $100.00 daily limit.",
  );
  assert.match(daily, /10\.00/);
  assert.match(daily, /90\.00/);
  assert.match(daily, /100\.00/);
  assert.match(daily, /ডলার/);
  assert.equal(daily.includes("{spent}"), false);
});

test("Proofs lists a recorded execution when one exists", () => {
  const html = renderProofs("en", [sample]);
  assert.match(html, /<table/);
  assert.match(html, />Swap</);
  assert.equal(html.includes("Proofs appear here"), false);
});
