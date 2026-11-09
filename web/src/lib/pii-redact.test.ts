// node:test keeps this off vitest so `npm ci` does not need a new dependency.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactDeterministic, redactSensitiveText } from "./pii-redact";

const BENGALI_PHONE = "আমার ফোন ০১৭১১২২৩৩৪৪";
const SEED_12 = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const SEED_24 = `${SEED_12} ${SEED_12}`;

function redact(input: string) {
  return redactDeterministic(input);
}

describe("Bangladeshi and international phones", () => {
  it("redacts the exact Bengali sentence", () => {
    const result = redact(BENGALI_PHONE);
    assert.equal(result.text, "আমার ফোন [REDACTED_PHONE]");
    assert.equal(result.count, 1);
    assert.deepEqual(result.types, ["phone"]);
  });

  it("redacts a bare local mobile", () => {
    const result = redact("01711223344");
    assert.equal(result.text, "[REDACTED_PHONE]");
    assert.equal(result.count, 1);
    assert.deepEqual(result.types, ["phone"]);
  });

  it("redacts +880 with spaces and dashes", () => {
    const result = redact("+880 1812-345678");
    assert.equal(result.text, "[REDACTED_PHONE]");
    assert.equal(result.count, 1);
    assert.deepEqual(result.types, ["phone"]);
  });

  it("redacts 880 and +880 compact forms once", () => {
    for (const input of ["8801711223344", "+8801711223344", "01711-223344"]) {
      const result = redact(input);
      assert.equal(result.text, "[REDACTED_PHONE]", input);
      assert.equal(result.count, 1, input);
    }
  });

  it("redacts bKash and Nagad wallet numbers", () => {
    assert.equal(redact("bKash 1711223344").text, "bKash [REDACTED_PHONE]");
    assert.equal(redact("নগদ 01812345678").text, "নগদ [REDACTED_PHONE]");
    assert.equal(redact("Nagad: 01911-223344").count, 1);
  });

  it("redacts international E.164 numbers", () => {
    for (const input of ["+1 202 555 0147", "+44 20 7946 0958", "+91 98765 43210", "+971 50 123 4567"]) {
      const result = redact(`call ${input} now`);
      assert.equal(result.text, "call [REDACTED_PHONE] now", input);
      assert.equal(result.count, 1, input);
      assert.deepEqual(result.types, ["phone"], input);
    }
  });
});

describe("emails, IDs, cards, and seed phrases", () => {
  it("redacts an email", () => {
    const result = redact("write ada@example.com today");
    assert.equal(result.text, "write [REDACTED_EMAIL] today");
    assert.equal(result.count, 1);
    assert.deepEqual(result.types, ["email"]);
  });

  it("redacts NID numbers of 10, 13, and 17 digits", () => {
    assert.equal(redact("nid 1985123456").text, "nid [REDACTED_ID]");
    assert.equal(redact("nid 1234567890123").text, "nid [REDACTED_ID]");
    assert.equal(redact("nid 12345678901234567").text, "nid [REDACTED_ID]");
  });

  it("redacts a passport number", () => {
    const result = redact("passport EA1234567");
    assert.equal(result.text, "passport [REDACTED_ID]");
    assert.deepEqual(result.types, ["id"]);
  });

  it("redacts a Luhn-valid card and keeps an invalid one", () => {
    assert.equal(redact("4111111111111111").text, "[REDACTED_CARD]");
    assert.equal(redact("4111 1111 1111 1111").text, "[REDACTED_CARD]");
    assert.equal(redact("4111-1111-1111-1111").text, "[REDACTED_CARD]");
    const invalid = redact("4111111111111112");
    assert.equal(invalid.text, "4111111111111112");
    assert.equal(invalid.count, 0);
  });

  it("redacts 12-word and 24-word BIP39 phrases", () => {
    const twelve = redact(`সিড ${SEED_12}`);
    assert.equal(twelve.text, "সিড [REDACTED_SEED]");
    assert.equal(twelve.count, 1);
    assert.deepEqual(twelve.types, ["seed"]);
    const twentyFour = redact(SEED_24);
    assert.equal(twentyFour.text, "[REDACTED_SEED]");
    assert.equal(twentyFour.count, 1);
    assert.equal(redact(SEED_12.split(" ").slice(0, 11).join(" ")).count, 0);
  });

  it("counts a phone and an email together", () => {
    const result = redact("01711223344 and ada@example.com");
    assert.equal(result.text, "[REDACTED_PHONE] and [REDACTED_EMAIL]");
    assert.equal(result.count, 2);
    assert.deepEqual(result.types, ["phone", "email"]);
  });

  it("keeps NEAR account ids and still redacts a phone", () => {
    const mixed = redact("Send 0.01 NEAR to alice.testnet and +14155550199");
    assert.match(mixed.text, /alice\.testnet/);
    assert.equal(mixed.text.includes("+14155550199"), false);
    assert.match(mixed.text, /\[REDACTED_PHONE\]/);
    const implicit = "ab".repeat(32);
    const kept = redact(`pay ${implicit} now`);
    assert.equal(kept.text.includes(implicit), true);
    assert.equal(kept.count, 0);
  });

  it("leaves amounts and account ids alone", () => {
    const swap = "আমার ২ NEAR দিয়ে USDT কিনে দাও";
    assert.equal(redact(swap).text, swap);
    assert.equal(redact(swap).count, 0);
    const account = "kotha-vault-1793945609";
    assert.equal(redact(account).text, account);
    assert.equal(redact("send 20 USDT").text, "send 20 USDT");
  });
});

