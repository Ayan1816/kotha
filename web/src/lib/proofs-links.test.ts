import assert from "node:assert/strict";
import test from "node:test";
import { translate } from "../components/aegis/copy";
import { showWnearLine } from "../components/aegis/format";
import { viewAccountStatus } from "./account-view";
import { pairNearblocksPayloads, pairTransferHashes, type PairInput } from "./chain-tx-lookup";
import { noticeForApiError } from "./deck-errors";
import { hashesFromOutcomes } from "./native-transfer";
import { isNearAccountId } from "./near-account";
import { parseWalletReturnHashes } from "./wallet-return";
import { txHashFromOutcome } from "./wallet-proof";

const AMOUNT = "100000000000000000000000";
const SIGNER = "mohin12.testnet";
const TRANSFER_A = "7psUykJ1Xu39H9WBrmdqUANaEyHueBvWwaXmjMuRZt2q";
const RECORD_A = "539UVUbPwEQJikdiBSs9G7FCa72DDhw98sRA1twzCbfb";
const ID_A = "nt-e25259c0-7982-46d0-9ecb-30a794ea08f1";
const TRANSFER_B = "F8gpiMBsnrvcn2VjE4cQM9PuA4T9PUKTrpCWFuHzenxp";
const RECORD_B = "HVQq3eMpCEDbfazujasn1yXpmvfu4eAdx4QJkDdRmhAX";
const ID_B = "nt-5fe1e5c9-02ea-4180-86ca-1c27c6eea727";
const TRANSFER_C = "Gc7Zb9iLEGH11Gqnhj5bXMiuSyc5r7XbJcT7xp8TEmv8";
const RECORD_C = "FPNFxdsezDDHAs7JGthxx88A8KaKSZ3Ji48sBFF8sUuP";
const ID_C = "nt-c5f9ddf6-fcfe-4348-916e-0dd8e241d1c7";
const DECOY = "9LaterCloserXfer111111111111111111111111";
const OTHER = "9NotThisSignerXfer11111111111111111111111";

function liveRows(): PairInput[] {
  return [
    { hash: TRANSFER_A, signer: SIGNER, blockHeight: 1000, action: "TRANSFER", deposit: AMOUNT },
    { hash: OTHER, signer: "someoneelse.testnet", blockHeight: 1001, action: "TRANSFER", deposit: AMOUNT },
    { hash: RECORD_A, signer: SIGNER, blockHeight: 1002, action: "record_execution", correlationId: ID_A, amountAtomic: AMOUNT },
    { hash: DECOY, signer: SIGNER, blockHeight: 1003, action: "TRANSFER", deposit: AMOUNT },
    { hash: TRANSFER_B, signer: SIGNER, blockHeight: 2000, action: "TRANSFER", deposit: AMOUNT },
    { hash: RECORD_B, signer: SIGNER, blockHeight: 2002, action: "record_execution", correlationId: ID_B, amountAtomic: AMOUNT },
    { hash: TRANSFER_C, signer: SIGNER, blockHeight: 4000, action: "TRANSFER", deposit: AMOUNT },
    { hash: RECORD_C, signer: SIGNER, blockHeight: 4002, action: "record_execution", correlationId: ID_C, amountAtomic: AMOUNT },
  ];
}

test("chain pairing returns the three live transfer hashes and ignores a closer later transfer", () => {
  const paired = pairTransferHashes(liveRows());
  assert.equal(paired[ID_A]?.txHash, TRANSFER_A);
  assert.equal(paired[ID_A]?.proofHash, RECORD_A);
  assert.equal(paired[ID_B]?.txHash, TRANSFER_B);
  assert.equal(paired[ID_B]?.proofHash, RECORD_B);
  assert.equal(paired[ID_C]?.txHash, TRANSFER_C);
  assert.equal(paired[ID_C]?.proofHash, RECORD_C);
  assert.equal(Object.values(paired).some((row) => row.txHash === DECOY), false);
  assert.equal(Object.values(paired).some((row) => row.txHash === OTHER), false);
});

