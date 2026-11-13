import { translate, type CopyKey, type Lang } from "@/components/aegis/copy";

/** Server codes that can show up in a toast. The English message stays on the server. */
const API_COPY: Record<string, CopyKey> = {
  admin_rejected: "adminRejected",
  admin_rate_limited: "adminRateLimited",
  admin_unconfigured: "adminUnconfigured",
  proof_invalid: "proofInvalid",
  proof_expired: "proofExpired",
  invalid_tx: "invalidTx",
  receipt_not_found: "receiptNotFound",
  invalid_freeze: "invalidFreeze",
  owner_required: "ownerRequired",
  invalid_json: "loadFail",
  invalid_action: "loadFail",
  request_failed: "loadFail",
  internal_error: "loadFail",
  bad_response: "loadFail",
  wallet_limit: "loadFail",
  free_limit: "loadFail",
};

export function noticeForApiError(lang: Lang, error: unknown, fallback: CopyKey = "loadFail"): string {
  const code = errorCode(error);
  const key = code ? API_COPY[code] : undefined;
  if (key) return translate(lang, key);
  if (lang === "bn") return translate(lang, fallback);
  if (error instanceof Error && error.message.trim()) return error.message;
  return translate(lang, fallback);
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}
