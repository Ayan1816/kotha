import fs from "fs";
import { aegisStatePath, readTextFile, writeJsonFile } from "./aegis-paths";
import { isSampleExecution } from "./budget-math";

export const DEFAULT_CONTRACT_ID = "kotha-vault-1793945609.testnet";
export const FASTNEAR_TESTNET_RPC = "https://test.rpc.fastnear.com";
export const PUBLIC_TESTNET_RPC = "https://rpc.testnet.near.org";
export const DEFAULT_RPC_URL = FASTNEAR_TESTNET_RPC;
export const VIEW_TIMEOUT_MS = 8_000;
export const RPC_FAIL_CACHE_MS = 5_000;
const LOG_FILE = "aegis-vault-executions.json";
const ACTION_TYPES = ["swap", "transfer", "withdraw", "shield", "unshield"] as const;

function vaultOwnerAccount(): string {
  return process.env.NEXT_PUBLIC_OWNER_ID?.trim() || process.env.NEAR_ACCOUNT_ID?.trim() || process.env.OWNER_ID?.trim() || "owner.kotha.testnet";
}

function vaultAgentAccount(): string {
  return process.env.NEAR_INTENTS_AGENT_ID?.trim() || process.env.NEXT_PUBLIC_CONTRACT_ID?.trim() || "agent-kotha-prime.near";
}

export type VerifiedExecution = {
  correlation_id: string;
  agent_id: string;
  action_type: string;
  origin_asset: string;
  destination_asset: string;
  amount_atomic: string;
  usd_amount_cents: string;
  near_ai_chat_id: string;
  tee_signing_address: string;
  request_sha256: string;
  response_sha256: string;
  tee_signature: string;
  timestamp_ns: string;
};

export type VaultInfo = {
  contractId: string;
  rpcUrl: string;
  owner: string;
  agentAccount: string;
  paused: boolean;
  totalExecutions: number;
  source: "chain" | "local" | "merged";
};

export type VerificationCommands = {
  record_execution: string;
  get_execution: string;
};

type LogFile = {
  version: 1;
  executions: VerifiedExecution[];
};

let rpcFailUntil = 0;

export function contractId(): string {
  return process.env.NEXT_PUBLIC_CONTRACT_ID || process.env.NEXT_PUBLIC_NEAR_CONTRACT_ID || DEFAULT_CONTRACT_ID;
}

export function rpcUrl(): string {
  return rpcCandidates()[0] || DEFAULT_RPC_URL;
}

/** Primary testnet RPC, then the other public endpoint. An explicit URL is used alone. */
export function rpcCandidates(explicit?: string): string[] {
  const pinned = explicit?.trim();
  if (pinned) return [pinned];
  const primary = (process.env.NEAR_RPC_URL || DEFAULT_RPC_URL).trim() || DEFAULT_RPC_URL;
  const extras = [FASTNEAR_TESTNET_RPC, PUBLIC_TESTNET_RPC].filter((url) => url !== primary);
  return [primary, ...extras];
}

export async function getVaultInfo(): Promise<VaultInfo> {
  const local = readLog();
  const fallback: VaultInfo = {
    contractId: contractId(),
    rpcUrl: rpcUrl(),
    owner: vaultOwnerAccount(),
    agentAccount: vaultAgentAccount(),
    paused: false,
    totalExecutions: local.executions.length,
    source: "local",
  };
  const chain = await tryChain<[string, string, boolean, number]>("get_vault_info", {});
  if (!chain) return fallback;
  return {
    ...fallback,
    owner: chain[0] || fallback.owner,
    agentAccount: chain[1] || fallback.agentAccount,
    paused: Boolean(chain[2]),
    totalExecutions: Math.max(Number(chain[3]) || 0, local.executions.length),
    source: "chain",
  };
}

export async function findExecution(correlationId: string): Promise<VerifiedExecution | null> {
  const local = readLog().executions.find((row) => row.correlation_id === correlationId);
  if (local) return local;
  const remote = await tryChain<unknown>("get_execution", { correlation_id: correlationId });
  if (remote == null) return null;
  return normalizeExecution(remote);
}

