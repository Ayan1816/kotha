import { BIP39_ENGLISH } from "./bip39-english";
import { placeholdersKept, restoreNearAccounts, shieldNearAccounts } from "./near-account";

export type PiiType = "email" | "phone" | "api_key" | "seed" | "id" | "card";

export type LocalRedaction = {
  text: string;
  count: number;
  types: PiiType[];
};

export type RedactionResult = {
  originalLength: number;
  redactedText: string;
  redactionsCount: number;
  piiTypesFound: string[];
};

const BIP39 = new Set(BIP39_ENGLISH);
const DEFAULT_PRIVACY_URL = "https://cloud-api.near.ai/v1/privacy/redact";

type Span = {
  start: number;
  end: number;
  token: string;
  type: PiiType;
};

export function foldBengaliDigits(input: string): string {
  return input.replace(/[\u09E6-\u09EF]/g, (digit) => String(digit.charCodeAt(0) - 0x09e6));
}

export function redactDeterministic(input: string): LocalRedaction {
  const folded = foldBengaliDigits(input);
  const spans: Span[] = [];
  collectSeeds(folded, spans);
  collectEmails(folded, spans);
  collectApiKeys(folded, spans);
  collectPhones(folded, spans);
  collectCards(folded, spans);
  collectIds(folded, spans);
  return applySpans(input, spans);
}

const AMOUNT_WITH_TOKEN = /(?<![\d.০-৯])([0-9০-৯]+(?:[.][0-9০-৯]+)?)\s*(?:usdc|usdt|wnear|near)\b/gi;

/** Hold token amounts out of the privacy filter, then put the original text back. */
export function shieldAmounts(text: string): { text: string; amounts: string[] } {
  const amounts: string[] = [];
  const next = text.replace(AMOUNT_WITH_TOKEN, (match) => {
    const token = `KOTHAAMT${amounts.length}`;
    amounts.push(match);
    return token;
  });
  return { text: next, amounts };
}

export function restoreAmounts(text: string, amounts: string[]): string {
  let next = text;
  for (let index = amounts.length - 1; index >= 0; index -= 1) {
    next = next.split(`KOTHAAMT${index}`).join(amounts[index] ?? "");
  }
  return next;
}

function amountPlaceholdersKept(text: string, count: number): boolean {
  for (let index = 0; index < count; index += 1) {
    if (!text.includes(`KOTHAAMT${index}`)) return false;
  }
  return true;
}

