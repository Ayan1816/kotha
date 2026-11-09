import { MAX_REPLY_TOKENS } from "./ai-rate-limit";
import { assembleChatBody } from "./chat-stream";

const TRANSLATE_TIMEOUT_MS = 20_000;

export function translateSystemPrompt(target: "bn" | "en"): string {
  const language = target === "bn" ? "Bengali" : "English";
  return `Translate to ${language}. Keep numbers, NEAR account IDs, token symbols and code unchanged. Output only the translation.`;
}

export async function translateText(args: {
  text: string;
  target: "bn" | "en";
  apiKey: string;
  model: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const url = `${args.baseUrl.replace(/\/$/, "")}/chat/completions`;
  let lastError = "Translation failed.";
  for (let attempt = 0; attempt < 2; attempt += 1) {
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
        lastError = `NEAR AI chat returned HTTP ${response.status}.`;
        continue;
      }
      const translated = cleanTranslation(raw);
      if (!translated) {
        lastError = "NEAR AI chat returned an empty translation.";
        continue;
      }
      return translated;
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      lastError = name === "TimeoutError" || name === "AbortError" ? "Translation timed out." : "Translation failed.";
    }
  }
  throw new Error(lastError);
}

function cleanTranslation(raw: string): string {
  const assembled = assembleChatBody(raw).content.trim();
  const source = (assembled || raw).trim().replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!source || source === "[DONE]") return "";
  return source;
}
