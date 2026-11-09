export const WHISPER_MODEL = "openai/whisper-large-v3";
export const WHISPER_URL = "https://cloud-api.near.ai/v1/audio/transcriptions";
export const TRANSCRIPT_FALLBACK = "Transcription service is unavailable. Type your command instead.";

const VOICE_LANGS = ["en", "bn", "es", "ar", "hi", "fr", "zh"] as const;

export type TranscriptChoice = {
  text: string;
  fallback: boolean;
  message: string;
};

export function parseTranscription(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const text = (body as { text?: unknown }).text;
  return typeof text === "string" ? text.trim() : "";
}

export function normalizeVoiceLanguage(value: unknown): (typeof VOICE_LANGS)[number] {
  if (typeof value !== "string") return "en";
  const base = value.trim().toLowerCase().split(/[-_]/)[0] || "";
  return (VOICE_LANGS as readonly string[]).includes(base) ? (base as (typeof VOICE_LANGS)[number]) : "en";
}

export function chooseTranscript(status: number | null, cloudText: string, hint: string): TranscriptChoice {
  const cloud = cloudText.trim();
  const spoken = hint.trim();
  if (status != null && status >= 200 && status < 300 && cloud) {
    return { text: cloud, fallback: false, message: "" };
  }
  if (spoken) return { text: spoken, fallback: true, message: "" };
  return { text: "", fallback: true, message: TRANSCRIPT_FALLBACK };
}
