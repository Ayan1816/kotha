import {
  AgentApiError,
  AgentApiRequestError,
  createAgentApi,
  createGrantCredential,
  createIdempotencyKey,
  grantCommitment,
  verifyOperationProof,
  type AgentApi,
  type GenerateIntentResponse,
  type NetworkView,
  type Policy,
  type PolicyAction,
  type QuoteResponse,
  type StatusResponse,
  type TokenView,
} from "@near-intents-agent-api/sdk";
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from "crypto";
import fs from "fs";
import { aegisStatePath, readTextFile, writeJsonFile } from "./aegis-paths";
import { projectSpend, roundUsd, sumTodayReceiptUsd, utcDayStamp, ZERO_AMOUNT_WARNING } from "./budget-math";
import { listReceiptRecords } from "./receipt-store";
import { readTransferFields } from "./transfer-parse";

export const AGENT_ID = "agent-kotha-prime.near";
export const OWNER_ACCOUNT = "owner.kotha.testnet";
export const PUBLIC_SHARD = "intents.near";
export const CONFIDENTIAL_SHARD = "intents.far";

const STATE_FILE = "aegis-agent-state.json";
const OPS_KEY_FILE = "aegis-ops-key.json";
const NAA_KEY = /^naa_[A-Za-z0-9_-]{43}$/;
const NGT_TOKEN = /^ngt_[A-Za-z0-9_-]{43}$/;
const SEED_GRANT_TOKEN = "ngt_live_9f8a7c2b41d0e8f14a6b90c3d5e7f8a1b2e41c";
const READ_TIMEOUT_MS = 4000;
const WRITE_TIMEOUT_MS = 8000;
const PUBLIC_FAIL_COOLDOWN_MS = 30_000;

export const INTENT_ACTIONS = ["swap", "transfer", "withdraw", "shield", "unshield"] as const;
export type IntentAction = (typeof INTENT_ACTIONS)[number];

export const KOTHA_ASSETS = [
  { asset_id: "nep141:wrap.near", symbol: "wNEAR", decimals: 24, blockchain: "near", price: 3.42 },
  { asset_id: "nep141:usdt.tether-token.near", symbol: "USDT", decimals: 6, blockchain: "near", price: 1 },
  { asset_id: "nep141:usdc.near", symbol: "USDC", decimals: 6, blockchain: "near", price: 0.9998 },
] as const;

const ASSET_ALIASES: Record<string, string> = {
  wnear: "nep141:wrap.near",
  "wrap.near": "nep141:wrap.near",
  "wrapped near": "nep141:wrap.near",
  near: "nep141:wrap.near",
  usdt: "nep141:usdt.tether-token.near",
  tether: "nep141:usdt.tether-token.near",
  usdc: "nep141:usdc.near",
};

export type ActivePolicy = {
  dailyBudgetUsd: number;
  spentTodayUsd: number;
  perTxCapUsd: number;
  allowedActions: IntentAction[];
  allowedAssets: string[];
  confidentialShardEnabled: boolean;
  frozen: boolean;
};

export type PolicyPatch = {
  dailyBudgetUsd?: number;
  perTxCapUsd?: number;
  allowedActions?: IntentAction[];
  allowedAssets?: string[];
  confidentialShardEnabled?: boolean;
};

export type AegisIntent = {
  action: IntentAction;
  origin_asset: string;
  destination_asset: string;
  amount: string;
  amount_usd_estimate: number;
  max_slippage_bps: number;
  recipient: string;
  chain: string;
  confidential: boolean;
};

export type DryRunPreview = {
  allowed: boolean;
  quote: {
    expectedAmountOut: string;
    rate: string;
    feeUsd: number;
    slippageBps: number;
    route: string;
    shard: "intents.near" | "intents.far";
  };
  budgetImpact: {
    currentSpentUsd: number;
    txUsd: number;
    projectedSpentUsd: number;
    dailyLimitUsd: number;
    utilizationPct: number;
  };
  warnings: string[];
};

export type TokenMetadata = {
  asset_id: string;
  symbol: string;
  decimals: number;
  blockchain: string;
  price: number | null;
  price_updated_at: string | null;
  price_expires_at: string | null;
};

export type NetworkSnapshot = {
  network: string;
  contract_id: string;
  confidential_contract_id: string;
  supported_owner_types: string[];
  status: {
    overall: "operational" | "degraded" | "down" | "unknown";
    checked_at: string | null;
    components: Array<{
      id: string;
      status: "operational" | "degraded" | "down" | "unknown";
      reason: string | null;
      affects: string[];
    }>;
  };
  source: "live" | "fallback";
};

export type TokenBalanceView = {
  asset_id: string;
  symbol: string;
  decimals: number;
  balance: string;
  balance_raw: string;
  price_usd: number;
  value_usd: number;
  shard: "intents.near" | "intents.far";
};

export type PublicGrant = {
  grantId: string;
  tokenPreview: string;
  commitmentHash: string;
  issuedAt: string;
  expiresAt: string;
  revoked: boolean;
  active: boolean;
  label: string;
};

export type AgentStateView = {
  agent: {
    id: string;
    name: string;
    ownerAccount: string;
    status: "ACTIVE";
    source: "local-ledger" | "remote";
  };
  balances: {
    public: TokenBalanceView[];
    confidential: TokenBalanceView[];
    shards: { public: "intents.near"; confidential: "intents.far" };
  };
  policy: ActivePolicy;
  grant: PublicGrant;
  frozen: boolean;
};

export type TeeProofInput = {
  chatId?: string;
  near_ai_chat_id?: string;
  requestSha256?: string;
  request_sha256?: string;
  responseSha256?: string;
  response_sha256?: string;
  signature?: string;
  tee_signature?: string;
  signing_address?: string;
  tee_signing_address?: string;
  signingAddress?: string;
  verificationStatus?: string;
};

export type ExecutionResult = {
  allowed: true;
  executionSource: "remote" | "local-fallback";
  correlation_id: string;
  agent_id: string;
  action_type: IntentAction;
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
  idempotency_key: string;
  proof: {
    correlation_id: string;
    merkle_root: string;
    signature: string;
    signing_address: string;
    verified: boolean;
  };
  remote_status: string | null;
  preview: DryRunPreview;
};

type PersistedGrant = {
  grantId: string;
  token: string;
  tokenPreview: string;
  commitmentHash: string;
  issuedAt: string;
  expiresAt: string;
  revoked: boolean;
  label: string;
};

type PersistedState = {
  version: 1;
  agentId: string;
  agentName: string;
  ownerAccount: string;
  policyRevision: number;
  budgetDay: string;
  policy: ActivePolicy;
  grant: PersistedGrant;
  balances: {
    public: Record<string, string>;
    confidential: Record<string, string>;
  };
  prices: Record<string, number>;
};

type AssetMeta = {
  asset_id: string;
  symbol: string;
  decimals: number;
  blockchain: string;
  price: number;
};

export type BalanceBook = {
  public: Record<string, bigint>;
  confidential: Record<string, bigint>;
  prices: Record<string, number>;
};

type Notional = {
  human: string;
  humanNumber: number;
  atomic: bigint;
  usd: number;
};

type OpsKey = {
  privateKeyPem: string;
  publicKeyPem: string;
  signingAddress: string;
};

export class AgentOperationError extends Error {
  readonly code: string;
  readonly status: number;
  readonly preview?: DryRunPreview;

  constructor(code: string, message: string, status = 400, preview?: DryRunPreview) {
    super(message);
    this.name = "AgentOperationError";
    this.code = code;
    this.status = status;
    this.preview = preview;
  }
}

