import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeyPairEd25519, KeyPairSigner } from "near-api-js";
import { PROOF_MAX_AGE_MS, PROOF_RECIPIENT, buildProofMessage, encodeBase64 } from "./wallet-proof";
import { WalletAuthError, requireOwnerProof } from "./wallet-verify";

const OWNER = "kotha-vault-1793945609.testnet";
const NOW = 1_700_000_000_000;

async function signed(action: string, payload: unknown, ts = NOW, accountId = OWNER, sessionOwner = false) {
  const key = KeyPairEd25519.fromRandom();
  const message = buildProofMessage(action, payload, ts, sessionOwner);
  const nonce = new Uint8Array(32);
  nonce[0] = 7;
  nonce[31] = 11;
  const signer = new KeyPairSigner(key);
  const signedMessage = await signer.signNep413Message(accountId, {
    message,
    recipient: PROOF_RECIPIENT,
    nonce,
  });
  const publicKey = signedMessage.publicKey.toString();
  return {
    publicKey,
    proof: {
      accountId,
      publicKey,
      signature: encodeBase64(signedMessage.signature),
      message,
      nonce: encodeBase64(nonce),
    },
  };
}

function rpc(publicKey: string, permission: unknown = "FullAccess", calls: string[] = []) {
  return async (_url: string, init: { body: string }) => {
    calls.push(init.body);
    return {
      ok: true,
      json: async () => ({
        result: {
          keys: [{ public_key: publicKey, access_key: { nonce: 1, permission } }],
        },
      }),
    };
  };
}

