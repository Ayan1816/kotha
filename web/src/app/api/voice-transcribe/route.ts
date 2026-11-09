import { NextResponse } from "next/server";
import { limitAiRequest } from "@/lib/ai-rate-limit";
import { readVoiceDuration, VOICE_TOO_LONG_MESSAGE } from "@/lib/wav";
import { normalizeVoiceLanguage, parseTranscription, WHISPER_MODEL, WHISPER_URL } from "@/lib/voice-transcribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 30_000;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

export async function POST(request: Request) {
  const key = process.env.NEAR_AI_CLOUD_API_KEY?.trim();
  let form: FormData;
  try {
    form = await request.formData();
  } catch (error) {
    console.error("voice-transcribe", error);
    return NextResponse.json({ text: "", error: "Expected multipart audio." }, { status: 400 });
  }
  const audio = form.get("file") ?? form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return NextResponse.json({ text: "", error: "audio file is required." }, { status: 400 });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ text: "", error: "audio exceeds 12 MB." }, { status: 413 });
  }
  const language = normalizeVoiceLanguage(form.get("language"));
  if (!key) {
    console.error("voice-transcribe", "NEAR_AI_CLOUD_API_KEY is not set.");
    return NextResponse.json({ text: "", error: "NEAR_AI_CLOUD_API_KEY is not set." }, { status: 503 });
  }
  const bytes = new Uint8Array(await audio.arrayBuffer());
  if (!readVoiceDuration(bytes).ok) {
    return NextResponse.json({ text: "", error: { code: "voice_too_long", message: VOICE_TOO_LONG_MESSAGE } }, { status: 413 });
  }
  const limited = await limitAiRequest(request);
  if (!limited.ok) {
    return NextResponse.json({ text: "", error: { code: limited.code, message: limited.message } }, { status: 429 });
  }
  const outbound = new FormData();
  const filename = audio instanceof File && audio.name ? audio.name : "audio.wav";
  const type = audio.type || "audio/wav";
  const file = new File([bytes], filename, { type });
  outbound.set("file", file, filename);
  outbound.set("model", WHISPER_MODEL);
  outbound.set("language", language);
  outbound.set("response_format", "json");
  try {
    const response = await fetch(WHISPER_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: outbound,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await response.json().catch(() => null);
    const cloudText = response.ok ? parseTranscription(json) : "";
    if (!response.ok || !cloudText) {
      const message = readError(json) || `Transcription failed (HTTP ${response.status}).`;
      console.error("voice-transcribe", response.status, message);
      const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
      return NextResponse.json({ text: "", error: message }, { status });
    }
    return NextResponse.json({ text: cloudText });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    const message = timedOut ? "Transcription timed out after 30s." : error instanceof Error ? error.message : "Transcription failed.";
    console.error("voice-transcribe", error);
    return NextResponse.json({ text: "", error: message }, { status: 504 });
  }
}

function readError(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as { error?: { message?: unknown }; message?: unknown };
  if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
  if (record.error && typeof record.error.message === "string") return record.error.message.trim();
  return "";
}
