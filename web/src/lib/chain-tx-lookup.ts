import { readTxLinks, writeTxLink } from "./tx-link-store";
import { DEFAULT_CONTRACT_ID, isPlausibleTxHash } from "./wallet-proof";

/** Closest earlier transfer must sit inside this many blocks, or inside the time window. */
export const PAIR_BLOCK_WINDOW = 30;
export const PAIR_TIME_WINDOW_MS = 60_000;

const NEARBLOCKS = "https://api-testnet.nearblocks.io/v3";
const BROWSER_UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";
const SUCCESS_TTL_MS = 45_000;
const FAIL_COOLDOWN_MS = 20_000;
const DETAIL_CAP = 8;

export type PairInput = {
  hash: string;
  signer: string;
  blockHeight: number;
  timestampMs?: number;
  action: "TRANSFER" | "record_execution";
  deposit?: string;
  correlationId?: string;
  amountAtomic?: string;
};

export type PairedHash = {
  txHash: string;
  proofHash: string;
};

type ExecutionRow = {
  correlation_id: string;
  agent_id: string;
  tx_hash?: string;
  proof_tx_hash?: string;
};

const memory = new Map<string, PairedHash>();
let memoryAt = 0;
let failUntil = 0;
let inflight: Promise<Record<string, PairedHash>> | null = null;

/**
 * Pair each record_execution with the closest earlier TRANSFER by the same signer.
 * The transfer's block is <= the record, the deposit matches amount_atomic, and the
 * gap is within 30 blocks or 60 seconds. A later transfer cannot take an earlier record.
 */
export function pairTransferHashes(rows: readonly PairInput[]): Record<string, PairedHash> {
  const records = rows
    .filter((row) => row.action === "record_execution" && row.correlationId && row.amountAtomic && isPlausibleTxHash(row.hash))
    .slice()
    .sort((left, right) => left.blockHeight - right.blockHeight || (left.timestampMs ?? 0) - (right.timestampMs ?? 0));
  const transfers = rows.filter((row) => row.action === "TRANSFER" && row.deposit && isPlausibleTxHash(row.hash));
  const used = new Set<string>();
  const paired: Record<string, PairedHash> = {};
  for (const record of records) {
    let best: PairInput | null = null;
    for (const transfer of transfers) {
      if (used.has(transfer.hash)) continue;
      if (transfer.signer !== record.signer) continue;
      if (transfer.deposit !== record.amountAtomic) continue;
      if (transfer.blockHeight > record.blockHeight) continue;
      const blockGap = record.blockHeight - transfer.blockHeight;
      const timeGap = record.timestampMs != null && transfer.timestampMs != null ? record.timestampMs - transfer.timestampMs : null;
      const inBlocks = blockGap <= PAIR_BLOCK_WINDOW;
      const inTime = timeGap != null && timeGap >= 0 && timeGap <= PAIR_TIME_WINDOW_MS;
      if (!inBlocks && !inTime) continue;
      if (!best || transfer.blockHeight > best.blockHeight) best = transfer;
    }
    if (!best || !record.correlationId) continue;
    used.add(best.hash);
    paired[record.correlationId] = { txHash: best.hash, proofHash: record.hash };
  }
  return paired;
}

/** Build pair inputs from a Nearblocks account payload plus record_execution detail bodies. */
export function rowsFromNearblocks(accountPayload: unknown, detailsByHash: Record<string, unknown> = {}): PairInput[] {
  const rows: PairInput[] = [];
  for (const txn of txnList(accountPayload)) {
    const row = asRecord(txn);
    if (!row) continue;
    const hash = stringField(row, ["transaction_hash", "hash", "transactionHash"]);
    const signer = stringField(row, ["signer_account_id", "predecessor_account_id", "signer"]);
    const blockHeight = numberField(row, ["block_height", "blockHeight"]);
    if (!hash || !signer || blockHeight == null || !isPlausibleTxHash(hash)) continue;
    const timestampMs = timestampMsField(row);
    if (isRecordCall(row)) {
      const detail = correlationFromRecordTxn(detailsByHash[hash]);
      rows.push({
        hash,
        signer,
        blockHeight,
        timestampMs,
        action: "record_execution",
        correlationId: detail?.correlationId,
        amountAtomic: detail?.amountAtomic,
      });
      continue;
    }
    if (!isTransfer(row)) continue;
    const deposit = depositOf(row);
    if (!deposit) continue;
    rows.push({ hash, signer, blockHeight, timestampMs, action: "TRANSFER", deposit });
  }
  return rows;
}

