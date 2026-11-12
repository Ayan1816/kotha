import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProofsTable } from "../components/aegis/audit-panel";
import type { VerifiedExecution } from "./dashboard-types";

function renderProofs(lang: "en" | "bn", executions: VerifiedExecution[]) {
  return renderToStaticMarkup(
    createElement(ProofsTable, {
      lang,
      executions,
      contractId: "kotha.testnet",
      highlight: null,
      onVerifyChain: async () => "match" as const,
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
  request_sha256: "a".repeat(64),
  response_sha256: "b".repeat(64),
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

test("Proofs lists a recorded execution when one exists", () => {
  const html = renderProofs("en", [sample]);
  assert.match(html, /<table/);
  assert.match(html, />swap</);
  assert.equal(html.includes("Proofs appear here"), false);
});
