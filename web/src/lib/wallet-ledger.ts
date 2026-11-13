import type { CardOutcome } from "@/lib/native-transfer";

const KEY = "kotha-wallet-ledger";

export type LedgerEntry = {
  cardId: string;
  correlationId: string;
  transferHash: string;
  proofHash: string;
  amount: string;
  recipient: string;
  proofMissing: boolean;
};

export type WalletLedger = {
  entries: LedgerEntry[];
  executedIds: string[];
  outcomes: Record<string, CardOutcome>;
};

function emptyLedger(): WalletLedger {
  return { entries: [], executedIds: [], outcomes: {} };
}

function asEntry(value: unknown): LedgerEntry | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<LedgerEntry>;
  if (typeof row.correlationId !== "string" || !row.correlationId) return null;
  return {
    cardId: typeof row.cardId === "string" ? row.cardId : "",
    correlationId: row.correlationId,
    transferHash: typeof row.transferHash === "string" ? row.transferHash : "",
    proofHash: typeof row.proofHash === "string" ? row.proofHash : "",
    amount: typeof row.amount === "string" ? row.amount : "",
    recipient: typeof row.recipient === "string" ? row.recipient : "",
    proofMissing: row.proofMissing === true,
  };
}

function asOutcome(value: unknown): CardOutcome | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<CardOutcome>;
  if (row.tone !== "ok" && row.tone !== "warn" && row.tone !== "fail") return null;
  return {
    tone: row.tone,
    text: typeof row.text === "string" ? row.text : undefined,
    transferHash: typeof row.transferHash === "string" ? row.transferHash : undefined,
    proofHash: typeof row.proofHash === "string" ? row.proofHash : undefined,
    faucet: row.faucet === true ? true : undefined,
    amount: typeof row.amount === "string" ? row.amount : undefined,
    recipient: typeof row.recipient === "string" ? row.recipient : undefined,
    proofMissing: row.proofMissing === true ? true : undefined,
    failKey: typeof row.failKey === "string" ? (row.failKey as CardOutcome["failKey"]) : undefined,
  };
}

export function readWalletLedger(): WalletLedger {
  if (typeof window === "undefined") return emptyLedger();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return emptyLedger();
    const parsed = JSON.parse(raw) as Partial<WalletLedger>;
    const entries = Array.isArray(parsed.entries) ? parsed.entries.map(asEntry).filter((row): row is LedgerEntry => row != null) : [];
    const executedIds = Array.isArray(parsed.executedIds) ? parsed.executedIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
    const outcomes: Record<string, CardOutcome> = {};
    if (parsed.outcomes && typeof parsed.outcomes === "object") {
      for (const [id, outcome] of Object.entries(parsed.outcomes)) {
        const next = asOutcome(outcome);
        if (next) outcomes[id] = next;
      }
    }
    return { entries, executedIds, outcomes };
  } catch {
    return emptyLedger();
  }
}

function writeWalletLedger(store: WalletLedger): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // A private window or a full quota must not block the send that already happened.
  }
}

export function persistCardOutcome(cardId: string, outcome: CardOutcome): WalletLedger {
  const store = readWalletLedger();
  const next = { ...store, outcomes: { ...store.outcomes, [cardId]: outcome } };
  writeWalletLedger(next);
  return next;
}

export function rememberWalletSend(entry: LedgerEntry, outcome: CardOutcome): WalletLedger {
  const store = readWalletLedger();
  const entries = store.entries.filter((row) => row.correlationId !== entry.correlationId && row.cardId !== entry.cardId);
  entries.push(entry);
  const executedIds = store.executedIds.includes(entry.cardId) ? store.executedIds : [...store.executedIds, entry.cardId];
  const next: WalletLedger = {
    entries: entries.slice(-40),
    executedIds: executedIds.filter((id) => id.length > 0).slice(-80),
    outcomes: { ...store.outcomes, [entry.cardId]: outcome },
  };
  writeWalletLedger(next);
  return next;
}

export function mergeTransferHashes<T extends { correlation_id: string; tx_hash?: string; proof_tx_hash?: string }>(rows: T[], entries: readonly LedgerEntry[]): T[] {
  if (entries.length === 0) return rows;
  const byId = new Map(entries.map((entry) => [entry.correlationId, entry]));
  return rows.map((row) => {
    const found = byId.get(row.correlation_id);
    if (!found) return row;
    return {
      ...row,
      tx_hash: found.transferHash || row.tx_hash,
      proof_tx_hash: found.proofHash || row.proof_tx_hash,
    };
  });
}