export function pairNearblocksPayloads(accountPayload: unknown, detailsByHash: Record<string, unknown> = {}): Record<string, PairedHash> {
  return pairTransferHashes(rowsFromNearblocks(accountPayload, detailsByHash));
}

export function correlationFromRecordTxn(body: unknown): { correlationId: string; amountAtomic: string } | null {
  const data = unwrapData(body);
  const actions = Array.isArray(data.actions) ? data.actions : [];
  for (const action of actions) {
    const found = digExecution(action);
    if (found) return found;
  }
  return digExecution(data);
}

/** Fill transfer hashes that the receipt store does not have. Nearblocks failure leaves the cell blank. */
export async function fillExecutionTxHashes<T extends ExecutionRow>(rows: T[], fetchImpl: typeof fetch = fetch): Promise<T[]> {
  const cached = readTxLinks();
  for (const [id, link] of Object.entries(cached)) {
    if (link.transferHash) memory.set(id, { txHash: link.transferHash, proofHash: link.proofHash });
  }
  let next = applyPairs(rows, memory);
  const missing = next.filter((row) => !row.tx_hash);
  if (missing.length === 0) return next;
  const now = Date.now();
  if ((memoryAt && now - memoryAt < SUCCESS_TTL_MS) || now < failUntil) return next;
  try {
    const agents = [...new Set(missing.map((row) => row.agent_id.trim()).filter(Boolean))].slice(0, 3);
    const wanted = new Set(missing.map((row) => row.correlation_id));
    const paired = await loadPairs(agents, wanted, fetchImpl);
    let wrote = false;
    for (const [id, link] of Object.entries(paired)) {
      if (!wanted.has(id) || !isPlausibleTxHash(link.txHash)) continue;
      memory.set(id, link);
      writeTxLink(id, link.txHash, link.proofHash);
      wrote = true;
    }
    if (wrote) memoryAt = Date.now();
    else failUntil = Date.now() + FAIL_COOLDOWN_MS;
    next = applyPairs(rows, memory);
  } catch {
    failUntil = Date.now() + FAIL_COOLDOWN_MS;
  }
  return next;
}

