import { extractE164 } from "./near-account";
import { isGeneralQuestion, normalizeVoiceSpelling } from "./question-intent";
import {
  amountIssue,
  directedRecipient,
  foldDigits,
  invalidDirectedAccount,
  messageTransferTarget,
  parseAmountToken,
} from "./transfer-parse";

const ASSET_ALIASES: Record<string, string> = {
  wnear: "nep141:wrap.near",
  "wrap.near": "nep141:wrap.near",
  "wrapped near": "nep141:wrap.near",
  near: "nep141:wrap.near",
  usdt: "nep141:usdt.tether-token.near",
  tether: "nep141:usdt.tether-token.near",
  usdc: "nep141:usdc.near",
};

function foldPrompt(text: string): string {
  return normalizeVoiceSpelling(foldDigits(text));
}

export function isAdversarialPrompt(text: string): boolean {
  return /লিমিট\s*ভুলে|ignore\s+all\s+limits|\bdrain\b|attacker\.near/i.test(text);
}

function detectAction(text: string): string | null {
  if (isAdversarialPrompt(text)) return "transfer";
  if (/আনশিল্ড|\bunshield\b|\bdeshield\b/i.test(text)) return "unshield";
  if (/লুকিয়ে|লুকিয়ে|গোপন\s*ভল্ট|\bprivate\s+vault\b|\bshield\b/i.test(text) || /\binto\s+intents\.far\b/i.test(text)) return "shield";
  if (/রেমিট্যান্স|প্রবাসী|remittance/i.test(text)) return "transfer";
  if (/\bwithdraw\b|\bwithdrawal\b|\bcash\s*out\b|উত্তোলন/i.test(text)) return "withdraw";
  if (/কিনে|সোয়াপ|সোয়াপ|\bswap\b|\bexchange\b|\bconvert\b|\btrade\b|\bbuy\b/i.test(text)) return "swap";
  if (/পাঠাও|\btransfer\b|\bpay\b|\bsend\b|\bcontractor\b/i.test(text)) return "transfer";
  if (/\bintents\.far\b|\bconfidential\b/i.test(text)) return "shield";
  return null;
}

function findAssets(text: string): string[] {
  const found: string[] = [];
  const pattern = /\bwnear\b|\bwrapped\s+near\b|\bwrap\.near\b|\busdt\b|\btether\b|\busdc\b|\bnear\b/gi;
  for (const match of text.matchAll(pattern)) {
    const key = match[0].toLowerCase().replace(/\s+/g, " ");
    const asset = ASSET_ALIASES[key] ?? key;
    if (!found.includes(asset)) found.push(asset);
  }
  return found;
}

function detectRecipient(text: string, action: string): string {
  const directed = directedRecipient(text);
  if (directed) return directed;
  const near = text.match(/\b([a-z0-9][a-z0-9._-]{0,62}\.(?:near|testnet|tg))\b/i);
  if (near && !/^intents\.(?:near|far)$/i.test(near[1])) return near[1];
  const phone = extractE164(foldDigits(text));
  if (phone && (action === "transfer" || action === "withdraw")) return phone;
  if (action === "shield") return "intents.far";
  if (action === "unshield" || action === "swap") return "intents.near";
  if (action === "withdraw") return "owner.kotha.testnet";
  return "";
}

function rejectedAccount(message: string): string {
  const folded = foldPrompt(message);
  const action = detectAction(folded);
  if (action !== "transfer" && action !== "withdraw") return "";
  return invalidDirectedAccount(folded);
}

/** Transfer, swap, shield, or withdraw whose amount and parties are already in the text. */
export function isDeterministicCommand(message: string): boolean {
  if (isGeneralQuestion(message)) return false;
  const folded = foldPrompt(message);
  if (isAdversarialPrompt(folded)) return false;
  const action = detectAction(folded);
  if (action === "swap") {
    const parsed = parseAmountToken(folded);
    if (!parsed?.amount || Number(parsed.amount) <= 0) return false;
    return findAssets(folded).length >= 2;
  }
  if (action === "shield") {
    const parsed = parseAmountToken(folded);
    return Boolean(parsed?.amount && Number(parsed.amount) > 0);
  }
  if (action !== "transfer" && action !== "withdraw") return false;
  if (rejectedAccount(folded)) return true;
  const parsed = parseAmountToken(folded);
  if (!parsed?.amount || !parsed.token) return false;
  if (action === "withdraw") return Boolean(detectRecipient(folded, "withdraw"));
  const target = messageTransferTarget(folded);
  return Boolean(target.account || target.phone);
}

function commandAmountIssue(message: string): boolean {
  if (isGeneralQuestion(message)) return false;
  const parsed = parseAmountToken(message);
  if (!parsed) return false;
  return amountIssue(parsed.amount, parsed.token) != null;
}

/** Local card or rejection. These messages must not call the model or spend chat quota. */
export function isLocalChatPreview(message: string): boolean {
  const folded = foldPrompt(message);
  if (isAdversarialPrompt(folded)) return true;
  if (commandAmountIssue(folded)) return true;
  return isDeterministicCommand(message);
}