describe("NEAR AI privacy filter", () => {
  it("posts the original text when an API key is set", async () => {
    const calls: Array<{ url: string; body: string; authorization: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        body: String(init?.body ?? ""),
        authorization: headers.get("authorization") ?? "",
      });
      return Response.json({ redacted_text: "call [REDACTED_PHONE]" });
    };
    const result = await redactSensitiveText("call 01711223344", {
      apiKey: "test-key",
      fetchImpl,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://cloud-api.near.ai/v1/privacy/redact");
    assert.equal(calls[0]?.authorization, "Bearer test-key");
    const payload = JSON.parse(calls[0]?.body ?? "{}") as { model?: string; input?: string };
    assert.equal(payload.model, "openai/privacy-filter");
    assert.equal(payload.input, "call 01711223344");
    assert.equal(result.redactedText, "call [REDACTED_PHONE]");
    assert.equal(result.redactionsCount, 1);
    assert.deepEqual(result.piiTypesFound, ["phone"]);
  });

  it("does not call the filter without a key", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      throw new Error("privacy filter should not be called");
    };
    const result = await redactSensitiveText("01711223344", { fetchImpl });
    assert.equal(called, false);
    assert.equal(result.redactedText, "[REDACTED_PHONE]");
  });

  it("keeps the local redaction when the filter fails or drops the number", async () => {
    const failing: typeof fetch = async () => {
      throw new Error("privacy filter down");
    };
    const failed = await redactSensitiveText("01711223344", { apiKey: "test-key", fetchImpl: failing });
    assert.equal(failed.redactedText, "[REDACTED_PHONE]");
    assert.equal(failed.redactionsCount, 1);

    const dropping: typeof fetch = async () => Response.json({ text: "call me" });
    const dropped = await redactSensitiveText("call 01711223344", { apiKey: "test-key", fetchImpl: dropping });
    assert.equal(dropped.redactedText, "call [REDACTED_PHONE]");
    assert.equal(dropped.redactionsCount, 1);
  });

  it("restores a NEAR account the privacy filter removed", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      assert.match(payload.input ?? "", /NEARACCT0/);
      assert.equal((payload.input ?? "").includes("alice.testnet"), false);
      return Response.json({ redacted_text: "Send 0.01 NEAR to someone and [REDACTED_PHONE]" });
    };
    const result = await redactSensitiveText("Send 0.01 NEAR to alice.testnet and +14155550199", {
      apiKey: "test-key",
      fetchImpl,
    });
    assert.match(result.redactedText, /alice\.testnet/);
    assert.equal(result.redactedText.includes("+14155550199"), false);
    assert.match(result.redactedText, /\[REDACTED_PHONE\]/);
    assert.match(result.redactedText, /0\.01 NEAR/);
  });

  it("keeps token amounts and account ids when the filter glues redacted_pii onto NEAR", async () => {
    const commands: Array<[string, string, string]> = [
      ["Send 0.01 NEAR to alice.testnet", "0.01 NEAR", "alice.testnet"],
      ["alice.testnet কে 0.01 NEAR পাঠাও", "0.01 NEAR", "alice.testnet"],
      ["send 1 NEAR to bob.near", "1 NEAR", "bob.near"],
      ["alice.testnet কে ০.০১ NEAR পাঠাও", "০.০১ NEAR", "alice.testnet"],
    ];
    for (const [command, amount, account] of commands) {
      const fetchImpl: typeof fetch = async (_input, init) => {
        const payload = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
        const input = payload.input ?? "";
        assert.equal(input.includes(account), false, command);
        assert.equal(input.includes(amount), false, command);
        assert.equal(/\d(?:\.\d+)?\s*NEAR\b/i.test(input), false, command);
        const glued = input.replace(/(?<=\d)\s*NEAR\b/gi, "redacted_pii_1");
        return Response.json({ redacted_text: glued });
      };
      const result = await redactSensitiveText(command, { apiKey: "test-key", fetchImpl });
      assert.equal(result.redactedText.includes(amount), true, command);
      assert.equal(result.redactedText.includes(account), true, command);
      assert.equal(result.redactedText.includes("redacted_pii"), false, command);
    }

    const mangling: typeof fetch = async () => Response.json({ redacted_text: "Send 0.01redacted_pii_1 to redacted_pii_2" });
    const dropped = await redactSensitiveText("Send 0.01 NEAR to alice.testnet", { apiKey: "test-key", fetchImpl: mangling });
    assert.match(dropped.redactedText, /0\.01 NEAR/);
    assert.match(dropped.redactedText, /alice\.testnet/);
    assert.equal(dropped.redactedText.includes("redacted_pii"), false);
  });
});
