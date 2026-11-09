import { NextResponse } from "next/server";
import { limitAiRequest, MAX_REPLY_TOKENS } from "@/lib/ai-rate-limit";
import { isTeeModel, nearAiApiKey, nearAiBaseUrl } from "@/lib/near-ai-tee";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT = 4_000;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: "invalid_json", message: "Request body must be JSON." } }, { status: 400 });
  }
  const record = asRecord(body);
  const text = typeof record.text === "string" ? record.text.trim() : "";
  const target = record.target === "bn" || record.target === "en" ? record.target : "";
  if (!text || !target) {
    return NextResponse.json({ error: { code: "text_required", message: "text and target are required." } }, { status: 400 });
  }
  if (text.length > MAX_TEXT) {
    return NextResponse.json({ error: { code: "text_too_long", message: "text exceeds 4000 characters." } }, { status: 400 });
  }
  const limited = await limitAiRequest(request);
  if (!limited.ok) {
    return NextResponse.json({ error: { code: limited.code, message: limited.message } }, { status: 429 });
  }
  const apiKey = nearAiApiKey(callerKey(request));
  if (!apiKey) {
    return NextResponse.json({ error: { code: "unconfigured", message: "NEAR_AI_CLOUD_API_KEY is not set." } }, { status: 503 });
  }
  const language = target === "bn" ? "Bengali" : "English";
  const requested = process.env.NEAR_AI_MODEL?.trim() || "";
  const model = requested && isTeeModel(requested) ? requested : "deepseek/deepseek-v3.2";
  try {
    const response = await fetch(`${nearAiBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: MAX_REPLY_TOKENS,
        messages: [
          {
            role: "system",
            content: `Translate to ${language}. Keep numbers, NEAR account IDs, token symbols and code unchanged. Output only the translation.`,
          },
          { role: "user", content: text },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      return NextResponse.json({ error: { code: "translate_failed", message: "Translation failed." } }, { status: 502 });
    }
    const translated = assistantText(payload);
    if (!translated) {
      return NextResponse.json({ error: { code: "translate_failed", message: "Translation failed." } }, { status: 502 });
    }
    return NextResponse.json({ text: translated });
  } catch {
    return NextResponse.json({ error: { code: "translate_failed", message: "Translation failed." } }, { status: 502 });
  }
}

function assistantText(payload: unknown): string {
  const record = asRecord(payload);
  const choice = Array.isArray(record.choices) ? asRecord(record.choices[0]) : null;
  const message = asRecord(choice?.message);
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  return content.replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function callerKey(request: Request): string | null {
  const value = request.headers.get("x-kotha-near-ai-key")?.trim() || "";
  if (!value || value.length > 500) return null;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}
