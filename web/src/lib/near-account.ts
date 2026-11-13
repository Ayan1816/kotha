/** Official NEAR account-name body. Callers also require a .near or .testnet suffix. */
const ACCOUNT_NAME = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/** A hyphen plus a non-ASCII suffix (Bengali -এ, -তে, -কে) stays outside the account id. */
const NAMED_ACCOUNT = /(?:^|[^a-z0-9_-])((?:[a-z0-9]+(?:[-_][a-z0-9]+)*\.)+(?:near|testnet))(?![a-z0-9_]|-(?=[\u0000-\u007f]))/gi;
const IMPLICIT_ACCOUNT = /(?:^|[^0-9a-f])([0-9a-f]{64})(?![0-9a-f])/gi;

export function isNearAccountId(value: string): boolean {
  const id = value.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(id)) return true;
  if (id.length < 2 || id.length > 64) return false;
  if (!id.endsWith(".near") && !id.endsWith(".testnet")) return false;
  return ACCOUNT_NAME.test(id);
}

/** 2–64 chars of lowercase letters, digits, and single separators, or a 64-hex implicit account. */
export function isValidNearAccountId(value: string): boolean {
  const id = value.trim();
  if (/^[0-9a-f]{64}$/.test(id)) return true;
  if (id.length < 2 || id.length > 64) return false;
  if (!/^[a-z0-9._-]+$/.test(id)) return false;
  if (/^[._-]/.test(id) || /[._-]$/.test(id)) return false;
  if (/[._-]{2}/.test(id)) return false;
  return true;
}

export function isImplicitAccount(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value.trim());
}

/** Account ids mentioned in free text. Longer ids are safe to replace first. */
export function extractNearAccounts(text: string): string[] {
  const found: string[] = [];
  const push = (id: string) => {
    if (!isNearAccountId(id)) return;
    if (found.some((item) => item.toLowerCase() === id.toLowerCase())) return;
    found.push(id);
  };
  for (const match of text.matchAll(NAMED_ACCOUNT)) push(match[1] ?? "");
  for (const match of text.matchAll(IMPLICIT_ACCOUNT)) push(match[1] ?? "");
  return found.sort((left, right) => right.length - left.length);
}

export function shieldNearAccounts(text: string): { text: string; accounts: string[] } {
  const accounts = extractNearAccounts(text);
  let next = text;
  accounts.forEach((account, index) => {
    next = next.split(account).join(`NEARACCT${index}`);
  });
  return { text: next, accounts };
}

export function restoreNearAccounts(text: string, accounts: string[]): string {
  return accounts.reduce((current, account, index) => current.split(`NEARACCT${index}`).join(account), text);
}

export function placeholdersKept(text: string, count: number): boolean {
  for (let index = 0; index < count; index += 1) {
    if (!text.includes(`NEARACCT${index}`)) return false;
  }
  return true;
}

/** E.164 phone, or an empty string. NEAR account ids are not phones. */
export function extractE164(text: string): string {
  const match = text.match(/(?<![\dA-Za-z])\+\s*[1-9](?:[\s().-]*\d){7,14}(?![\d])/);
  if (!match?.[0]) return "";
  const digits = match[0].replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return "";
  return `+${digits}`;
}

/** Confidential or shield only when the user says so. */
export function wantsConfidential(text: string): boolean {
  return /গোপন|\bprivate\b|\bconfidential\b/i.test(text);
}
