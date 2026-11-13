import { MAX_REPLY_TOKENS } from "./ai-rate-limit";
import { assembleChatBody } from "./chat-stream";

const TRANSLATE_TIMEOUT_MS = 20_000;
const TRANSLATE_ATTEMPTS = 3;

const successCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
const fellBack = new Map<string, boolean>();

export function translateSystemPrompt(target: "bn" | "en"): string {
  const language = target === "bn" ? "Bengali" : "English";
  return `Translate to ${language}. Keep numbers, NEAR account IDs, token symbols and code unchanged. Output only the translation.`;
}

export function translateBackoffMs(attempt: number): number {
  return 400 * 2 ** Math.max(0, attempt - 1);
}

type TranslateArgs = {
  text: string;
  target: "bn" | "en";
  apiKey: string;
  model: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
};

function cacheKey(target: string, text: string): string {
  return `${target}\n${text}`;
}

export function translationFellBack(target: string, text: string): boolean {
  return fellBack.get(cacheKey(target, text)) === true;
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logUpstream(status: number | string, body: string, apiKey: string): void {
  const hidden = apiKey ? body.split(apiKey).join("[redacted]") : body;
  const slice = hidden.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 400);
  console.error(`[translate] upstream ${status}: ${slice}`);
}

export async function translateText(args: TranslateArgs): Promise<string> {
  const key = cacheKey(args.target, args.text);
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = runTranslate(args, key);
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

async function runTranslate(args: TranslateArgs, key: string): Promise<string> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const wait = args.wait ?? defaultWait;
  const url = `${args.baseUrl.replace(/\/$/, "")}/chat/completions`;
  let lastError = "Translation failed.";
  for (let attempt = 0; attempt < TRANSLATE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait(translateBackoffMs(attempt));
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${args.apiKey}`,
          accept: "text/event-stream, application/json",
          "accept-encoding": "identity",
          "content-type": "application/json",
          "x-no-aliasing": "true",
        },
        body: JSON.stringify({
          model: args.model,
          stream: true,
          max_tokens: MAX_REPLY_TOKENS,
          messages: [
            { role: "system", content: translateSystemPrompt(args.target) },
            { role: "user", content: args.text },
          ],
        }),
        signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
      });
      const raw = await response.text();
      if (!response.ok) {
        logUpstream(response.status, raw, args.apiKey);
        lastError = `NEAR AI chat returned HTTP ${response.status}.`;
        continue;
      }
      const translated = cleanTranslation(raw);
      if (!translated) {
        logUpstream(response.status, raw, args.apiKey);
        lastError = "NEAR AI chat returned an empty translation.";
        continue;
      }
      successCache.set(key, translated);
      fellBack.set(key, false);
      return translated;
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const detail = error instanceof Error ? error.message : "request failed";
      logUpstream(name || "error", detail, args.apiKey);
      lastError = name === "TimeoutError" || name === "AbortError" ? "Translation timed out." : "Translation failed.";
    }
  }
  const cached = successCache.get(key);
  if (cached) {
    fellBack.set(key, true);
    return cached;
  }
  throw new Error(lastError);
}

export async function serveTranslation(args: TranslateArgs): Promise<{ text: string; fallback: boolean }> {
  try {
    const text = await translateText(args);
    return { text, fallback: translationFellBack(args.target, args.text) };
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Translation failed.";
    console.error(`[translate] upstream failed: ${message}`);
    return { text: args.text, fallback: true };
  }
}

export async function serveTranslations(
  args: Omit<TranslateArgs, "text"> & { texts: string[] },
): Promise<{ texts: string[]; fallback: boolean }> {
  try {
    const texts = await translateMany(args);
    return { texts, fallback: args.texts.some((text) => translationFellBack(args.target, text)) };
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Translation failed.";
    console.error(`[translate] upstream failed: ${message}`);
    return { texts: args.texts, fallback: true };
  }
}

/** One chat completion for several strings. Identical lines share one result. */
export async function translateMany(args: Omit<TranslateArgs, "text"> & { texts: string[] }): Promise<string[]> {
  const texts = args.texts;
  if (texts.length === 0) return [];
  const unique: string[] = [];
  for (const text of texts) {
    if (!unique.includes(text)) unique.push(text);
  }
  const missing = unique.filter((text) => !successCache.has(cacheKey(args.target, text)));
  if (missing.length === 0) {
    return texts.map((text) => successCache.get(cacheKey(args.target, text)) ?? "");
  }
  const chunkSize = 2;
  for (let offset = 0; offset < missing.length; offset += chunkSize) {
    const slice = missing.slice(offset, offset + chunkSize);
    if (slice.length === 1) {
      const only = await translateText({ ...args, text: slice[0] });
      successCache.set(cacheKey(args.target, slice[0]), only);
      continue;
    }
    const flattened = slice.map((text) => text.replace(/\s*\n+\s*/g, " ").trim());
    const prompt = flattened.map((text, index) => `[${index}] ${text}`).join("\n");
    try {
      const raw = await translateText({ ...args, text: prompt });
      const parsed = parseNumbered(raw, slice.length);
      if (parsed) {
        slice.forEach((text, index) => successCache.set(cacheKey(args.target, text), parsed[index]));
        continue;
      }
    } catch {
      // One request per remaining line in this chunk.
    }
    for (const text of slice) {
      if (successCache.has(cacheKey(args.target, text))) continue;
      const translated = await translateText({ ...args, text });
      successCache.set(cacheKey(args.target, text), translated);
    }
  }
  return texts.map((text) => {
    const found = successCache.get(cacheKey(args.target, text));
    if (!found) throw new Error("Translation failed.");
    return found;
  });
}

function parseNumbered(raw: string, count: number): string[] | null {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const tagged = new Array<string>(count).fill("");
  let seen = 0;
  for (const line of lines) {
    const match = /^\[(\d+)\]\s*([\s\S]*)$/.exec(line);
    if (!match) continue;
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 0 || index >= count || tagged[index]) continue;
    const value = match[2].trim();
    if (!value) continue;
    tagged[index] = value;
    seen += 1;
  }
  if (seen === count) return tagged;
  if (lines.length === count && lines.every((line) => !/^\[\d+\]/.test(line))) return lines;
  return null;
}

function cleanTranslation(raw: string): string {
  const assembled = assembleChatBody(raw).content.trim();
  const source = (assembled || raw)
    .trim()
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!source || source === "[DONE]") return "";
  return source;
}