export async function readExecutionRaw(correlationId: string): Promise<string | null> {
  if (Date.now() < rpcFailUntil) return null;
  try {
    return await callViewText("get_execution", { correlation_id: correlationId });
  } catch {
    noteRpcFailure();
    return null;
  }
}

export async function listExecutions(limit = 50): Promise<VerifiedExecution[]> {
  const local = readLog().executions;
  const chain = await tryChain<unknown[]>("list_executions", { from_index: 0, limit });
  const remote = Array.isArray(chain) ? chain.map(normalizeExecution).filter((row): row is VerifiedExecution => row != null) : [];
  return mergeExecutions(remote, local)
    .filter((row) => !isSampleExecution(row))
    .slice(0, limit);
}

export async function recordVerifiedExecution(record: VerifiedExecution): Promise<{
  execution: VerifiedExecution;
  commands: VerificationCommands;
}> {
  const execution = validateExecution(record);
  const log = readLog();
  const index = log.executions.findIndex((row) => row.correlation_id === execution.correlation_id);
  if (index >= 0) log.executions[index] = execution;
  else log.executions.push(execution);
  writeJsonFile(aegisStatePath(LOG_FILE), log);
  return { execution, commands: verificationCommands(execution) };
}

export function verificationCommands(record: VerifiedExecution): VerificationCommands {
  const id = contractId();
  const recordArgs = shellSingleQuote(executionJson(record));
  const readArgs = shellSingleQuote(JSON.stringify({ correlation_id: record.correlation_id }));
  return {
    record_execution: `near contract call-function as-transaction ${id} record_execution json-args ${recordArgs} prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as ${vaultOwnerAccount()} network-config testnet sign-with-keychain send`,
    get_execution: `near contract call-function as-read-only ${id} get_execution json-args ${readArgs} network-config testnet now`,
  };
}

function noteRpcFailure(): void {
  rpcFailUntil = Date.now() + RPC_FAIL_CACHE_MS;
}

async function tryChain<T>(method: string, args: Record<string, unknown>): Promise<T | null> {
  if (Date.now() < rpcFailUntil) return null;
  try {
    return await callView<T>(method, args);
  } catch {
    noteRpcFailure();
    return null;
  }
}

async function callView<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const text = await callViewText(method, args);
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

async function callViewText(method: string, args: Record<string, unknown>, explicitUrl?: string): Promise<string> {
  const urls = rpcCandidates(explicitUrl);
  let lastError: unknown = new Error("NEAR RPC failed.");
  for (const url of urls) {
    try {
      return await callViewTextAt(url, method, args);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("NEAR RPC failed.");
}

async function callViewTextAt(url: string, method: string, args: Record<string, unknown>): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "aegis-vault",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contractId(),
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args), "utf8").toString("base64"),
      },
    }),
    signal: AbortSignal.timeout(VIEW_TIMEOUT_MS),
  });
  const payload = (await response.json()) as {
    error?: { message?: string };
    result?: { result?: number[]; error?: string };
  };
  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message || `NEAR RPC HTTP ${response.status}`);
  }
  if (payload.result?.error) throw new Error(payload.result.error);
  const bytes = payload.result?.result;
  if (!Array.isArray(bytes)) throw new Error(`NEAR view ${method} returned no result bytes.`);
  return Buffer.from(bytes).toString("utf8");
}

function readLog(): LogFile {
  const file = aegisStatePath(LOG_FILE);
  try {
    const parsed = JSON.parse(readTextFile(file)) as LogFile;
    if (parsed?.version === 1 && Array.isArray(parsed.executions)) return parsed;
    throw new Error("invalid vault log");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      try {
        fs.renameSync(file, `${file}.corrupt`);
      } catch {
        // Ignore a missing corrupt backup.
      }
    }
    const fresh = seedLog();
    writeJsonFile(file, fresh);
    return fresh;
  }
}

function seedLog(): LogFile {
  return { version: 1, executions: [] };
}

