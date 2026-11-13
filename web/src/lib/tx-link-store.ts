import { aegisStatePath, readTextFile, writeJsonFile } from "./aegis-paths";
import { isPlausibleTxHash } from "./wallet-proof";

const FILE = "aegis-tx-links.json";

export type StoredTxLink = {
  transferHash: string;
  proofHash: string;
};

type FileShape = {
  version: 1;
  links: Record<string, StoredTxLink>;
};

/** Sibling of aegis-agent-state.json. Disk on Vercel is a cache, not the source of truth. */
export function readTxLinks(): Record<string, StoredTxLink> {
  try {
    const parsed = JSON.parse(readTextFile(aegisStatePath(FILE))) as Partial<FileShape>;
    if (parsed.version !== 1 || !parsed.links || typeof parsed.links !== "object") return {};
    const links: Record<string, StoredTxLink> = {};
    for (const [id, row] of Object.entries(parsed.links)) {
      if (!id || !row || typeof row !== "object") continue;
      const transferHash = typeof row.transferHash === "string" && isPlausibleTxHash(row.transferHash) ? row.transferHash : "";
      const proofHash = typeof row.proofHash === "string" && isPlausibleTxHash(row.proofHash) ? row.proofHash : "";
      if (!transferHash && !proofHash) continue;
      links[id] = { transferHash, proofHash };
    }
    return links;
  } catch {
    return {};
  }
}

export function writeTxLink(correlationId: string, transferHash: string, proofHash = ""): void {
  const id = correlationId.trim();
  if (!id || id.length > 200) return;
  const transfer = isPlausibleTxHash(transferHash) ? transferHash : "";
  const proof = isPlausibleTxHash(proofHash) ? proofHash : "";
  if (!transfer && !proof) return;
  const links = readTxLinks();
  const prev = links[id];
  links[id] = {
    transferHash: transfer || prev?.transferHash || "",
    proofHash: proof || prev?.proofHash || "",
  };
  writeJsonFile(aegisStatePath(FILE), { version: 1, links } satisfies FileShape);
}