describe("NEP-413 owner proof", () => {
  it("accepts a real signature whose public key is on the owner account", async () => {
    const payload = { intent: { action: "swap", amount: "1" } };
    const { proof, publicKey } = await signed("execute", payload);
    const calls: string[] = [];
    await requireOwnerProof({
      proof,
      action: "execute",
      payload,
      now: NOW,
      ownerId: OWNER,
      fetchImpl: rpc(publicKey, "FullAccess", calls),
    });
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0]) as { method: string; params: { request_type: string; finality: string; account_id: string } };
    assert.equal(body.method, "query");
    assert.equal(body.params.request_type, "view_access_key_list");
    assert.equal(body.params.finality, "final");
    assert.equal(body.params.account_id, OWNER);
  });

  it("rejects a different owner without calling RPC", async () => {
    const payload = { frozen: true };
    const { proof } = await signed("emergency_freeze", payload, NOW, "other.testnet");
    let called = false;
    await assert.rejects(
      () =>
        requireOwnerProof({
          proof,
          action: "emergency_freeze",
          payload,
          now: NOW,
          ownerId: OWNER,
          fetchImpl: async () => {
            called = true;
            return { ok: true, json: async () => ({ result: { keys: [] } }) };
          },
        }),
      (error: unknown) => error instanceof WalletAuthError && error.code === "owner_required" && error.status === 401,
    );
    assert.equal(called, false);
  });

  it("accepts the on-chain agent when the owner id is different", async () => {
    const payload = { intent: { action: "execute", amount: "1" } };
    const agent = "mohin12.testnet";
    const { proof, publicKey } = await signed("execute", payload, NOW, agent);
    await requireOwnerProof({
      proof,
      action: "execute",
      payload,
      now: NOW,
      ownerId: OWNER,
      allowedAccounts: [OWNER, agent],
      fetchImpl: rpc(publicKey),
    });
  });

  it("rejects an empty owner id", async () => {
    const payload = {};
    const { proof, publicKey } = await signed("rotate_grant", payload);
    await assert.rejects(
      () => requireOwnerProof({ proof, action: "rotate_grant", payload, now: NOW, ownerId: "", fetchImpl: rpc(publicKey) }),
      (error: unknown) => error instanceof WalletAuthError && error.code === "owner_required",
    );
  });

  it("rejects a timestamp older than 5 minutes", async () => {
    const payload = { policy: { dailyBudgetUsd: 1 } };
    const { proof } = await signed("update_policy", payload, NOW - PROOF_MAX_AGE_MS - 1);
    await assert.rejects(
      () => requireOwnerProof({ proof, action: "update_policy", payload, now: NOW, ownerId: OWNER, fetchImpl: rpc(proof.publicKey) }),
      (error: unknown) => error instanceof WalletAuthError && error.code === "proof_expired",
    );
  });

  it("rejects a timestamp more than 60 seconds in the future", async () => {
    const payload = {};
    const { proof } = await signed("revoke_grant", payload, NOW + 60_001);
    await assert.rejects(
      () => requireOwnerProof({ proof, action: "revoke_grant", payload, now: NOW, ownerId: OWNER, fetchImpl: rpc(proof.publicKey) }),
      (error: unknown) => error instanceof WalletAuthError && error.code === "proof_expired",
    );
  });

  it("rejects a nonce that is not 32 bytes", async () => {
    const payload = {};
    const { proof } = await signed("execute", payload);
    proof.nonce = encodeBase64(new Uint8Array(31));
    await assert.rejects(
      () => requireOwnerProof({ proof, action: "execute", payload, now: NOW, ownerId: OWNER, fetchImpl: rpc(proof.publicKey) }),
      (error: unknown) => error instanceof WalletAuthError && error.code === "proof_invalid",
    );
  });

  it("rejects a signature that authorizes a different action or payload", async () => {
    const payload = { policy: { dailyBudgetUsd: 10 } };
    const { proof } = await signed("update_policy", payload);
    await assert.rejects(
      () => requireOwnerProof({ proof, action: "execute", payload, now: NOW, ownerId: OWNER, fetchImpl: rpc(proof.publicKey) }),
      (error: unknown) => error instanceof WalletAuthError && error.code === "proof_invalid",
    );
    await assert.rejects(
      () =>
        requireOwnerProof({
          proof,
          action: "update_policy",
          payload: { policy: { dailyBudgetUsd: 11 } },
          now: NOW,
          ownerId: OWNER,
          fetchImpl: rpc(proof.publicKey),
        }),
      (error: unknown) => error instanceof WalletAuthError && error.code === "proof_invalid",
    );
  });

  it("rejects a public key that is not on the account", async () => {
    const payload = { id: "kotha-1", tx_hash: "4tgG9r1t3o8v8vYQq6oS7m1oYw2mQh3oP" };
    const { proof } = await signed("save_tx", payload);
    await assert.rejects(
      () => requireOwnerProof({ proof, action: "save_tx", payload, now: NOW, ownerId: OWNER, fetchImpl: rpc("ed25519:not-the-key") }),
      (error: unknown) => error instanceof WalletAuthError && error.code === "proof_invalid" && error.message.includes("Public key"),
    );
  });

  it("rejects a function-call key and a tampered signature", async () => {
    const payload = { frozen: false };
    const { proof, publicKey } = await signed("emergency_freeze", payload);
    await assert.rejects(
      () =>
        requireOwnerProof({
          proof,
          action: "emergency_freeze",
          payload,
          now: NOW,
          ownerId: OWNER,
          fetchImpl: rpc(publicKey, { FunctionCall: { receiver_id: "kotha.near", method_names: [], allowance: "1" } }),
        }),
      (error: unknown) => error instanceof WalletAuthError && error.code === "proof_invalid",
    );
    const flipped = proof.signature.slice(0, -2) + (proof.signature.endsWith("A") ? "B" : "A") + proof.signature.slice(-1);
    await assert.rejects(
      () =>
        requireOwnerProof({
          proof: { ...proof, signature: flipped },
          action: "emergency_freeze",
          payload,
          now: NOW,
          ownerId: OWNER,
          fetchImpl: rpc(publicKey),
        }),
      (error: unknown) => error instanceof WalletAuthError && error.code === "proof_invalid",
    );
  });

  it("accepts the demo signer without calling RPC", async () => {
    const payload = { policy: { dailyBudgetUsd: 2 } };
    const { proof } = await signed("update_policy", payload, NOW, "demo-owner.testnet");
    let called = false;
    await requireOwnerProof({
      proof,
      action: "update_policy",
      payload,
      now: NOW,
      ownerId: OWNER,
      fetchImpl: async () => {
        called = true;
        return { ok: true, json: async () => ({ result: { keys: [] } }) };
      },
    });
    assert.equal(called, false);
  });

  it("accepts another wallet when the signed message opts into session owner", async () => {
    const payload = {};
    const { proof, publicKey } = await signed("rotate_grant", payload, NOW, "mohina.near", true);
    const calls: string[] = [];
    await requireOwnerProof({
      proof,
      action: "rotate_grant",
      payload,
      now: NOW,
      ownerId: OWNER,
      fetchImpl: rpc(publicKey, "FullAccess", calls),
    });
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0]) as { params: { account_id: string } };
    assert.equal(body.params.account_id, "mohina.near");
  });

  it("accepts a session owner when the configured owner id is empty", async () => {
    const payload = { intent: { action: "swap" } };
    const { proof, publicKey } = await signed("execute", payload, NOW, "alice.testnet", true);
    await requireOwnerProof({
      proof,
      action: "execute",
      payload,
      now: NOW,
      ownerId: "",
      fetchImpl: rpc(publicKey),
    });
  });
});
