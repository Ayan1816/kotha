import { translate, type Lang } from "@/components/aegis/copy";

/** Replace policy machine codes in text a person reads. Stored warning arrays stay raw. */
export function humanizeVisibleCodes(lang: Lang, text: string): string {
  if (!text) return text;
  return text.replace(/\b(?:PROHORI|PRV_KEY|PRIVATE_KEY)_[A-Z0-9_]+\b/g, (token) => {
    if (/PER_TX|TX_LIMIT/.test(token)) return translate(lang, "codePerTx");
    if (/DAILY|BUDGET/.test(token)) return translate(lang, "codeDaily");
    return translate(lang, "blockedByPolicy");
  });
}
