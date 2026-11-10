export type TeePill = "idle" | "local" | "verified" | "unverified";

const LOCAL_PREVIEW = /model was not called/i;

export function isLocalPreview(verification: { status: string; reason: string } | null | undefined): boolean {
  if (!verification || verification.status === "verified") return false;
  return LOCAL_PREVIEW.test(verification.reason);
}

type TeeMessage = {
  attestation?: { verification?: { status: string; reason: string } } | null;
};

/** Header pill across the transcript. A local preview does not erase a verified LLM reply. */
export function overallTeePhase(messages: readonly TeeMessage[]): TeePill {
  let verified = false;
  let unverified = false;
  let local = false;
  for (const message of messages) {
    const verification = message.attestation?.verification;
    if (!verification) continue;
    if (isLocalPreview(verification)) {
      local = true;
      continue;
    }
    if (verification.status === "verified") verified = true;
    else unverified = true;
  }
  if (unverified) return "unverified";
  if (verified) return "verified";
  if (local) return "local";
  return "idle";
}