function validateExecution(record: VerifiedExecution): VerifiedExecution {
  const required: Array<keyof VerifiedExecution> = [
    "correlation_id",
    "agent_id",
    "action_type",
    "origin_asset",
    "destination_asset",
    "amount_atomic",
    "usd_amount_cents",
    "near_ai_chat_id",
    "tee_signing_address",
    "request_sha256",
    "response_sha256",
    "tee_signature",
    "timestamp_ns",
  ];
  for (const field of required) {
    if (typeof record[field] !== "string" || record[field].trim().length === 0) {
      throw new Error(`VerifiedExecution.${field} is required.`);
    }
  }
  if (!(ACTION_TYPES as readonly string[]).includes(record.action_type)) {
    throw new Error(`Invalid action_type: ${record.action_type}`);
  }
  if (!/^\d+$/.test(record.timestamp_ns) || !/^\d+$/.test(record.amount_atomic) || !/^\d+$/.test(record.usd_amount_cents)) {
    throw new Error("amount_atomic, usd_amount_cents, and timestamp_ns must be unsigned integers.");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(record.request_sha256) || !/^[0-9a-fA-F]{64}$/.test(record.response_sha256)) {
    throw new Error("request_sha256 and response_sha256 must be 32-byte hex digests.");
  }
  return {
    correlation_id: record.correlation_id.trim(),
    agent_id: record.agent_id.trim(),
    action_type: record.action_type.trim(),
    origin_asset: record.origin_asset.trim(),
    destination_asset: record.destination_asset.trim(),
    amount_atomic: record.amount_atomic.trim(),
    usd_amount_cents: record.usd_amount_cents.trim(),
    near_ai_chat_id: record.near_ai_chat_id.trim(),
    tee_signing_address: record.tee_signing_address.trim(),
    request_sha256: record.request_sha256.trim().toLowerCase(),
    response_sha256: record.response_sha256.trim().toLowerCase(),
    tee_signature: record.tee_signature.trim(),
    timestamp_ns: record.timestamp_ns.trim(),
  };
}

function normalizeExecution(value: unknown): VerifiedExecution | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<VerifiedExecution> & {
    timestamp_ns?: string | number;
    amount_atomic?: string | number;
    usd_amount_cents?: string | number;
  };
  try {
    return validateExecution({
      correlation_id: String(record.correlation_id ?? ""),
      agent_id: String(record.agent_id ?? ""),
      action_type: String(record.action_type ?? ""),
      origin_asset: String(record.origin_asset ?? ""),
      destination_asset: String(record.destination_asset ?? ""),
      amount_atomic: String(record.amount_atomic ?? ""),
      usd_amount_cents: String(record.usd_amount_cents ?? "0"),
      near_ai_chat_id: String(record.near_ai_chat_id ?? ""),
      tee_signing_address: String(record.tee_signing_address ?? ""),
      request_sha256: String(record.request_sha256 ?? ""),
      response_sha256: String(record.response_sha256 ?? ""),
      tee_signature: String(record.tee_signature ?? ""),
      timestamp_ns: String(record.timestamp_ns ?? ""),
    });
  } catch {
    return null;
  }
}

function mergeExecutions(remote: VerifiedExecution[], local: VerifiedExecution[]): VerifiedExecution[] {
  const byId = new Map<string, VerifiedExecution>();
  for (const row of remote) byId.set(row.correlation_id, row);
  for (const row of local) byId.set(row.correlation_id, row);
  return [...byId.values()].sort((left, right) => {
    const a = BigInt(left.timestamp_ns);
    const b = BigInt(right.timestamp_ns);
    if (a === b) return 0;
    return a < b ? 1 : -1;
  });
}

function executionJson(record: VerifiedExecution): string {
  const payload = {
    ...record,
    timestamp_ns: `__TS_${record.timestamp_ns}__`,
    usd_amount_cents: `__USD_${record.usd_amount_cents}__`,
  };
  return JSON.stringify(payload)
    .replace(`"__TS_${record.timestamp_ns}__"`, record.timestamp_ns)
    .replace(`"__USD_${record.usd_amount_cents}__"`, record.usd_amount_cents);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