async function loadPairs(agents: string[], wanted: Set<string>, fetchImpl: typeof fetch): Promise<Record<string, PairedHash>> {
  if (inflight) return inflight;
  inflight = fetchPairs(agents, wanted, fetchImpl).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function fetchPairs(agents: string[], wanted: Set<string>, fetchImpl: typeof fetch): Promise<Record<string, PairedHash>> {
  const combined: PairInput[] = [];
  for (const agent of agents) combined.push(...(await listAccount(agent, fetchImpl)));
  await hydrateRecords(combined, fetchImpl);
  let paired = pairTransferHashes(combined);
  if ([...wanted].every((id) => paired[id]?.txHash)) return paired;
  const vaultRows = await listAccount(DEFAULT_CONTRACT_ID, fetchImpl);
  combined.push(...vaultRows);
  await hydrateRecords(combined, fetchImpl);
  paired = pairTransferHashes(combined);
  return paired;
}

async function listAccount(account: string, fetchImpl: typeof fetch): Promise<PairInput[]> {
  const url = `${NEARBLOCKS}/accounts/${encodeURIComponent(account)}/txns?per_page=25&order=desc`;
  const body = await getJson(url, fetchImpl);
  return rowsFromNearblocks(body);
}

async function hydrateRecords(rows: PairInput[], fetchImpl: typeof fetch): Promise<void> {
  const pending = rows
    .filter((row) => row.action === "record_execution" && !row.correlationId)
    .sort((left, right) => right.blockHeight - left.blockHeight)
    .slice(0, DETAIL_CAP);
  await Promise.all(
    pending.map(async (row) => {
      try {
        const detail = correlationFromRecordTxn(await getJson(`${NEARBLOCKS}/txns/${encodeURIComponent(row.hash)}`, fetchImpl));
        if (!detail) return;
        row.correlationId = detail.correlationId;
        row.amountAtomic = detail.amountAtomic;
      } catch {
        // This record stays unpaired. The cell stays blank.
      }
    }),
  );
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": BROWSER_UA },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`nearblocks ${response.status}`);
  return response.json();
}

function applyPairs<T extends ExecutionRow>(rows: T[], links: Map<string, PairedHash>): T[] {
  return rows.map((row) => {
    const found = links.get(row.correlation_id);
    if (!found) return row;
    const tx = row.tx_hash || (isPlausibleTxHash(found.txHash) ? found.txHash : "");
    const proof = row.proof_tx_hash || (isPlausibleTxHash(found.proofHash) ? found.proofHash : "");
    if (!tx && !proof) return row;
    return { ...row, tx_hash: tx || undefined, proof_tx_hash: proof || undefined };
  });
}

function txnList(body: unknown): unknown[] {
  const row = asRecord(body);
  if (!row) return [];
  if (Array.isArray(row.txns)) return row.txns;
  const data = asRecord(row.data);
  if (data && Array.isArray(data.txns)) return data.txns;
  if (Array.isArray(row.data)) return row.data;
  return [];
}

function unwrapData(body: unknown): Record<string, unknown> {
  const row = asRecord(body);
  if (!row) return {};
  return asRecord(row.data) ?? row;
}

function digExecution(value: unknown): { correlationId: string; amountAtomic: string } | null {
  const row = asRecord(value);
  if (!row) return null;
  const args = typeof row.args === "string" ? parseJson(row.args) : row.args;
  const bag = asRecord(args) ?? row;
  const json = asRecord(bag.args_json) ?? bag;
  const execution = asRecord(json.execution) ?? json;
  const correlationId = typeof execution.correlation_id === "string" ? execution.correlation_id : "";
  if (!correlationId) return null;
  const amountAtomic = execution.amount_atomic == null ? "" : String(execution.amount_atomic);
  return { correlationId, amountAtomic };
}

function isRecordCall(txn: Record<string, unknown>): boolean {
  return actionsOf(txn).some((action) => {
    const method = stringField(action, ["method", "method_name"]);
    const kind = stringField(action, ["action", "type"]);
    return method === "record_execution" || kind.includes("record_execution");
  });
}

function isTransfer(txn: Record<string, unknown>): boolean {
  return actionsOf(txn).some((action) => stringField(action, ["action", "type"]).toUpperCase() === "TRANSFER");
}

function depositOf(txn: Record<string, unknown>): string {
  const agg = asRecord(txn.actions_agg);
  if (agg && agg.deposit != null && String(agg.deposit) !== "0") return String(agg.deposit);
  for (const action of actionsOf(txn)) {
    if (action.deposit != null && String(action.deposit) !== "0") return String(action.deposit);
  }
  return "";
}

function actionsOf(txn: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(txn.actions)) return [];
  return txn.actions.map(asRecord).filter((row): row is Record<string, unknown> => row != null);
}

function stringField(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function numberField(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  const block = asRecord(row.block);
  if (block) return numberField(block, ["block_height", "height"]);
  return null;
}

function timestampMsField(row: Record<string, unknown>): number | undefined {
  const raw = row.block_timestamp ?? row.blockTimestamp;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  if (parsed > 1e14) return Math.round(parsed / 1e6);
  return parsed;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
