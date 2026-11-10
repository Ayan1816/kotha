import assert from "node:assert/strict";
import test from "node:test";
import { MAX_REPLY_TOKENS } from "./ai-rate-limit";
import { translateMany, translateSystemPrompt, translateText } from "./translate-text";

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
    wait: async () => {},
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
    wait: async () => {},
  });
  assert.equal(recovered, "after timeout");

  const waits: number[] = [];
  let failures = 0;
  const failing: typeof fetch = async () => {
    failures += 1;
    return new Response("down", { status: 500 });
  };
  await assert.rejects(
    () =>
      translateText({
        text: "never-cached-phrase",
        target: "en",
        apiKey: "test-key",
        model: "deepseek/deepseek-v3.2",
        baseUrl: "https://cloud-api.near.ai/v1",
        fetchImpl: failing,
        wait: async (ms) => {
          waits.push(ms);
        },
      }),
    /NEAR AI chat returned HTTP 500\./,
  );
  assert.equal(failures, 3);
  assert.deepEqual(waits, [400, 800]);
});

test("translateText logs upstream failures, serves a cached line, and dedupes", async () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map((item) => String(item)).join(" "));
  };
  try {
    let hits = 0;
    const fetchImpl: typeof fetch = async () => {
      hits += 1;
      if (hits === 1) return ok(sse("cached line"));
      return new Response("secret-body test-key", { status: 502 });
    };
    const first = await translateText({
      text: "cache-me",
      target: "bn",
      apiKey: "test-key",
      model: "deepseek/deepseek-v3.2",
      baseUrl: "https://cloud-api.near.ai/v1",
      fetchImpl,
      wait: async () => {},
    });
    const second = await translateText({
      text: "cache-me",
      target: "bn",
      apiKey: "test-key",
      model: "deepseek/deepseek-v3.2",
      baseUrl: "https://cloud-api.near.ai/v1",
      fetchImpl,
      wait: async () => {},
    });
    assert.equal(first, "cached line");
    assert.equal(second, "cached line");
    assert.equal(hits, 4);
    const joined = logged.join("\n");
    assert.match(joined, /upstream 502/);
    assert.match(joined, /secret-body/);
    assert.equal(joined.includes("test-key"), false);

    let shared = 0;
    const slow: typeof fetch = async () => {
      shared += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return ok(sse("shared"));
    };
    const args = {
      text: "dedupe-key",
      target: "en" as const,
      apiKey: "test-key",
      model: "deepseek/deepseek-v3.2",
      baseUrl: "https://cloud-api.near.ai/v1",
      fetchImpl: slow,
      wait: async () => {},
    };
    const [left, right] = await Promise.all([translateText(args), translateText(args)]);
    assert.equal(left, "shared");
    assert.equal(right, "shared");
    assert.equal(shared, 1);
  } finally {
    console.error = original;
  }
});

test("translateMany sends one numbered request and reuses identical lines", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
    const user = body.messages?.[1]?.content ?? "";
    assert.match(user, /\[0\] alpha/);
    assert.match(user, /\[1\] beta/);
    assert.equal(user.includes("[2]"), false);
    return ok(sse("[0] ALPHA\n[1] BETA"));
  };
  const translated = await translateMany({
    texts: ["alpha", "alpha", "beta"],
    target: "en",
    apiKey: "test-key",
    model: "deepseek/deepseek-v3.2",
    baseUrl: "https://cloud-api.near.ai/v1",
    fetchImpl,
    wait: async () => {},
  });
  assert.deepEqual(translated, ["ALPHA", "ALPHA", "BETA"]);
  assert.equal(calls, 1);
});
