/**
 * Client-safe mirrors of the JSON returned by `/api/tee-chat` and `/api/intents`.
 * Field names match `AttestedInference`, `DryRunPreview`, `AgentStateView`,
 * `VerifiedExecution`, and the route wrappers in the App Router handlers.
 */

export const CHAT_MODELS = [
  "deepseek/deepseek-v3.2",
  "deepseek/deepseek-v4.1-flash",
  "Qwen/Qwen3.8-27B",
  "z-ai/glm-5.3",
] as const;

export type ChatModelId = (typeof CHAT_MODELS)[number];

export const INTENT_ACTIONS = ["swap", "transfer", "withdraw", "shield", "unshield"] as const;
export type IntentAction = (typeof INTENT_ACTIONS)[number];

export type PolicyStatus = "PASS" | "WARNING" | "BLOCKED";
export type AttestationMode = "hardware-tee" | "unverified";

export type TeeVerification = {
  status: "verified" | "unverified";
  reason: string;
};
export type ShardId = "intents.near" | "intents.far";

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
    shard: ShardId;
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

export type RedactionResult = {
  originalLength: number;
  redactedText: string;
  redactionsCount: number;
  piiTypesFound: string[];
};

export type CopilotDecision = {
  explanation: string;
  risk_score: number;
  policy_status: PolicyStatus;
  policy_reason: string;
  intent: AegisIntent | null;
};

export type AttestedInference = {
  mode: AttestationMode;
  model: string;
  chatId: string;
  requestSha256: string;
  responseSha256: string;
  nonce: string;
  signature: string;
  signing_address: string;
  signing_algo: "ecdsa" | "ed25519";
  intel_quote: string;
  nvidia_payload: string;
  redaction: RedactionResult | null;
  decision: CopilotDecision;
  rawResponseText: string;
  request: {
    model: string;
    stream: true;
    response_format: { type: "json_object" };
    messages: Array<{ role: "system" | "user"; content: string }>;
  };
  verification: TeeVerification;
  hardware: {
    chat_status: number | null;
    signature: unknown;
    attestation: unknown;
  } | null;
};

export type EnclaveTelemetry = {
  provider: "NEAR AI Cloud";
  cpu_tee: "Intel TDX";
  gpu_tee: "NVIDIA H100 TEE";
  signing_algo: "ecdsa" | "ed25519";
  base_url: string;
  key_configured: boolean;
  status: "live" | "unreachable" | "unconfigured";
  model: string;
  nonce: string | null;
  signing_address: string | null;
  intel_quote_sha256: string | null;
  nvidia_payload_sha256: string | null;
  detail: string;
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

export type NetworkComponentStatus = "operational" | "degraded" | "down" | "unknown";

export type NetworkSnapshot = {
  network: string;
  contract_id: string;
  confidential_contract_id: string;
  supported_owner_types: string[];
  status: {
    overall: NetworkComponentStatus;
    checked_at: string | null;
    components: Array<{
      id: string;
      status: NetworkComponentStatus;
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
  shard: ShardId;
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
  tx_hash?: string;
  receipt_hash?: string;
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

export type DashboardResponse = {
  network: NetworkSnapshot;
  tokens: TokenMetadata[];
  agentState: AgentStateView;
  vaultInfo: VaultInfo;
  executions: VerifiedExecution[];
};

export type TeeCatalogResponse = {
  models: string[];
  enclave: EnclaveTelemetry;
};

export type TeeChatResponse = {
  attestation: AttestedInference;
  dryRun: DryRunPreview | null;
};

export type PolicyUpdateResponse = {
  type: "update_policy";
  policy: ActivePolicy;
  revision: number;
  pendingOwnerIntent: unknown;
  remoteError: string | null;
};

export type GrantResponse = {
  type: "rotate_grant" | "revoke_grant";
  action: "rotate" | "revoke";
  grant: PublicGrant;
  token: string | null;
  pendingOwnerIntent: unknown;
  remoteError: string | null;
};

export type FreezeResponse = {
  type: "emergency_freeze";
  frozen: boolean;
  policy: ActivePolicy;
  pendingOwnerIntent: unknown;
  remoteError: string | null;
};

export type ExecuteResponse = {
  type: "execute";
  simulated?: boolean;
  execution: ExecutionResult;
  vault: {
    execution: VerifiedExecution;
    commands: { record_execution: string; get_execution: string };
    tx_hash: string | null;
    receipt_hash: string;
    chain_error: string | null;
  };
};

export type DryRunResponse = {
  type: "dry_run";
  preview: DryRunPreview;
};

export type ApiErrorBody = {
  error?: {
    code?: string;
    message?: string;
    preview?: DryRunPreview | null;
  };
};

export function isChatModel(value: string): value is ChatModelId {
  return (CHAT_MODELS as readonly string[]).includes(value);
}
