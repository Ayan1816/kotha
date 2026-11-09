import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { base58Decode, base58Encode, encodeFunctionCallTransaction, recordExecutionArgs } from "./near-function-call";
import {
  buildFrozenReceipt,
  canonicalJson,
  centsToUsd,
  judgeReceipt,
  readChainExecution,
  type ReceiptBody,
} from "./receipt-canonical";
import { getReceipt, putReceipt, setReceiptStatus } from "./receipt-store";

const storeDir = path.join(os.homedir(), ".kotha-receipt-test");
process.env.KOTHA_RECEIPT_FILE_ONLY = "1";
process.env.KOTHA_RECEIPT_STORE = path.join(storeDir, "receipts.json");

after(() => {
  fs.rmSync(storeDir, { recursive: true, force: true });
});

const body: ReceiptBody = {
  action: "swap",
  agent_id: "agent-kotha-prime.near",
  amount_atomic: "2000000000000000000000000",
  amount_usd: "1.00",
  chat_id: "chat-real-1",
  correlation_id: "receipt-1",
  destination_asset: "nep141:usdt.tether-token.near",
  intent_hash: "ab".repeat(32),
  origin_asset: "nep141:wrap.near",
  request_sha256: "cd".repeat(32),
  response_sha256: "ef".repeat(32),
  signature: `0x${"11".repeat(64)}`,
  signing_address: "0x6525e128afcffebf7eed05d485d7be983cdae934",
  timestamp_ns: "1700000000000000123",
  usd_amount_cents: "100",
};

describe("frozen receipts", () => {
  it("builds the same canonical bytes twice", async () => {
    const first = await buildFrozenReceipt(body);
    const second = await buildFrozenReceipt(body);
    assert.equal(first.bytes, second.bytes);
    assert.equal(first.receipt_hash, second.receipt_hash);
    assert.equal(first.receipt_hash.length, 64);
    assert.equal(canonicalJson({ b: 1, a: 1 }), '{"a":1,"b":1}');
    assert.equal(centsToUsd("513"), "5.13");
  });

  it("changes the hash when the timestamp changes", async () => {
    const other = await buildFrozenReceipt({ ...body, timestamp_ns: "1700000000000000124" });
    const original = await buildFrozenReceipt(body);
    assert.notEqual(other.receipt_hash, original.receipt_hash);
  });

  it("returns the exact stored bytes on a second read", async () => {
    const frozen = await buildFrozenReceipt(body);
    const saved = await putReceipt(body.correlation_id, { bytes: frozen.bytes, tx_hash: null, chain_error: null });
    const again = await putReceipt(body.correlation_id, {
      bytes: '{"receipt":{},"receipt_hash":"changed"}',
      tx_hash: "ignored",
      chain_error: null,
    });
    assert.equal(again.bytes, saved.bytes);
    assert.equal((await getReceipt(body.correlation_id))?.bytes, frozen.bytes);
    await setReceiptStatus(body.correlation_id, { tx_hash: "TxHash111", chain_error: null });
    const updated = await getReceipt(body.correlation_id);
    assert.equal(updated?.bytes, frozen.bytes);
    assert.equal(updated?.tx_hash, "TxHash111");
  });

  it("matches get_execution and reports a mismatch", async () => {
    const frozen = await buildFrozenReceipt(body);
    const chain = {
      action_type: body.action,
      near_ai_chat_id: body.chat_id,
      request_sha256: body.intent_hash,
      response_sha256: frozen.receipt_hash,
      timestamp_ns: body.timestamp_ns,
      usd_amount_cents: body.usd_amount_cents,
    };
    assert.equal(judgeReceipt(body, frozen.receipt_hash, frozen.receipt_hash, chain).match, true);
    assert.equal(judgeReceipt(body, frozen.receipt_hash, frozen.receipt_hash, { ...chain, response_sha256: "00".repeat(32) }).match, false);
    assert.equal(judgeReceipt(body, frozen.receipt_hash, "ff".repeat(32), chain).match, false);
  });

  it("keeps a full-precision timestamp from the contract JSON", () => {
    const raw = `{"action_type":"swap","near_ai_chat_id":"chat-real-1","request_sha256":"${"ab".repeat(32)}","response_sha256":"${"cd".repeat(32)}","timestamp_ns":1700000000000000123,"usd_amount_cents":100}`;
    const view = readChainExecution(raw);
    assert.equal(view?.timestamp_ns, "1700000000000000123");
    assert.equal(view?.usd_amount_cents, "100");
  });
});

describe("record_execution encoding", () => {
  it("writes receipt_hash, chat_id, intent hash, action, amount, and timestamp", () => {
    const args = recordExecutionArgs({
      correlation_id: body.correlation_id,
      agent_id: body.agent_id,
      action: body.action,
      origin_asset: body.origin_asset,
      destination_asset: body.destination_asset,
      amount_atomic: body.amount_atomic,
      usd_amount_cents: body.usd_amount_cents,
      chat_id: body.chat_id,
      signing_address: body.signing_address,
      intent_hash: body.intent_hash,
      receipt_hash: "12".repeat(32),
      signature: body.signature,
      timestamp_ns: body.timestamp_ns,
    });
    const parsed = JSON.parse(args) as { execution: Record<string, string> };
    assert.equal(parsed.execution.response_sha256, "12".repeat(32));
    assert.equal(parsed.execution.request_sha256, body.intent_hash);
    assert.equal(parsed.execution.near_ai_chat_id, body.chat_id);
    assert.equal(parsed.execution.action_type, "swap");
    assert.equal(args.includes('"usd_amount_cents":100'), true);
    assert.equal(args.includes(`"timestamp_ns":${body.timestamp_ns}`), true);
  });

  it("round-trips base58 and prefixes a function-call transaction", () => {
    const source = new Uint8Array(32);
    source[0] = 0;
    source[1] = 1;
    source[31] = 255;
    assert.deepEqual(base58Decode(base58Encode(source)), source);
    assert.equal(base58Encode(new Uint8Array([0])), "1");
    assert.equal(base58Encode(new Uint8Array([1])), "2");
    const encoded = encodeFunctionCallTransaction({
      signerId: "alice.testnet",
      publicKey: new Uint8Array(32).fill(3),
      nonce: BigInt(7),
      receiverId: "bob.testnet",
      blockHash: new Uint8Array(32).fill(4),
      methodName: "record_execution",
      args: new Uint8Array([123, 125]),
      gas: BigInt(100),
      deposit: BigInt(0),
    });
    assert.equal(encoded[0], 13);
    assert.equal(new TextDecoder().decode(encoded.slice(4, 17)), "alice.testnet");
    assert.equal(encoded[17], 0);
  });

  it("signs a transaction hash with ed25519", () => {
    const seed = new Uint8Array(32).fill(9);
    const message = new Uint8Array(32).fill(5);
    const signature = ed25519.sign(message, seed);
    assert.equal(signature.length, 64);
    assert.equal(ed25519.verify(signature, message, ed25519.getPublicKey(seed)), true);
  });
});
