import { NextResponse } from "next/server";
import { limitAiRequest } from "@/lib/ai-rate-limit";
import { activeChatModel, nearAiApiKey, nearAiBaseUrl } from "@/lib/near-ai-tee";
import { translateText } from "@/lib/translate-text";

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
  try {
    const translated = await translateText({
      text,
      target,
      apiKey,
      model: activeChatModel(),
      baseUrl: nearAiBaseUrl(),
    });
    return NextResponse.json({ text: translated });
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Translation failed.";
    return NextResponse.json({ error: { code: "translate_failed", message } }, { status: 502 });
  }
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