let queue: Promise<void> = Promise.resolve();
let publicFailUntil = 0;
let catalogCache: { at: number; network: NetworkSnapshot; tokens: TokenMetadata[] } | null = null;

function withState<T>(mutator: (state: PersistedState) => Promise<T> | T): Promise<T> {
  const run = queue.then(async () => {
    const state = loadState();
    return mutator(state);
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function stateFile(): string {
  return aegisStatePath(STATE_FILE);
}

function loadState(): PersistedState {
  const file = stateFile();
  try {
    const parsed = JSON.parse(readTextFile(file)) as PersistedState;
    if (parsed?.version !== 1 || !parsed.policy || !parsed.grant || !parsed.balances) {
      throw new Error("invalid agent state");
    }
    return stripSeedBalances(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      try {
        fs.renameSync(file, `${file}.corrupt`);
      } catch {
        // The corrupt file may already be gone.
      }
    }
    const fresh = createDefaultState();
    writeJsonFile(file, fresh);
    return fresh;
  }
}

function saveState(state: PersistedState): void {
  writeJsonFile(stateFile(), state);
}

function createDefaultState(): PersistedState {
  const commitmentHash = grantCommitment(SEED_GRANT_TOKEN);
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
  return {
    version: 1,
    agentId: process.env.NEAR_INTENTS_AGENT_ID || AGENT_ID,
    agentName: "Kotha",
    ownerAccount: process.env.NEAR_INTENTS_OWNER_ACCOUNT || OWNER_ACCOUNT,
    policyRevision: 1,
    budgetDay: utcDay(),
    policy: defaultPolicy(),
    grant: {
      grantId: `grant_${commitmentHash.slice(0, 16)}`,
      token: SEED_GRANT_TOKEN,
      tokenPreview: previewGrantToken(SEED_GRANT_TOKEN),
      commitmentHash,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      revoked: false,
      label: "Kotha session",
    },
    balances: {
      public: {},
      confidential: {},
    },
    prices: Object.fromEntries(KOTHA_ASSETS.map((asset) => [asset.asset_id, asset.price])),
  };
}

function sameBalanceMap(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return rightKeys.every((key) => left[key] === right[key]);
}

/** Drop the old demo vault so a persisted file cannot put fake numbers back into the prompt. */
function stripSeedBalances(state: PersistedState): PersistedState {
  const seedPublic = {
    "nep141:wrap.near": humanToAtomic("6.25", 24).toString(),
    "nep141:usdt.tether-token.near": humanToAtomic("420", 6).toString(),
    "nep141:usdc.near": humanToAtomic("75.5", 6).toString(),
  };
  const seedConfidential = {
    "nep141:wrap.near": humanToAtomic("0.4", 24).toString(),
    "nep141:usdt.tether-token.near": humanToAtomic("18", 6).toString(),
    "nep141:usdc.near": humanToAtomic("30", 6).toString(),
  };
  if (sameBalanceMap(state.balances.public, seedPublic) && sameBalanceMap(state.balances.confidential, seedConfidential)) {
    state.balances = { public: {}, confidential: {} };
  }
  return state;
}

export function defaultPolicy(): ActivePolicy {
  return {
    dailyBudgetUsd: 100,
    spentTodayUsd: 0,
    perTxCapUsd: 50,
    allowedActions: [...INTENT_ACTIONS],
    allowedAssets: KOTHA_ASSETS.map((asset) => asset.asset_id),
    confidentialShardEnabled: true,
    frozen: false,
  };
}

export function previewGrantToken(token: string): string {
  if (token.length <= 17) return token;
  return `${token.slice(0, 13)}...${token.slice(-4)}`;
}

export function canonicalAsset(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("nep141:") || trimmed.startsWith("nep245:")) return trimmed;
  return ASSET_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

export function assetMeta(assetId: string): AssetMeta {
  const canonical = canonicalAsset(assetId);
  const known = KOTHA_ASSETS.find((asset) => asset.asset_id === canonical);
  if (known) return { ...known };
  return {
    asset_id: canonical || assetId,
    symbol: assetId || "UNKNOWN",
    decimals: 18,
    blockchain: "near",
    price: 1,
  };
}

export function humanToAtomic(human: string, decimals: number): bigint {
  const trimmed = human.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new AgentOperationError("invalid_amount", `Invalid amount: ${human}`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  const fracDigits = `${frac}${"0".repeat(decimals)}`.slice(0, decimals);
  const digits = `${whole}${fracDigits}`.replace(/^0+/, "") || "0";
  return BigInt(digits);
}

export function atomicToHuman(atomic: bigint, decimals: number): string {
  const negative = atomic < BigInt(0);
  const value = (negative ? -atomic : atomic).toString().padStart(decimals + 1, "0");
  const whole = value.slice(0, value.length - decimals);
  const frac = value.slice(value.length - decimals).replace(/0+$/, "");
  const text = frac.length > 0 ? `${whole}.${frac}` : whole;
  return negative ? `-${text}` : text;
}

export function coerceIntent(value: unknown): AegisIntent | null {
  const record = asRecord(value);
  if (!record) return null;
  const action = record.action;
  if (!isAction(action)) return null;
  const fields = readTransferFields(record, "");
  const origin = canonicalAsset(stringValue(record.origin_asset)) || canonicalAsset(fields.token);
  const destinationRaw = stringValue(record.destination_asset);
  const destination = canonicalAsset(destinationRaw || origin || fields.token);
  return {
    action,
    origin_asset: origin,
    destination_asset: destination || origin,
    amount: fields.amount || "0",
    amount_usd_estimate: finiteNumber(record.amount_usd_estimate, 0),
    max_slippage_bps: finiteNumber(record.max_slippage_bps, action === "swap" ? 50 : 0),
    recipient: fields.recipient,
    chain: stringValue(record.chain) || "near",
    confidential: Boolean(record.confidential) || action === "shield",
  };
}

export function normalizePolicyContext(ctx: unknown): ActivePolicy {
  const defaults = defaultPolicy();
  const root = asRecord(ctx) ?? {};
  const policy = asRecord(root.policy) ?? root;
  const actionsRaw = Array.isArray(policy.allowedActions)
    ? policy.allowedActions
    : Array.isArray(policy.actions)
      ? policy.actions
      : defaults.allowedActions;
  const allowedActions = actionsRaw.filter(isAction);
  const assetsSource = Array.isArray(policy.allowedAssets)
    ? policy.allowedAssets
    : Array.isArray(policy.assets)
      ? policy.assets
      : defaults.allowedAssets;
  const allowedAssets = assetsSource
    .filter((item): item is string => typeof item === "string")
    .map(canonicalAsset)
    .filter((item) => item.length > 0);
  const usage = asRecord(policy.usage);
  const usageBudget = asRecord(usage?.budget);
  const usageDaily = asRecord(usageBudget?.daily);
  const budget = asRecord(policy.budget);
  return {
    dailyBudgetUsd: Math.max(0, finiteNumber(policy.dailyBudgetUsd ?? budget?.daily_usd, defaults.dailyBudgetUsd)),
    spentTodayUsd: Math.max(
      0,
      finiteNumber(policy.spentTodayUsd ?? usageDaily?.spent_usd, defaults.spentTodayUsd),
    ),
    perTxCapUsd: Math.max(0, finiteNumber(policy.perTxCapUsd, defaults.perTxCapUsd)),
    allowedActions: allowedActions.length > 0 ? allowedActions : defaults.allowedActions,
    allowedAssets: allowedAssets.length > 0 ? allowedAssets : defaults.allowedAssets,
    confidentialShardEnabled: booleanValue(
      policy.confidentialShardEnabled ?? policy.confidential,
      defaults.confidentialShardEnabled,
    ),
    frozen: booleanValue(policy.frozen, defaults.frozen),
  };
}

export function normalizeBalancesContext(ctx: unknown): BalanceBook {
  if (ctx == null) return defaultBook();
  const root = asRecord(ctx) ?? {};
  const bag = asRecord(root.balances) ?? root;
  const explicit =
    Array.isArray(bag.public) ||
    Array.isArray(bag.confidential) ||
    isAtomicMap(bag.public) ||
    isAtomicMap(bag.confidential);
  if (!explicit) return defaultBook();
  const book: BalanceBook = { public: {}, confidential: {}, prices: { ...defaultPrices() } };
  ingestBalanceSide(book, bag.public, "public");
  ingestBalanceSide(book, bag.confidential, "confidential");
  const prices = asRecord(bag.prices) ?? asRecord(root.prices);
  if (prices) {
    for (const [asset, price] of Object.entries(prices)) {
      const numeric = finiteNumber(price, Number.NaN);
      if (Number.isFinite(numeric) && numeric > 0) book.prices[canonicalAsset(asset)] = numeric;
    }
  }
  return book;
}

export function previewIntent(intent: AegisIntent, policy: ActivePolicy, balances: BalanceBook): DryRunPreview {
  const warnings: string[] = [];
  const origin = assetMeta(intent.origin_asset);
  const destination = assetMeta(intent.destination_asset || intent.origin_asset);
  const priceIn = balances.prices[origin.asset_id] ?? origin.price;
  const priceOut = balances.prices[destination.asset_id] ?? destination.price;
  const notional = resolveNotional(intent, origin, priceIn);
  const spend = projectSpend(policy.spentTodayUsd, notional.usd);
  const { currentSpentUsd, txUsd, projectedSpentUsd: projected } = spend;
  const daily = policy.dailyBudgetUsd;
  const utilizationPct = daily > 0 ? round1((projected / daily) * 100) : 0;
  const slippageBps =
    intent.action === "swap"
      ? clamp(intent.max_slippage_bps > 0 ? intent.max_slippage_bps : 50, 1, 1000)
      : clamp(intent.max_slippage_bps, 0, 1000);

  let expectedOut = notional.humanNumber;
  let rate = 1;
  let feeUsd = 0;
  if (intent.action === "swap") {
    feeUsd = round2(txUsd * 0.003);
    const outUsd = Math.max(0, notional.usd - feeUsd);
    expectedOut = priceOut > 0 ? outUsd / priceOut : 0;
    rate = notional.humanNumber > 0 ? expectedOut / notional.humanNumber : 0;
  } else if (intent.action === "withdraw") {
    feeUsd = round2(Math.max(txUsd > 0 ? 0.05 : 0, txUsd * 0.0015));
  }

  const quoteShard: "intents.near" | "intents.far" =
    intent.action === "unshield"
      ? "intents.near"
      : intent.action === "shield" || intent.confidential
        ? "intents.far"
        : "intents.near";

  let allowed = true;
  if (policy.frozen) {
    allowed = false;
    warnings.push("Emergency freeze is active. The owner kill-switch blocks every agent execution.");
  }
  if (!policy.allowedActions.includes(intent.action)) {
    allowed = false;
    warnings.push(`Action ${intent.action} is not in the owner allow-list.`);
  }
  if (origin.asset_id && !policy.allowedAssets.includes(origin.asset_id)) {
    allowed = false;
    warnings.push(`Asset ${origin.symbol} is not in the owner asset allow-list.`);
  }
  if (intent.action === "swap" && destination.asset_id && !policy.allowedAssets.includes(destination.asset_id)) {
    allowed = false;
    warnings.push(`Destination asset ${destination.symbol} is not in the owner asset allow-list.`);
  }
  if ((intent.action === "shield" || intent.action === "unshield" || intent.confidential) && !policy.confidentialShardEnabled) {
    allowed = false;
    warnings.push("Confidential shard intents.far is disabled by owner policy.");
  }
  if ((intent.action === "transfer" || intent.action === "withdraw") && intent.recipient.trim().length === 0) {
    allowed = false;
    warnings.push("A recipient is required for this action.");
  }
  if (notional.atomic <= BigInt(0)) {
    allowed = false;
    warnings.push(ZERO_AMOUNT_WARNING);
  }

  const spendShard: "public" | "confidential" =
    intent.action === "shield" ? "public" : intent.action === "unshield" || intent.confidential ? "confidential" : "public";
  const bookEmpty = Object.keys(balances.public).length === 0 && Object.keys(balances.confidential).length === 0;
  const listed = Object.prototype.hasOwnProperty.call(balances[spendShard], origin.asset_id);
  if (!listed && bookEmpty) {
    allowed = false;
    warnings.push("BALANCE_UNAVAILABLE");
  } else {
    const available = balances[spendShard][origin.asset_id] ?? BigInt(0);
    if (notional.atomic > available) {
      allowed = false;
      warnings.push(
        `Insufficient ${spendShard === "confidential" ? "intents.far" : "intents.near"} balance for ${origin.symbol}: available ${atomicToHuman(available, origin.decimals)}, required ${notional.human}.`,
      );
    }
  }
  if (txUsd > policy.perTxCapUsd + 1e-9) {
    allowed = false;
    warnings.push(
      `PROHORI_PER_TX_LIMIT_EXCEEDED: this ${intent.action} is $${txUsd.toFixed(2)} and the on-chain per-transaction cap is $${policy.perTxCapUsd.toFixed(2)}.`,
    );
  }
  if (projected > daily + 1e-9) {
    allowed = false;
    warnings.push(
      `PROHORI_DAILY_BUDGET_EXCEEDED: spent today is $${currentSpentUsd.toFixed(2)}, this ${intent.action} is $${txUsd.toFixed(2)}, projected $${projected.toFixed(2)} of the $${daily.toFixed(2)} daily limit.`,
    );
  }
  if (allowed && daily > 0 && projected / daily >= 0.8) {
    warnings.push(
      `Daily budget utilization would reach ${utilizationPct.toFixed(1)}% ($${projected.toFixed(2)} of $${daily.toFixed(2)}).`,
    );
  }

  return {
    allowed,
    quote: {
      expectedAmountOut: formatHuman(expectedOut, destination.decimals),
      rate: formatRate(rate),
      feeUsd,
      slippageBps,
      route: describeRoute(intent, origin.symbol, destination.symbol, quoteShard),
      shard: quoteShard,
    },
    budgetImpact: {
      currentSpentUsd,
      txUsd,
      projectedSpentUsd: projected,
      dailyLimitUsd: round2(daily),
      utilizationPct,
    },
    warnings,
  };
}

export async function getNetworkAndTokens(): Promise<{
  network: NetworkSnapshot;
  tokens: TokenMetadata[];
  source: "live" | "fallback";
}> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.at < 60_000) {
    return { network: catalogCache.network, tokens: catalogCache.tokens, source: "live" };
  }
  if (now < publicFailUntil) return fallbackCatalog();
  try {
    const [networkRaw, tokenRaw] = await Promise.all([
      publicGet<NetworkView>("/v1/network"),
      publicGet<{ data: TokenView[] } | TokenView[]>("/v1/tokens"),
    ]);
    const liveTokens = (Array.isArray(tokenRaw) ? tokenRaw : tokenRaw.data).map(toTokenMetadata);
    const merged = mergeFallbackTokens(liveTokens);
    const network = mapNetwork(networkRaw);
    catalogCache = { at: now, network, tokens: merged };
    await rememberPrices(merged);
    return { network, tokens: merged, source: "live" };
  } catch {
    publicFailUntil = Date.now() + PUBLIC_FAIL_COOLDOWN_MS;
    return fallbackCatalog();
  }
}

export async function getAgentState(): Promise<AgentStateView> {
  return withState(async (state) => {
    ensureBudgetWindow(state);
    const source = await hydrateRemote(state);
    await syncSpentFromReceipts(state);
    saveState(state);
    return toView(state, source);
  });
}

export async function updateOwnerPolicy(partialPolicy: PolicyPatch | unknown): Promise<{
  policy: ActivePolicy;
  revision: number;
  pendingOwnerIntent: GenerateIntentResponse | null;
  remoteError: string | null;
}> {
  const patch = readPolicyPatch(partialPolicy);
  return withState(async (state) => {
    ensureBudgetWindow(state);
    state.policy = { ...state.policy, ...patch };
    await syncSpentFromReceipts(state);
    state.policyRevision += 1;
    const remote = await tryOwnerIntent(state, {
      type: "policy_update",
      agent_id: state.agentId,
      policy: toSdkPolicy(state),
      expected_revision: state.policyRevision - 1,
    });
    saveState(state);
    return {
      policy: state.policy,
      revision: state.policyRevision,
      pendingOwnerIntent: remote.intent,
      remoteError: remote.error,
    };
  });
}

export async function rotateOrRevokeGrant(action: "rotate" | "revoke"): Promise<{
  action: "rotate" | "revoke";
  grant: PublicGrant;
  token: string | null;
  pendingOwnerIntent: GenerateIntentResponse | null;
  remoteError: string | null;
}> {
  if (action !== "rotate" && action !== "revoke") {
    throw new AgentOperationError("invalid_action", "Grant action must be rotate or revoke.");
  }
  return withState(async (state) => {
    if (action === "revoke") {
      state.grant.revoked = true;
      const remote = await tryOwnerIntent(state, {
        type: "grant_revoke",
        agent_id: state.agentId,
        grant_id: state.grant.grantId,
      });
      saveState(state);
      return {
        action,
        grant: publicGrant(state.grant),
        token: null,
        pendingOwnerIntent: remote.intent,
        remoteError: remote.error,
      };
    }

    const created = createGrantCredential();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    state.grant = {
      grantId: `grant_${created.commitment.slice(0, 16)}`,
      token: created.token,
      tokenPreview: previewGrantToken(created.token),
      commitmentHash: created.commitment,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      revoked: false,
      label: "Kotha session",
    };
    const remote = await tryOwnerIntent(state, {
      type: "grant_issue",
      agent_id: state.agentId,
      label: state.grant.label,
      credential: created.commitment,
      expires_at: expiresAt.toISOString(),
    });
    saveState(state);
    return {
      action,
      grant: publicGrant(state.grant),
      token: created.token,
      pendingOwnerIntent: remote.intent,
      remoteError: remote.error,
    };
  });
}

export async function setEmergencyFreeze(frozen: boolean): Promise<{
  frozen: boolean;
  policy: ActivePolicy;
  pendingOwnerIntent: GenerateIntentResponse | null;
  remoteError: string | null;
}> {
  if (typeof frozen !== "boolean") {
    throw new AgentOperationError("invalid_freeze", "frozen must be a boolean.");
  }
  return withState(async (state) => {
    state.policy.frozen = frozen;
    await syncSpentFromReceipts(state);
    const remote = await tryOwnerIntent(
      state,
      frozen
        ? { type: "agent_freeze", agent_id: state.agentId }
        : { type: "agent_unfreeze", agent_id: state.agentId },
    );
    saveState(state);
    return {
      frozen,
      policy: state.policy,
      pendingOwnerIntent: remote.intent,
      remoteError: remote.error,
    };
  });
}

export async function runDryRunPreview(intentInput: AegisIntent | unknown, balanceOverride?: BalanceBook | null): Promise<DryRunPreview> {
  const intent = coerceIntent(intentInput);
  if (!intent) {
    throw new AgentOperationError("invalid_intent", "Intent must include a supported action.");
  }
  if (!intent.origin_asset) {
    throw new AgentOperationError("invalid_intent", "Intent is missing origin_asset.");
  }
  return withState(async (state) => {
    ensureBudgetWindow(state);
    await syncSpentFromReceipts(state);
    saveState(state);
    const remoteQuote = await tryRemoteDryRun(state, intent);
    const local = previewIntent(intent, state.policy, balanceOverride ?? bookFromState(state));
    return mergeRemoteQuote(local, remoteQuote);
  });
}

export async function executeIntentWithGrant(
  intentInput: AegisIntent | unknown,
  teeAttestation?: TeeProofInput | null,
): Promise<ExecutionResult> {
  const intent = coerceIntent(intentInput);
  if (!intent || !intent.origin_asset) {
    throw new AgentOperationError("invalid_intent", "Intent must include an action and origin_asset.");
  }
  return withState(async (state) => {
    ensureBudgetWindow(state);
    await syncSpentFromReceipts(state);
    const preview = previewIntent(intent, state.policy, bookFromState(state));
    if (!preview.allowed) {
      throw new AgentOperationError("policy_rejected", preview.warnings.join(" ") || "Policy rejected the intent.", 403, preview);
    }
    assertGrantActive(state);
    const idempotencyKey = createIdempotencyKey();
    const dispatched = await dispatchOrFallback(state, intent, preview, idempotencyKey);
    applyBalances(state, intent, preview);
    saveState(state);
    const tee = normalizeTee(teeAttestation);
    const proof = buildOperationProof(state, dispatched.correlationId, intent, tee, dispatched.merkleRoot, dispatched.verified);
    const notional = resolveNotional(intent, assetMeta(intent.origin_asset), priceOf(state, intent.origin_asset));
    return {
      allowed: true,
      executionSource: dispatched.source,
      correlation_id: dispatched.correlationId,
      agent_id: state.agentId,
      action_type: intent.action,
      origin_asset: assetMeta(intent.origin_asset).asset_id,
      destination_asset: assetMeta(intent.destination_asset || intent.origin_asset).asset_id,
      amount_atomic: notional.atomic.toString(),
      usd_amount_cents: String(Math.max(0, Math.round(preview.budgetImpact.txUsd * 100))),
      near_ai_chat_id: tee.chatId,
      tee_signing_address: tee.signingAddress,
      request_sha256: tee.requestSha256,
      response_sha256: tee.responseSha256,
      tee_signature: tee.signature,
      timestamp_ns: nowNs(),
      idempotency_key: idempotencyKey,
      proof,
      remote_status: dispatched.remoteStatus,
      preview,
    };
  });
}

export async function simulateDemoExecution(
  intentInput: AegisIntent | unknown,
  teeAttestation?: TeeProofInput | null,
): Promise<ExecutionResult> {
  const intent = coerceIntent(intentInput);
  if (!intent || !intent.origin_asset) {
    throw new AgentOperationError("invalid_intent", "Intent must include an action and origin_asset.");
  }
  return withState(async (state) => {
    ensureBudgetWindow(state);
    await syncSpentFromReceipts(state);
    const preview = previewIntent(intent, state.policy, bookFromState(state));
    if (!preview.allowed) {
      throw new AgentOperationError("policy_rejected", preview.warnings.join(" ") || "Policy rejected the intent.", 403, preview);
    }
    const tee = normalizeTee(teeAttestation);
    const correlationId = `demo-${randomUUID()}`;
    const notional = resolveNotional(intent, assetMeta(intent.origin_asset), priceOf(state, intent.origin_asset));
    return {
      allowed: true,
      executionSource: "local-fallback",
      correlation_id: correlationId,
      agent_id: state.agentId,
      action_type: intent.action,
      origin_asset: assetMeta(intent.origin_asset).asset_id,
      destination_asset: assetMeta(intent.destination_asset || intent.origin_asset).asset_id,
      amount_atomic: notional.atomic.toString(),
      usd_amount_cents: String(Math.max(0, Math.round(preview.budgetImpact.txUsd * 100))),
      near_ai_chat_id: tee.chatId,
      tee_signing_address: tee.signingAddress,
      request_sha256: tee.requestSha256,
      response_sha256: tee.responseSha256,
      tee_signature: tee.signature,
      timestamp_ns: nowNs(),
      idempotency_key: `demo-${correlationId}`,
      proof: {
        correlation_id: correlationId,
        merkle_root: "",
        signature: "",
        signing_address: "",
        verified: false,
      },
      remote_status: "simulated-demo",
      preview,
    };
  });
}

async function dispatchOrFallback(
  state: PersistedState,
  intent: AegisIntent,
  preview: DryRunPreview,
  idempotencyKey: string,
): Promise<{ correlationId: string; source: "remote" | "local-fallback"; remoteStatus: string | null; merkleRoot: string | null; verified: boolean }> {
  const api = sdkClient();
  const token = activeGrantToken(state);
  if (!api || !token) {
    return { correlationId: randomUUID(), source: "local-fallback", remoteStatus: null, merkleRoot: null, verified: false };
  }
  try {
    const granted = api.forGrant(token);
    const status = await sendGrantAction(
      granted,
      state.agentId,
      intent,
      preview,
      idempotencyKey,
      priceOf(state, intent.origin_asset),
    );
    if (status.status === "FAILED" || status.status === "REFUNDED") {
      throw new AgentOperationError("execution_failed", status.failure_code || status.status, 502, preview);
    }
    const verifiedProof = await readVerifiedRoot(api, state.agentId, status.correlation_id);
    return {
      correlationId: status.correlation_id,
      source: "remote",
      remoteStatus: status.status,
      merkleRoot: verifiedProof.root,
      verified: verifiedProof.verified,
    };
  } catch (error) {
    if (error instanceof AgentOperationError) throw error;
    if (!shouldFallback(error)) throw wrapRemoteError(error);
    return { correlationId: randomUUID(), source: "local-fallback", remoteStatus: null, merkleRoot: null, verified: false };
  }
}

async function sendGrantAction(
  api: AgentApi,
  agentId: string,
  intent: AegisIntent,
  preview: DryRunPreview,
  idempotencyKey: string,
  price: number,
): Promise<StatusResponse> {
  const origin = assetMeta(intent.origin_asset);
  const destination = assetMeta(intent.destination_asset || intent.origin_asset);
  const amount = resolveNotional(intent, origin, price).atomic.toString();
  if (intent.action === "swap") {
    const minAmount = minAmountOut(preview.quote.expectedAmountOut, destination.decimals, preview.quote.slippageBps);
    return api.swap(
      agentId,
      {
        origin_asset: origin.asset_id,
        destination_asset: destination.asset_id,
        amount,
        confidential: intent.confidential,
        min_amount_out: minAmount,
      },
      { idempotencyKey },
    );
  }
  if (intent.action === "withdraw") {
    return api.withdraw(
      agentId,
      {
        asset: origin.asset_id,
        amount,
        chain: intent.chain || "near",
        recipient: intent.recipient,
        confidential: intent.confidential,
      },
      { idempotencyKey },
    );
  }
  if (intent.action === "transfer") {
    return api.transfer(
      agentId,
      {
        asset: origin.asset_id,
        amount,
        recipient: intent.recipient,
        confidential: intent.confidential,
      },
      { idempotencyKey },
    );
  }
  if (intent.action === "shield") {
    return api.shield(agentId, { asset: origin.asset_id, amount }, { idempotencyKey });
  }
  return api.unshield(agentId, { asset: origin.asset_id, amount }, { idempotencyKey });
}

async function tryRemoteDryRun(state: PersistedState, intent: AegisIntent): Promise<QuoteResponse | null> {
  if (intent.action !== "swap" && intent.action !== "withdraw") return null;
  const api = sdkClient();
  const token = activeGrantToken(state);
  if (!api || !token) return null;
  try {
    const granted = api.forGrant(token);
    const origin = assetMeta(intent.origin_asset);
    const amount = resolveNotional(intent, origin, priceOf(state, origin.asset_id)).atomic.toString();
    if (intent.action === "swap") {
      return await granted.swap(state.agentId, {
        origin_asset: origin.asset_id,
        destination_asset: assetMeta(intent.destination_asset).asset_id,
        amount,
        confidential: intent.confidential,
        dry: true,
      });
    }
    const quoted = await granted.withdraw(
      state.agentId,
      {
        asset: origin.asset_id,
        amount,
        chain: intent.chain || "near",
        recipient: intent.recipient || state.ownerAccount,
        confidential: intent.confidential,
        dry: true,
      },
      { idempotencyKey: createIdempotencyKey() },
    );
    return quoted;
  } catch {
    return null;
  }
}

function mergeRemoteQuote(local: DryRunPreview, remote: QuoteResponse | null): DryRunPreview {
  if (!remote) return local;
  const warnings = [...local.warnings];
  for (const warning of remote.warnings) {
    const line = `${warning.code}: ${warning.detail}`;
    if (!warnings.includes(line)) warnings.push(line);
    if (
      warning.code === "policy_action_denied" ||
      warning.code === "policy_asset_denied" ||
      warning.code === "policy_destination_denied" ||
      warning.code === "spend_budget_exceeded" ||
      warning.code === "policy_limit_exceeded" ||
      warning.code === "policy_transaction_limit_exceeded" ||
      warning.code === "insufficient_balance"
    ) {
      local.allowed = false;
    }
  }
  const feeUsd = remote.fee?.amount_usd != null ? finiteNumber(remote.fee.amount_usd, local.quote.feeUsd) : local.quote.feeUsd;
  const spendUsd = remote.spend?.amount_usd != null ? finiteNumber(remote.spend.amount_usd, local.budgetImpact.txUsd) : local.budgetImpact.txUsd;
  const expected = stringField(remote.quote, ["expected_amount_out", "amount_out", "expectedAmountOut"]);
  const spend = projectSpend(local.budgetImpact.currentSpentUsd, spendUsd);
  const daily = local.budgetImpact.dailyLimitUsd;
  if (spend.projectedSpentUsd > daily + 1e-9 && !warnings.some((warning) => warning.startsWith("PROHORI_DAILY_BUDGET_EXCEEDED"))) {
    local.allowed = false;
    warnings.push(
      `PROHORI_DAILY_BUDGET_EXCEEDED: spent today is $${spend.currentSpentUsd.toFixed(2)}, this action is $${spend.txUsd.toFixed(2)}, projected $${spend.projectedSpentUsd.toFixed(2)} of the $${daily.toFixed(2)} daily limit.`,
    );
  }
  return {
    ...local,
    warnings,
    quote: {
      ...local.quote,
      expectedAmountOut: expected || local.quote.expectedAmountOut,
      feeUsd: round2(feeUsd),
    },
    budgetImpact: {
      ...local.budgetImpact,
      currentSpentUsd: spend.currentSpentUsd,
      txUsd: spend.txUsd,
      projectedSpentUsd: spend.projectedSpentUsd,
      utilizationPct: daily > 0 ? round1((spend.projectedSpentUsd / daily) * 100) : 0,
    },
  };
}

async function hydrateRemote(state: PersistedState): Promise<"local-ledger" | "remote"> {
  const api = sdkClient();
  if (!api || Date.now() < publicFailUntil) return "local-ledger";
  try {
    const [agent, policy] = await Promise.all([api.getAgent(state.agentId), api.getPolicy(state.agentId)]);
    if (agent.owner && "account_id" in agent.owner && agent.owner.account_id) {
      state.ownerAccount = agent.owner.account_id;
    }
    if (policy.policy) {
      state.policy.frozen = policy.policy.frozen;
      state.policy.confidentialShardEnabled = policy.policy.confidential;
      if (policy.policy.budget.daily_usd != null) {
        state.policy.dailyBudgetUsd = finiteNumber(policy.policy.budget.daily_usd, state.policy.dailyBudgetUsd);
      }
      if (typeof policy.revision === "number") state.policyRevision = policy.revision;
    }
    return "remote";
  } catch {
    return "local-ledger";
  }
}

async function tryOwnerIntent(
  state: PersistedState,
  request: Parameters<AgentApi["generateIntent"]>[0],
): Promise<{ intent: GenerateIntentResponse | null; error: string | null }> {
  const api = sdkClient();
  if (!api) return { intent: null, error: null };
  try {
    if (request.type === "policy_update") {
      try {
        const current = await api.getPolicy(state.agentId);
        if (typeof current.revision === "number") request = { ...request, expected_revision: current.revision };
      } catch {
        // Keep the local revision when the live policy cannot be read.
      }
    }
    const generated = await api.generateIntent(request, { idempotencyKey: createIdempotencyKey() });
    return { intent: generated, error: null };
  } catch (error) {
    return { intent: null, error: error instanceof Error ? error.message : "Owner intent failed." };
  }
}

async function readVerifiedRoot(
  api: AgentApi,
  agentId: string,
  correlationId: string,
): Promise<{ root: string | null; verified: boolean }> {
  try {
    const proof = await api.getOperationProof(agentId, correlationId);
    const verified = verifyOperationProof(proof, proof.origin);
    const root = verified.proven[0]?.checkpoint.root;
    return { root: root ? Buffer.from(root).toString("hex") : null, verified: true };
  } catch {
    return { root: null, verified: false };
  }
}

function applyBalances(state: PersistedState, intent: AegisIntent, preview: DryRunPreview): void {
  const origin = assetMeta(intent.origin_asset);
  const destination = assetMeta(intent.destination_asset || intent.origin_asset);
  const notional = resolveNotional(intent, origin, priceOf(state, origin.asset_id));
  const credit = humanToAtomic(preview.quote.expectedAmountOut || "0", destination.decimals);
  if (intent.action === "swap") {
    const shard = intent.confidential ? "confidential" : "public";
    move(state, shard, origin.asset_id, -notional.atomic);
    move(state, shard, destination.asset_id, credit);
  } else if (intent.action === "transfer" || intent.action === "withdraw") {
    const shard = intent.confidential ? "confidential" : "public";
    move(state, shard, origin.asset_id, -notional.atomic);
  } else if (intent.action === "shield") {
    move(state, "public", origin.asset_id, -notional.atomic);
    move(state, "confidential", origin.asset_id, notional.atomic);
  } else {
    move(state, "confidential", origin.asset_id, -notional.atomic);
    move(state, "public", origin.asset_id, notional.atomic);
  }
  state.policy.spentTodayUsd = preview.budgetImpact.projectedSpentUsd;
}

function move(state: PersistedState, shard: "public" | "confidential", assetId: string, delta: bigint): void {
  const current = BigInt(state.balances[shard][assetId] ?? "0");
  const next = current + delta;
  if (next < BigInt(0)) {
    throw new AgentOperationError("insufficient_balance", `Balance update for ${assetId} would go negative.`, 409);
  }
  state.balances[shard][assetId] = next.toString();
}

function buildOperationProof(
  state: PersistedState,
  correlationId: string,
  intent: AegisIntent,
  tee: NormalizedTee,
  remoteRoot: string | null,
  verified: boolean,
): ExecutionResult["proof"] {
  const ops = loadOpsKey();
  const leaves = [
    correlationId,
    state.agentId,
    intent.action,
    intent.origin_asset,
    intent.destination_asset,
    intent.amount,
    tee.requestSha256,
    tee.responseSha256,
    tee.signature,
  ];
  const merkleRoot = remoteRoot ?? merkleRootHex(leaves);
  const signature = signWithKey(ops.privateKeyPem, merkleRoot);
  return {
    correlation_id: correlationId,
    merkle_root: merkleRoot,
    signature,
    signing_address: ops.signingAddress,
    verified,
  };
}

type NormalizedTee = {
  chatId: string;
  requestSha256: string;
  responseSha256: string;
  signature: string;
  signingAddress: string;
};

function normalizeTee(input: TeeProofInput | null | undefined): NormalizedTee {
  const requestSha256 = firstString(input?.requestSha256, input?.request_sha256).toLowerCase();
  const responseSha256 = firstString(input?.responseSha256, input?.response_sha256).toLowerCase();
  const signature = firstString(input?.signature, input?.tee_signature);
  const signingAddress = firstString(input?.signing_address, input?.tee_signing_address, input?.signingAddress);
  const chatId = firstString(input?.chatId, input?.near_ai_chat_id);
  const signatureHex = signature.replace(/^0x/i, "");
  if (
    input?.verificationStatus !== "verified" ||
    !/^[0-9a-f]{64}$/.test(requestSha256) ||
    !/^[0-9a-f]{64}$/.test(responseSha256) ||
    signatureHex.length < 64 ||
    !signingAddress ||
    !chatId
  ) {
    throw new AgentOperationError(
      "attestation_unverified",
      "Execution needs a verified NEAR AI Cloud TEE signature. This response did not include one.",
      409,
    );
  }
  return { chatId, requestSha256, responseSha256, signature, signingAddress };
}

function toSdkPolicy(state: PersistedState): Policy {
  const actions = state.policy.allowedActions.filter(isSdkAction);
  const limits: Policy["limits"] = { per_transaction: {} };
  for (const assetId of state.policy.allowedAssets) {
    const meta = assetMeta(assetId);
    const price = state.prices[meta.asset_id] ?? meta.price;
    if (price <= 0) continue;
    const human = state.policy.perTxCapUsd / price;
    limits.per_transaction![meta.asset_id] = humanToAtomic(human.toFixed(Math.min(8, meta.decimals)), meta.decimals).toString();
  }
  return {
    frozen: state.policy.frozen,
    actions: actions.length > 0 ? actions : ["swap"],
    confidential: state.policy.confidentialShardEnabled,
    owner_approval: false,
    assets: state.policy.allowedAssets,
    limits,
    max_actions_per_hour: null,
    destinations: { mode: "any", list: [] },
    budget: {
      daily_usd: String(state.policy.dailyBudgetUsd),
      weekly_usd: null,
      monthly_usd: null,
    },
    timelock_ms: 0,
  };
}

function assertGrantActive(state: PersistedState): void {
  if (state.grant.revoked) {
    throw new AgentOperationError("grant_revoked", "The active session grant has been revoked.", 401);
  }
  if (Date.parse(state.grant.expiresAt) <= Date.now()) {
    throw new AgentOperationError("grant_expired", "The active session grant has expired.", 401);
  }
  const token = activeGrantToken(state);
  if (!token) {
    throw new AgentOperationError("grant_missing", "No active ngt_ grant token is available.", 401);
  }
}

function activeGrantToken(state: PersistedState): string | null {
  const envToken = (process.env.NEAR_INTENTS_GRANT_TOKEN || process.env.NEAR_INTENTS_AGENT_GRANT_TOKEN || "").trim();
  if (NGT_TOKEN.test(envToken)) return envToken;
  if (!state.grant.revoked && NGT_TOKEN.test(state.grant.token) && Date.parse(state.grant.expiresAt) > Date.now()) {
    return state.grant.token;
  }
  return null;
}

function sdkClient(): AgentApi | null {
  const key = (process.env.NEAR_INTENTS_AGENT_API_KEY || process.env.NEAR_INTENTS_API_KEY || "").trim();
  if (!NAA_KEY.test(key)) return null;
  try {
    return createAgentApi({
      apiKey: key,
      baseUrl: intentsOrigin(),
      timeoutMs: WRITE_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
}

function intentsOrigin(): string {
  const raw = process.env.NEAR_INTENTS_AGENT_API_URL || "https://api.demo.agentsonintents.com";
  const url = new URL(raw);
  return `${url.protocol}//${url.host}`;
}

function intentsHeaders(init?: { grantToken?: string; idempotencyKey?: string; json?: boolean }): Headers {
  const headers = new Headers();
  headers.set("accept", "application/json");
  const key = (process.env.NEAR_INTENTS_AGENT_API_KEY || process.env.NEAR_INTENTS_API_KEY || "").trim();
  if (key) headers.set("X-API-Key", key);
  if (init?.grantToken) headers.set("X-Grant-Token", init.grantToken);
  if (init?.idempotencyKey) headers.set("Idempotency-Key", init.idempotencyKey);
  if (init?.json) headers.set("content-type", "application/json");
  return headers;
}

async function publicGet<T>(path: string): Promise<T> {
  const response = await fetch(`${intentsOrigin()}${path}`, {
    method: "GET",
    headers: intentsHeaders(),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`NEAR Intents ${path} returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function fallbackCatalog(): { network: NetworkSnapshot; tokens: TokenMetadata[]; source: "fallback" } {
  const now = new Date().toISOString();
  return {
    source: "fallback",
    network: {
      network: "demo",
      contract_id: PUBLIC_SHARD,
      confidential_contract_id: CONFIDENTIAL_SHARD,
      supported_owner_types: ["near", "evm", "passkey"],
      status: {
        overall: "degraded",
        checked_at: now,
        components: [
          { id: "one_click", status: "unknown", reason: "Live network endpoint is unreachable.", affects: ["swap", "withdraw"], },
          { id: "custody", status: "unknown", reason: null, affects: ["grant", "policy"], },
          { id: "near", status: "operational", reason: null, affects: ["intents.near", "intents.far"], },
        ],
      },
      source: "fallback",
    },
    tokens: fallbackTokens(now),
  };
}

function fallbackTokens(now: string | null): TokenMetadata[] {
  return KOTHA_ASSETS.map((asset) => ({
    asset_id: asset.asset_id,
    symbol: asset.symbol,
    decimals: asset.decimals,
    blockchain: asset.blockchain,
    price: asset.price,
    price_updated_at: now,
    price_expires_at: null,
  }));
}

function mergeFallbackTokens(live: TokenMetadata[]): TokenMetadata[] {
  const byId = new Map(live.map((token) => [token.asset_id, token]));
  for (const token of fallbackTokens(new Date().toISOString())) {
    if (!byId.has(token.asset_id)) byId.set(token.asset_id, token);
  }
  return [...byId.values()];
}

function mapNetwork(network: NetworkView): NetworkSnapshot {
  return {
    network: network.network,
    contract_id: network.contract_id,
    confidential_contract_id: CONFIDENTIAL_SHARD,
    supported_owner_types: network.supported_owner_types,
    status: {
      overall: network.status.overall,
      checked_at: network.status.checked_at,
      components: network.status.components.map((component) => ({
        id: component.id,
        status: component.status,
        reason: component.reason,
        affects: component.affects,
      })),
    },
    source: "live",
  };
}

function toTokenMetadata(token: TokenView): TokenMetadata {
  return {
    asset_id: token.asset_id,
    symbol: token.symbol,
    decimals: token.decimals,
    blockchain: token.blockchain,
    price: token.price,
    price_updated_at: token.price_updated_at,
    price_expires_at: token.price_expires_at,
  };
}

async function rememberPrices(tokens: TokenMetadata[]): Promise<void> {
  await withState((state) => {
    for (const token of tokens) {
      if (token.price != null && token.price > 0) state.prices[token.asset_id] = token.price;
    }
    saveState(state);
  });
}

function toView(state: PersistedState, source: "local-ledger" | "remote"): AgentStateView {
  return {
    agent: {
      id: state.agentId,
      name: state.agentName,
      ownerAccount: state.ownerAccount,
      status: "ACTIVE",
      source,
    },
    balances: {
      public: balanceRows(state, "public"),
      confidential: balanceRows(state, "confidential"),
      shards: { public: "intents.near", confidential: "intents.far" },
    },
    policy: state.policy,
    grant: publicGrant(state.grant),
    frozen: state.policy.frozen,
  };
}

function balanceRows(state: PersistedState, shard: "public" | "confidential"): TokenBalanceView[] {
  const ids = Object.keys(state.balances[shard]);
  return ids.map((assetId) => {
    const meta = assetMeta(assetId);
    const raw = BigInt(state.balances[shard][assetId] ?? "0");
    const human = atomicToHuman(raw, meta.decimals);
    const price = state.prices[assetId] ?? meta.price;
    return {
      asset_id: meta.asset_id,
      symbol: meta.symbol,
      decimals: meta.decimals,
      balance: human,
      balance_raw: raw.toString(),
      price_usd: price,
      value_usd: round2(Number(human) * price),
      shard: shard === "public" ? "intents.near" : "intents.far",
    };
  });
}

function publicGrant(grant: PersistedGrant): PublicGrant {
  const active = !grant.revoked && NGT_TOKEN.test(grant.token) && Date.parse(grant.expiresAt) > Date.now();
  return {
    grantId: grant.grantId,
    tokenPreview: grant.tokenPreview,
    commitmentHash: grant.commitmentHash,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    revoked: grant.revoked,
    active,
    label: grant.label,
  };
}

function bookFromState(state: PersistedState): BalanceBook {
  return {
    public: bigintMap(state.balances.public),
    confidential: bigintMap(state.balances.confidential),
    prices: { ...state.prices },
  };
}

function defaultBook(): BalanceBook {
  const state = createDefaultState();
  return bookFromState(state);
}

function defaultPrices(): Record<string, number> {
  return Object.fromEntries(KOTHA_ASSETS.map((asset) => [asset.asset_id, asset.price]));
}

function bigintMap(source: Record<string, string>): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const [asset, raw] of Object.entries(source)) out[asset] = BigInt(raw || "0");
  return out;
}

function ingestBalanceSide(book: BalanceBook, value: unknown, shard: "public" | "confidential"): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const record = asRecord(entry);
      if (!record) continue;
      const assetId = canonicalAsset(stringValue(record.asset_id));
      if (!assetId) continue;
      const raw = stringValue(record.balance_raw);
      const meta = assetMeta(assetId);
      book[shard][assetId] = raw ? BigInt(raw) : humanToAtomic(stringValue(record.balance) || "0", meta.decimals);
      const price = finiteNumber(record.price_usd ?? record.price, Number.NaN);
      if (Number.isFinite(price) && price > 0) book.prices[assetId] = price;
    }
    return;
  }
  if (isAtomicMap(value)) {
    for (const [asset, raw] of Object.entries(value)) {
      book[shard][canonicalAsset(asset)] = BigInt(raw);
    }
  }
}

function readPolicyPatch(input: unknown): PolicyPatch {
  const root = asRecord(input) ?? {};
  const source = asRecord(root.policy) ?? root;
  const patch: PolicyPatch = {};
  if (source.dailyBudgetUsd != null) patch.dailyBudgetUsd = nonNegative(source.dailyBudgetUsd, "dailyBudgetUsd");
  if (source.perTxCapUsd != null) patch.perTxCapUsd = nonNegative(source.perTxCapUsd, "perTxCapUsd");
  if (source.confidentialShardEnabled != null) {
    patch.confidentialShardEnabled = booleanValue(source.confidentialShardEnabled, false);
  }
  if (source.allowedActions != null) {
    if (!Array.isArray(source.allowedActions) || source.allowedActions.some((item) => !isAction(item))) {
      throw new AgentOperationError("invalid_policy", "allowedActions must be a list of swap, transfer, withdraw, shield, unshield.");
    }
    patch.allowedActions = source.allowedActions.filter(isAction);
  }
  if (source.allowedAssets != null) {
    if (!Array.isArray(source.allowedAssets) || source.allowedAssets.some((item) => typeof item !== "string")) {
      throw new AgentOperationError("invalid_policy", "allowedAssets must be a list of asset ids.");
    }
    patch.allowedAssets = source.allowedAssets.map((item) => canonicalAsset(String(item)));
  }
  if (Object.keys(patch).length === 0) {
    throw new AgentOperationError("invalid_policy", "Policy patch did not include a supported field.");
  }
  return patch;
}

function resolveNotional(intent: AegisIntent, origin: AssetMeta, price: number): Notional {
  const raw = intent.amount.trim();
  let parsedHuman = raw;
  if (!raw || raw === "0") {
    if (intent.amount_usd_estimate > 0 && price > 0) {
      parsedHuman = trimFixed(intent.amount_usd_estimate / price, Math.min(8, origin.decimals));
    } else {
      parsedHuman = "0";
    }
  }
  const atomic = interpretAmount(parsedHuman, origin.decimals);
  const human = atomicToHuman(atomic, origin.decimals);
  const humanNumber = Number(human);
  return { human, humanNumber, atomic, usd: humanNumber * price };
}

function interpretAmount(amount: string, decimals: number): bigint {
  const trimmed = amount.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new AgentOperationError("invalid_amount", `Invalid amount: ${amount}`);
  }
  if (!trimmed.includes(".") && trimmed.length > decimals) return BigInt(trimmed);
  return humanToAtomic(trimmed, decimals);
}

function priceOf(state: PersistedState, assetId: string): number {
  const meta = assetMeta(assetId);
  return state.prices[meta.asset_id] ?? meta.price;
}

function ensureBudgetWindow(state: PersistedState): void {
  const today = utcDay();
  if (state.budgetDay !== today) {
    state.budgetDay = today;
    state.policy.spentTodayUsd = 0;
  }
}

async function syncSpentFromReceipts(state: PersistedState): Promise<void> {
  try {
    const records = await listReceiptRecords();
    state.policy.spentTodayUsd = sumTodayReceiptUsd(Object.values(records), state.budgetDay || utcDayStamp());
  } catch {
    state.policy.spentTodayUsd = 0;
  }
}

function describeRoute(intent: AegisIntent, origin: string, destination: string, shard: "intents.near" | "intents.far"): string {
  if (intent.action === "swap") return `${shard} · ${origin} → ${destination}`;
  if (intent.action === "shield") return `intents.near → intents.far · shield ${origin}`;
  if (intent.action === "unshield") return `intents.far → intents.near · unshield ${origin}`;
  if (intent.action === "withdraw") return `${shard} · withdraw ${origin} → ${intent.recipient || "recipient"} (${intent.chain || "near"})`;
  return `${shard} · transfer ${origin} → ${intent.recipient || "recipient"}`;
}

function minAmountOut(expectedHuman: string, decimals: number, slippageBps: number): string {
  const expected = humanToAtomic(expectedHuman || "0", decimals);
  const kept = BigInt(Math.max(0, 10_000 - slippageBps));
  return ((expected * kept) / BigInt(10000)).toString();
}

function loadOpsKey(): OpsKey {
  const file = aegisStatePath(OPS_KEY_FILE);
  try {
    const parsed = JSON.parse(readTextFile(file)) as OpsKey;
    if (parsed.privateKeyPem && parsed.publicKeyPem && parsed.signingAddress) return parsed;
  } catch {
    // Generate a fresh operations key below.
  }
  const { privateKey, publicKey } = generateEcKey();
  const record: OpsKey = {
    privateKeyPem: exportPem(privateKey, "pkcs8"),
    publicKeyPem: exportPem(publicKey, "spki"),
    signingAddress: addressFromPublic(exportPem(publicKey, "spki")),
  };
  writeJsonFile(file, record);
  return record;
}

function generateEcKey(): { privateKey: KeyObject; publicKey: KeyObject } {
  try {
    return generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  } catch {
    return generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  }
}

function exportPem(key: KeyObject, type: "pkcs8" | "spki"): string {
  return key.export({ type, format: "pem" }).toString();
}

function addressFromPublic(publicKeyPem: string): string {
  const der = createHash("sha256").update(publicKeyPem).digest("hex");
  return `0x${der.slice(-40)}`;
}

function signWithKey(privateKeyPem: string, message: string): string {
  const signer = createSign("SHA256");
  signer.update(message);
  signer.end();
  return `0x${signer.sign(privateKeyPem).toString("hex")}`;
}

function merkleRootHex(leaves: string[]): string {
  let level: Uint8Array[] = leaves.map((leaf) => new Uint8Array(createHash("sha256").update(leaf, "utf8").digest()));
  if (level.length === 0) return sha256Hex("");
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      next.push(new Uint8Array(createHash("sha256").update(Buffer.concat([left, right])).digest()));
    }
    level = next;
  }
  return Buffer.from(level[0]).toString("hex");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function nowNs(): string {
  return (BigInt(Date.now()) * BigInt(1000000)).toString();
}

function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function formatHuman(value: number, decimals: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const places = Math.min(8, decimals);
  return atomicToHuman(humanToAtomic(trimFixed(value, places), decimals), decimals);
}

function formatRate(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

function trimFixed(value: number, places: number): string {
  return value.toFixed(places).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

function round2(value: number): number {
  return roundUsd(value);
}

function round1(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function finiteNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function nonNegative(value: unknown, field: string): number {
  const numeric = finiteNumber(value, Number.NaN);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new AgentOperationError("invalid_policy", `${field} must be a non-negative number.`);
  }
  return numeric;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value && value.trim()) return value.trim();
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function isAction(value: unknown): value is IntentAction {
  return typeof value === "string" && (INTENT_ACTIONS as readonly string[]).includes(value);
}

function isSdkAction(value: IntentAction): value is PolicyAction {
  return value === "swap" || value === "transfer" || value === "withdraw";
}

function isAtomicMap(value: unknown): value is Record<string, string> {
  const record = asRecord(value);
  if (!record) return false;
  return Object.values(record).every((item) => typeof item === "string" && /^-?\d+$/.test(item));
}

function stringField(record: { [key: string]: unknown }, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function shouldFallback(error: unknown): boolean {
  if (error instanceof AgentApiRequestError) return true;
  if (error instanceof AgentApiError) {
    return error.status === 401 || error.status === 404 || error.status === 502 || error.status === 503;
  }
  if (error instanceof TypeError) return true;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return true;
  return false;
}

function wrapRemoteError(error: unknown): AgentOperationError {
  if (error instanceof AgentApiError) {
    return new AgentOperationError(error.code || "agent_api_error", error.detail || error.title || error.message, error.status);
  }
  if (error instanceof Error) return new AgentOperationError("agent_api_error", error.message, 502);
  return new AgentOperationError("agent_api_error", "NEAR Intents request failed.", 502);
}
