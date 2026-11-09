import { foldDigits } from "./transfer-parse";

const ACTION_VERB =
  /পাঠাও|কিনে|সোয়াপ|সোয়াপ|লুকিয়ে|লুকিয়ে|উত্তোলন|আনশিল্ড|গোপন|রেমিট্যান্স|প্রবাসী|\b(send|transfer|pay|swap|exchange|convert|trade|buy|withdraw|withdrawal|shield|unshield|deshield|remittance|private|confidential)\b/i;

const REJECTION =
  /couldn'?t understand|could not understand|swap\/transfer\/withdraw|INVALID_RECIPIENT/i;

/** Voice spellings of NEAR and the Bengali word for "what". */
export function normalizeVoiceSpelling(text: string): string {
  return text.replace(/নিয়ার|নিয়ার|নেয়ার|নেয়ার/g, "NEAR").replace(/কী/g, "কি");
}

export function isGeneralQuestion(text: string): boolean {
  const normalized = normalizeVoiceSpelling(foldDigits(text));
  return !ACTION_VERB.test(normalized);
}

export function isRejectionTemplate(text: string): boolean {
  return REJECTION.test(text);
}

export function questionFallback(locale: string): string {
  if (locale === "bn") {
    return "NEAR একটি লেয়ার-১ ব্লকচেইন। ব্যালেন্স জানতে ওয়ালেট যুক্ত করুন। কোনো লেনদেন চাইলে কাজ ও পরিমাণ বলুন।";
  }
  return "NEAR is a layer-1 blockchain. Connect a wallet to read a balance. Name an action and an amount when you want a transaction.";
}

export type QuestionAnswer = {
  explanation: string;
  risk_score: 5;
  policy_status: "PASS";
  policy_reason: "QUESTION";
  intent: null;
};

/** Keep a real model answer. Replace the swap/transfer/withdraw rejection menu. */
export function answerAsQuestion(modelText: string | null | undefined, locale: string): QuestionAnswer {
  const text = modelText?.trim() || "";
  const usable = text.length > 0 && !isRejectionTemplate(text);
  return {
    explanation: usable ? text : questionFallback(locale),
    risk_score: 5,
    policy_status: "PASS",
    policy_reason: "QUESTION",
    intent: null,
  };
}
