import { isPlausibleTxHash } from "./wallet-proof";

const HASH_PARAMS = ["transactionHashes", "transactionsHashes", "txHashes"] as const;

export type WalletReturnHashes = {
  transferHash: string;
  proofHash: string;
};

/** Batch order is Transfer, then record_execution. One hash is the transfer. */
export function parseWalletReturnHashes(search: string, hash: string): WalletReturnHashes {
  const found: string[] = [];
  collect(search, found);
  collect(hash, found);
  return { transferHash: found[0] || "", proofHash: found[1] || "" };
}

export function stripWalletReturnParams(href: string): string {
  const url = new URL(href, "https://kotha.local");
  for (const key of HASH_PARAMS) url.searchParams.delete(key);
  const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : "");
  let touched = false;
  for (const key of HASH_PARAMS) {
    if (!hashParams.has(key)) continue;
    hashParams.delete(key);
    touched = true;
  }
  if (touched) {
    const next = hashParams.toString();
    url.hash = next ? `#${next}` : "";
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function collect(raw: string, found: string[]): void {
  const query = raw.startsWith("?") || raw.startsWith("#") ? raw.slice(1) : raw;
  if (!query.includes("=")) return;
  const params = new URLSearchParams(query);
  for (const key of HASH_PARAMS) {
    const value = params.get(key);
    if (!value) continue;
    for (const part of value.split(",")) {
      const hash = part.trim();
      if (!isPlausibleTxHash(hash) || found.includes(hash)) continue;
      found.push(hash);
    }
  }
}