export async function redactSensitiveText(
  text: string,
  options?: {
    apiKey?: string | null;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<RedactionResult> {
  const accounts = shieldNearAccounts(text);
  const amounts = shieldAmounts(accounts.text);
  const shieldedText = amounts.text;
  const kept = (value: string) =>
    placeholdersKept(value, accounts.accounts.length) && amountPlaceholdersKept(value, amounts.amounts.length);
  const local = redactDeterministic(shieldedText);
  const types = new Set<PiiType>(local.types);
  let redactedText = local.text;
  let redactionsCount = local.count;
  const apiKey = options?.apiKey?.trim() || "";
  if (apiKey) {
    try {
      const remote = await callPrivacyFilter(shieldedText, apiKey, options);
      for (const piiType of remote.types) types.add(piiType);
      if (remote.text && kept(remote.text)) {
        const tightened = redactDeterministic(remote.text);
        for (const piiType of tightened.types) types.add(piiType);
        if (tightened.count >= local.count && kept(tightened.text)) {
          redactedText = tightened.text;
        }
        redactionsCount = Math.max(redactionsCount, tightened.count, remote.count ?? 0);
      }
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      // Local redaction already ran. A privacy-filter outage must not leak PII onward.
    }
  }
  const restored = restoreNearAccounts(restoreAmounts(redactedText, amounts.amounts), accounts.accounts);
  return {
    originalLength: text.length,
    redactedText: restored,
    redactionsCount,
    piiTypesFound: [...types],
  };
}

export function privacyRedactUrl(baseUrl?: string): string {
  if (!baseUrl) return DEFAULT_PRIVACY_URL;
  return `${baseUrl.replace(/\/$/, "")}/privacy/redact`;
}

function collectPhones(text: string, spans: Span[]): void {
  // BD mobiles: 01[3-9]XXXXXXXX, +8801..., 8801..., separators, after Bengali-digit folding.
  const bd = /(?<![\d])(?:\+?880|0)[\s-]*1[3-9](?:[\s-]*\d){8}(?![\d])/g;
  pushMatches(text, bd, "[REDACTED_PHONE]", "phone", spans);
  const labeled = /(?:bkash|nagad|নগদ|বিকাশ)\s*[:#-]?\s*((?:\+?880[\s-]*|0[\s-]*)?1[3-9](?:[\s-]*\d){8})(?![\d])/gi;
  for (const match of text.matchAll(labeled)) {
    const number = match[1];
    if (match.index == null || !number) continue;
    const start = match.index + match[0].length - number.length;
    spans.push({ start, end: start + number.length, token: "[REDACTED_PHONE]", type: "phone" });
  }
  const intl = /(?<![\d])\+[1-9]/g;
  for (const match of text.matchAll(intl)) {
    if (match.index == null) continue;
    const start = match.index;
    let end = start + match[0].length;
    let digits = match[0].slice(1);
    while (end < text.length && digits.length < 15) {
      const ch = text[end] ?? "";
      if (ch >= "0" && ch <= "9") {
        digits += ch;
        end += 1;
        continue;
      }
      if (ch === " " || ch === "-" || ch === "." || ch === "(" || ch === ")") {
        end += 1;
        continue;
      }
      break;
    }
    while (end > start && /[\s.()-]/.test(text[end - 1] ?? "")) end -= 1;
    if (digits.length < 8 || digits.length > 15) continue;
    spans.push({ start, end, token: "[REDACTED_PHONE]", type: "phone" });
  }
  const nanp = /(?<![\d])(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\d])/g;
  pushMatches(text, nanp, "[REDACTED_PHONE]", "phone", spans);
}

function collectEmails(text: string, spans: Span[]): void {
  pushMatches(text, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]", "email", spans);
}

function collectApiKeys(text: string, spans: Span[]): void {
  const patterns = [
    /\bnaa_[A-Za-z0-9_-]{8,}\b/g,
    /\bngt_[A-Za-z0-9_-]{8,}\b/g,
    /\bsk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{12,}\b/g,
    /\bxai-[A-Za-z0-9_-]{12,}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gi,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\b(?:api[_-]?key|apikey|access[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{12,}['"]?/gi,
  ];
  for (const pattern of patterns) pushMatches(text, pattern, "[REDACTED_API_KEY]", "api_key", spans);
}

function collectCards(text: string, spans: Span[]): void {
  const pattern = /(?<![\d])\d(?:[ -]?\d){12,18}(?![\d])/g;
  for (const match of text.matchAll(pattern)) {
    if (match.index == null) continue;
    const digits = match[0].replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (!/^[3-6]/.test(digits) || !luhn(digits)) continue;
    spans.push({ start: match.index, end: match.index + match[0].length, token: "[REDACTED_CARD]", type: "card" });
  }
}

function collectIds(text: string, spans: Span[]): void {
  const emirates = /(?<![\d])784[-\s]\d{4}[-\s]\d{7}[-\s]\d(?![\d])/g;
  pushMatches(text, emirates, "[REDACTED_ID]", "id", spans);
  const ssn = /(?<![\d])\d{3}-\d{2}-\d{4}(?![\d])/g;
  pushMatches(text, ssn, "[REDACTED_ID]", "id", spans);
  const passport = /(?<![A-Za-z0-9])[A-Z]{1,2}\d{7,8}(?![A-Za-z0-9])/gi;
  pushMatches(text, passport, "[REDACTED_ID]", "id", spans);
  const nid = /(?<![\dA-Za-z-])\d{10}(?![\dA-Za-z-])|(?<![\dA-Za-z-])\d{13}(?![\dA-Za-z-])|(?<![\dA-Za-z-])\d{17}(?![\dA-Za-z-])/g;
  pushMatches(text, nid, "[REDACTED_ID]", "id", spans);
}

function collectSeeds(text: string, spans: Span[]): void {
  const matches = [...text.matchAll(/[A-Za-z]+/g)];
  let cursor = 0;
  while (cursor < matches.length) {
    const word = matches[cursor];
    if (!word || !BIP39.has(word[0].toLowerCase())) {
      cursor += 1;
      continue;
    }
    let end = cursor;
    while (end < matches.length) {
      const current = matches[end];
      if (!current || !BIP39.has(current[0].toLowerCase())) break;
      if (end > cursor) {
        const previous = matches[end - 1];
        if (!previous) break;
        const gap = text.slice((previous.index ?? 0) + previous[0].length, current.index ?? 0);
        if (!/^\s+$/.test(gap)) break;
      }
      end += 1;
    }
    const length = end - cursor;
    if ((length === 12 || length === 24) && matches[cursor] && matches[end - 1]) {
      const first = matches[cursor];
      const last = matches[end - 1];
      spans.push({
        start: first.index ?? 0,
        end: (last.index ?? 0) + last[0].length,
        token: "[REDACTED_SEED]",
        type: "seed",
      });
    }
    cursor = Math.max(end, cursor + 1);
  }
}

function pushMatches(text: string, pattern: RegExp, token: string, type: PiiType, spans: Span[]): void {
  for (const match of text.matchAll(pattern)) {
    if (match.index == null || match[0].length === 0) continue;
    spans.push({ start: match.index, end: match.index + match[0].length, token, type });
  }
}

function applySpans(original: string, spans: Span[]): LocalRedaction {
  const sorted = spans
    .filter((span) => span.start >= 0 && span.end > span.start && span.end <= original.length)
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const chosen: Span[] = [];
  let cursor = 0;
  for (const span of sorted) {
    if (span.start < cursor) continue;
    chosen.push(span);
    cursor = span.end;
  }
  let text = "";
  let last = 0;
  const types: PiiType[] = [];
  const seen = new Set<PiiType>();
  for (const span of chosen) {
    text += original.slice(last, span.start) + span.token;
    last = span.end;
    if (!seen.has(span.type)) {
      seen.add(span.type);
      types.push(span.type);
    }
  }
  text += original.slice(last);
  return { text, count: chosen.length, types };
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (value < 0 || value > 9) return false;
    if (alternate) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

async function callPrivacyFilter(
  text: string,
  apiKey: string,
  options?: { baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal },
): Promise<{ text?: string; types: PiiType[]; count?: number }> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const response = await fetchImpl(privacyRedactUrl(options?.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "openai/privacy-filter", input: text }),
    signal: options?.signal
      ? AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 8_000), options.signal])
      : AbortSignal.timeout(options?.timeoutMs ?? 8_000),
  });
  const body = await response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Privacy filter returned HTTP ${response.status}`);
  }
  const parsed = parseJson(body);
  const redacted = extractRedactedText(parsed);
  const types = new Set<PiiType>();
  const record = asRecord(parsed);
  const entities = record?.entities ?? record?.pii_types ?? record?.findings ?? collectSpanCategories(record?.data);
  if (Array.isArray(entities)) {
    for (const entity of entities) {
      const name = typeof entity === "string" ? entity : stringValue(asRecord(entity)?.type) || stringValue(asRecord(entity)?.category);
      const mapped = mapPiiType(name);
      if (mapped) types.add(mapped);
    }
  }
  return { text: redacted || undefined, types: [...types], count: Array.isArray(entities) ? entities.length : undefined };
}

function collectSpanCategories(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  const categories: string[] = [];
  for (const item of value) {
    const spans = asRecord(item)?.spans;
    if (!Array.isArray(spans)) continue;
    for (const span of spans) {
      const category = stringValue(asRecord(span)?.category);
      if (category) categories.push(category);
    }
  }
  return categories.length > 0 ? categories : null;
}

function extractRedactedText(value: unknown): string {
  const direct = extractString(value, ["redacted", "redacted_text", "output", "text", "result"]);
  if (direct) return direct;
  const record = asRecord(value);
  const data = record?.data;
  if (typeof data === "string") return data.trim();
  if (Array.isArray(data)) {
    const parts = data
      .map((item) => (typeof item === "string" ? item : extractString(item, ["redacted", "redacted_text", "output", "text", "result"])))
      .filter((part) => part.length > 0);
    if (parts.length > 0) return parts.join("\n");
  }
  return "";
}

export function mapPiiType(value: string): PiiType | null {
  const name = value.toLowerCase();
  if (!name) return null;
  if (name.includes("email")) return "email";
  if (name.includes("phone") || name.includes("mobile") || name.includes("bkash") || name.includes("nagad")) return "phone";
  if (name.includes("card") || name.includes("credit") || name.includes("iban")) return "card";
  if (name.includes("seed") || name.includes("mnemonic")) return "seed";
  if (name.includes("passport") || name.includes("nid") || name.includes("ssn") || name.includes("national") || /(^|_)id($|_)/.test(name)) {
    return "id";
  }
  if (name.includes("api") || name.includes("secret") || name.includes("key")) return "api_key";
  return null;
}

function extractString(value: unknown, keys: string[]): string {
  const record = asRecord(value);
  if (!record) return "";
  for (const key of keys) {
    const found = record[key];
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  return "";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