test("nearblocks payloads pair the same three transfers", () => {
  const account = {
    txns: [
      txn(TRANSFER_A, 1000, "TRANSFER", AMOUNT),
      txn(OTHER, 1001, "TRANSFER", AMOUNT, "someoneelse.testnet"),
      txn(RECORD_A, 1002, "FUNCTION_CALL", "0"),
      txn(DECOY, 1003, "TRANSFER", AMOUNT),
      txn(TRANSFER_B, 2000, "TRANSFER", AMOUNT),
      txn(RECORD_B, 2002, "FUNCTION_CALL", "0"),
      txn(TRANSFER_C, 4000, "TRANSFER", AMOUNT),
      txn(RECORD_C, 4002, "FUNCTION_CALL", "0"),
    ],
  };
  const details = {
    [RECORD_A]: detail(ID_A),
    [RECORD_B]: detail(ID_B),
    [RECORD_C]: detail(ID_C),
  };
  const paired = pairNearblocksPayloads(account, details);
  assert.equal(paired[ID_A]?.txHash, TRANSFER_A);
  assert.equal(paired[ID_B]?.txHash, TRANSFER_B);
  assert.equal(paired[ID_C]?.txHash, TRANSFER_C);
  assert.equal(paired[ID_A]?.proofHash, RECORD_A);
});

test("wallet redirect URL lists the transfer hash before the proof hash", () => {
  const search = `?transactionHashes=${TRANSFER_C},${RECORD_C}`;
  const parsed = parseWalletReturnHashes(search, "");
  assert.equal(parsed.transferHash, TRANSFER_C);
  assert.equal(parsed.proofHash, RECORD_C);
  const fromHash = parseWalletReturnHashes("", `#txHashes=${TRANSFER_A}`);
  assert.equal(fromHash.transferHash, TRANSFER_A);
  assert.equal(fromHash.proofHash, "");
});

test("tx hash readers accept a raw string and a hash object", () => {
  assert.equal(txHashFromOutcome(TRANSFER_C), TRANSFER_C);
  assert.equal(txHashFromOutcome({ hash: TRANSFER_C }), TRANSFER_C);
  assert.equal(txHashFromOutcome({ transactionHash: TRANSFER_A }), TRANSFER_A);
  assert.equal(txHashFromOutcome({ txHash: TRANSFER_B }), TRANSFER_B);
  const both = hashesFromOutcomes([TRANSFER_C, { hash: RECORD_C }]);
  assert.equal(both.transferHash, TRANSFER_C);
  assert.equal(both.proofHash, RECORD_C);
  assert.equal(hashesFromOutcomes(TRANSFER_A).transferHash, TRANSFER_A);
});

test("view_account distinguishes a missing account, a live account, and a network failure", async () => {
  const missing = fakeFetch({
    error: { cause: { name: "UNKNOWN_ACCOUNT" }, message: "account rightyih316.testnet does not exist while viewing" },
  });
  assert.equal(await viewAccountStatus("rightyih316.testnet", missing), "missing");
  const exists = fakeFetch({ result: { amount: "100000000000000000000000" } });
  assert.equal(await viewAccountStatus("alice.testnet", exists), "exists");
  const offline: typeof fetch = () => Promise.reject(new Error("network down"));
  assert.equal(await viewAccountStatus("alice.testnet", offline), "unknown");
  assert.equal(isNearAccountId("rightyih316.testnet"), true);
});

test("Bengali admin toast uses the copy key instead of the English server sentence", () => {
  const text = noticeForApiError("bn", { code: "admin_rejected", message: "That code was not accepted." });
  assert.equal(text.includes("That code was not accepted."), false);
  assert.equal(text, translate("bn", "adminRejected"));
  assert.equal(noticeForApiError("en", { code: "admin_rejected", message: "That code was not accepted." }), translate("en", "adminRejected"));
});

test("swap settlement copy is a testnet preview and native transfers omit it", () => {
  for (const lang of ["en", "bn"] as const) {
    const line = translate(lang, "nearSettles");
    assert.match(line, /testnet|wrap\.testnet/i);
    assert.equal(line.includes("wrap.near"), false);
  }
  const native = {
    action: "transfer" as const,
    origin_asset: "nep141:wrap.near",
    destination_asset: "nep141:wrap.near",
    recipient: "alice.testnet",
  };
  assert.equal(showWnearLine(native), false);
  assert.equal(showWnearLine({ ...native, action: "swap", recipient: "intents.near" }), true);
});

function txn(hash: string, blockHeight: number, action: string, deposit: string, signer = SIGNER) {
  return {
    transaction_hash: hash,
    signer_account_id: signer,
    block_height: blockHeight,
    actions: [{ action, method: action === "FUNCTION_CALL" ? "record_execution" : null }],
    actions_agg: { deposit },
  };
}

function detail(correlationId: string) {
  return {
    data: {
      actions: [
        {
          args: {
            args_json: {
              execution: { correlation_id: correlationId, amount_atomic: AMOUNT },
            },
          },
        },
      ],
    },
  };
}

function fakeFetch(body: unknown): typeof fetch {
  return (() => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }))) as typeof fetch;
}
