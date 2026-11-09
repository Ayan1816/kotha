import assert from "node:assert/strict";
import test from "node:test";
import { MAX_REPLY_TOKENS } from "./ai-rate-limit";
import { translateSystemPrompt, translateText } from "./translate-text";

const URL = "https://cloud-api.near.ai/v1/chat/completions";

function sse(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n`;
}

function ok(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("translateText talks to the chat model in both directions and retries once", async () => {
  assert.equal(
    translateSystemPrompt("bn"),
    "Translate to Bengali. Keep numbers, NEAR account IDs, token symbols and code unchanged. Output only the translation.",
  );
  assert.equal(
    translateSystemPrompt("en"),
    "Translate to English. Keep numbers, NEAR account IDs, token symbols and code unchanged. Output only the translation.",
  );

  const calls: Array<{ url: string; authorization: string; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(input), authorization: headers.get("authorization") ?? "", body });
    const target = (body.messages as Array<{ content?: string }> | undefined)?.[0]?.content ?? "";
    if (String(target).includes("Bengali")) return ok(sse("০.০১ NEAR alice.testnet কে পাঠাও"));
    return ok(JSON.stringify({ choices: [{ message: { content: "Send 0.01 NEAR to alice.testnet" } }] }));
  };

  const toBn = await translateText({
    text: "Send 0.01 NEAR to alice.testnet",
    target: "bn",
    apiKey: "test-key",
    model: "deepseek/deepseek-v3.2",
    baseUrl: "https://cloud-api.near.ai/v1",
    fetchImpl,
  });
  const toEn = await translateText({
    text: "alice.testnet কে 0.01 NEAR পাঠাও",
    target: "en",
    apiKey: "test-key",
    model: "deepseek/deepseek-v3.2",
    baseUrl: "https://cloud-api.near.ai/v1/",
    fetchImpl,
  });
  assert.equal(toBn, "০.০১ NEAR alice.testnet কে পাঠাও");
  assert.equal(toEn, "Send 0.01 NEAR to alice.testnet");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, URL);
    assert.equal(call.authorization, "Bearer test-key");
    assert.equal(call.body.model, "deepseek/deepseek-v3.2");
    assert.equal(call.body.stream, true);
    assert.equal(call.body.max_tokens, MAX_REPLY_TOKENS);
  }

  let attempts = 0;
  const retrying: typeof fetch = async () => {
    attempts += 1;
    if (attempts === 1) return new Response("nope", { status: 502 });
    return ok(sse("retry ok"));
  };
  const retried = await translateText({
    text: "hello",
    target: "bn",
    apiKey: "test-key",
    model: "deepseek/deepseek-v3.2",
    baseUrl: "https://cloud-api.near.ai/v1",
    fetchImpl: retrying,
  });
  assert.equal(retried, "retry ok");
  assert.equal(attempts, 2);

  let timed = 0;
  const flaky: typeof fetch = async () => {
    timed += 1;
    if (timed === 1) {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    }
    return ok(sse("after timeout"));
  };
  const recovered = await translateText({
    text: "hello",
    target: "en",
    apiKey: "test-key",
    model: "deepseek/deepseek-v3.2",
    baseUrl: "https://cloud-api.near.ai/v1",
    fetchImpl: flaky,
  });
  assert.equal(recovered, "after timeout");

  const failing: typeof fetch = async () => new Response("down", { status: 500 });
  await assert.rejects(
    () =>
      translateText({
        text: "hello",
        target: "en",
        apiKey: "test-key",
        model: "deepseek/deepseek-v3.2",
        baseUrl: "https://cloud-api.near.ai/v1",
        fetchImpl: failing,
      }),
    /NEAR AI chat returned HTTP 500\./,
  );
});
