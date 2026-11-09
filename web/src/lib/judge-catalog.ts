/** Client-safe judge portal facts. No filesystem, no BIP39 wordlist, no intents client. */

export const JUDGE_TITLE =
  "Kotha — Verifiable Confidential Multilingual Voice DeFi & Cross-Chain Remittance Copilot on NEAR";

export const LIVE_ORIGIN = "https://kotha-ayan19.vercel.app";
export const LIVE_CONTRACT_ID = "kotha-vault-1793945609.testnet";
export const GITHUB_REPO = "https://github.com/Ayan1816/kotha";
export const NEARBLOCKS_ACCOUNT = `https://testnet.nearblocks.io/address/${LIVE_CONTRACT_ID}`;
export const NEAR_AI_CLOUD = "https://cloud-api.near.ai";
export const NEAR_INTENTS_DOCS = "https://docs.near.org/chain-abstraction/intents/overview";
export const NEAR_CONNECT_HOOKS = "https://www.npmjs.com/package/near-connect-hooks";
export const NEAR_CONNECT_WALLET = "https://www.npmjs.com/package/@hot-labs/near-connect";

export const TEE_CHAT_MODEL = "deepseek/deepseek-v3.2";
export const WHISPER_MODEL = "openai/whisper-large-v3";
export const PRIVACY_FILTER_MODEL = "openai/privacy-filter";

export const POLICY_DAILY_USD = "100.00";
export const POLICY_DAILY_CENTS = "10000";
export const POLICY_PER_TX_USD = "50.00";
export const POLICY_PER_TX_CENTS = "5000";

export const CORE_TEST_CASES = 59;

export const OFFICIAL_REFERENCES = {
  liveDeployment: LIVE_ORIGIN,
  github: GITHUB_REPO,
  nearTestnetContractExplorer: NEARBLOCKS_ACCOUNT,
  nearAiCloud: NEAR_AI_CLOUD,
  nearIntents: NEAR_INTENTS_DOCS,
  nearConnect: {
    hooks: NEAR_CONNECT_HOOKS,
    wallet: NEAR_CONNECT_WALLET,
    note: "Installed stack is near-connect-hooks and @hot-labs/near-connect. Wallet login uses NEAR Connect on testnet.",
  },
} as const;

export const SOURCE_MODULES = [
  { path: "contract/src/lib.rs", role: "Prohori Rust policy vault. record_execution and get_execution. Caller must be owner or agent." },
  { path: "web/src/lib/near-ai-tee.ts", role: "TEE chat against NEAR AI. Signature and attestation GETs. Raw-body SHA-256. No local fake ECDSA." },
  { path: "web/src/lib/pii-redact.ts", role: "Dual-layer redaction: Bangladesh mobiles, global E.164, email, NID, Luhn cards, 12/24 BIP39 seeds, then openai/privacy-filter." },
  { path: "web/src/lib/voice-transcribe.ts", role: "Whisper fallback model openai/whisper-large-v3 at NEAR AI /v1/audio/transcriptions." },
  { path: "web/src/lib/chat-stream.ts", role: "SSE is assembled only for chat id and content. The hash stays on the raw HTTP body." },
  { path: "web/src/lib/intents-agent.ts", role: "NEAR Intents public and confidential dry-run, policy, and grant-gated execution." },
  { path: "web/src/lib/budget-math.ts", role: "Spending guard. Every action adds to today's UTC spend. Zero amounts are rejected." },
  { path: "web/src/lib/wallet-proof.ts", role: "NEP-413 proof bytes, owner action list, contract id, explorer links." },
  { path: "web/src/lib/wallet-verify.ts", role: "Owner proof: nonce, age, owner id, RPC view_access_key_list, then nep413 verifyMessage." },
  { path: "web/src/lib/receipt-canonical.ts", role: "Canonical JSON and SHA-256 receipt_hash frozen once." },
  { path: "web/src/lib/receipt-store.ts", role: "Freeze-once receipt store (KV REST or local file). Status updates do not replace bytes." },
  { path: "web/src/lib/receipt-service.ts", role: "Anchor path. Wallet-authenticated execute uses skipChain so the browser signs record_execution." },
  { path: "web/src/lib/near-vault-rpc.ts", role: "Testnet view and broadcast helpers. get_execution raw JSON is extracted before parse." },
  { path: "web/src/components/WalletButton.tsx", role: "NEAR Connect login via useNearWallet." },
  { path: "web/src/app/providers.tsx", role: "NearProvider. Network is testnet unless NEXT_PUBLIC_NETWORK is mainnet." },
] as const;

export const REST_ENDPOINTS = [
  "GET /api/tee-chat",
  "POST /api/tee-chat",
  "GET /api/intents",
  "POST /api/intents",
  "GET /api/receipts/[id]",
  "GET /api/receipts/export-statement",
  "GET /api/vault/execution",
  "POST /api/voice-transcribe",
  "GET /llms.txt",
  "GET /openapi.json",
] as const;

export const TEST_FILES = [
  { file: "web/src/lib/pii-redact.test.ts", cases: 16, covers: "BD and global phones, email, NID, Luhn cards, BIP39 seeds" },
  { file: "web/src/lib/receipt.test.ts", cases: 8, covers: "Canonical bytes, freeze-once, chain compare, digit-string u64 args" },
  { file: "web/src/lib/budget-math.test.ts", cases: 10, covers: "Swap, transfer, shield, unshield, withdraw, daily cap, zero amount" },
  { file: "web/src/lib/wallet-proof.test.ts", cases: 12, covers: "NEP-413 message, owner gate, gas, contract id, Testnet Demo badge" },
  { file: "web/src/lib/wallet-verify.test.ts", cases: 9, covers: "Expired and replayed proofs, non-owner, access-key membership" },
  { file: "web/src/lib/chat-stream.test.ts", cases: 3, covers: "Raw-body hash vs SSE assembly, loader copy, en/bn key parity" },
  { file: "web/src/lib/voice-transcribe.test.ts", cases: 1, covers: "Whisper model, URL, and transcript parsing" },
] as const;

export const PILLARS = [
  {
    id: "prohori",
    index: "1",
    name: "Prohori Firewall & Rust Policy Vault",
    summary: `On-chain spending firewall at ${LIVE_CONTRACT_ID}, plus NEP-413 owner authentication before any state change.`,
    stages: [
      { id: "vault", title: "Rust policy vault", body: `The deployed account is ${LIVE_CONTRACT_ID}. record_execution accepts one VerifiedExecution. get_execution reads it back by correlation_id. Owner and agent of the live vault are that same account.` },
      { id: "nep413", title: "NEP-413 owner authentication", body: "Owner actions require a NEP-413 signature over JSON { action, payload, ts }, a 32-byte nonce, and a FullAccess key listed by RPC view_access_key_list. Proofs older than 5 minutes or more than 60 seconds in the future are rejected." },
      { id: "limits", title: "Spending limits", body: `Init policy is a daily budget of $${POLICY_DAILY_USD} (${POLICY_DAILY_CENTS} cents) and a per-transaction cap of $${POLICY_PER_TX_USD} (${POLICY_PER_TX_CENTS} cents). Shield and unshield count toward today's spend. The live owner policy is whatever GET /api/intents returns in agentState.policy.` },
      { id: "fail-closed", title: "Fail closed", body: "If NEXT_PUBLIC_OWNER_ID and OWNER_ID are empty, owner actions stay locked. Visitors can still chat and dry-run. A missing proof never falls through to a chain write." },
    ],
  },
  {
    id: "tee",
    index: "2",
    name: "Kotha TEE Enclave",
    summary: `Chat model ${TEE_CHAT_MODEL}. Green verified only after real NEAR AI signature and attestation checks. Voice falls back to ${WHISPER_MODEL}. PII uses a local pass plus ${PRIVACY_FILTER_MODEL}.`,
    stages: [
      { id: "model", title: "Chat model", body: `Requests go to NEAR AI with model ${TEE_CHAT_MODEL} and stream: true. The route emits SSE steps redacting, thinking, verifying, and policy. A non-stream JSON completion is still accepted when the gateway returns JSON.` },
      { id: "signature", title: "Signature verification", body: "After the chat body returns, Kotha GETs /v1/signature/{chat_id} and /v1/attestation/report with the NEAR AI key. Verified requires ECDSA recovery of a report signing_address AND the hash inside the signed text equaling SHA-256 of the raw HTTP body." },
      { id: "honesty", title: "What stays unverified", body: "SSE is assembled only to read the chat id and the explanation. If the gateway signs different bytes than the raw body, status stays unverified and execute stays blocked. Kotha does not invent a TDX or NVIDIA quote and does not request a second non-stream completion to force a match." },
      { id: "voice", title: "Voice fallback", body: `The mic records with MediaRecorder and posts multipart file plus language (bn or en) to /api/voice-transcribe, which forwards audio to ${WHISPER_MODEL}. The returned text fills the chat input and is sent. SpeechRecognition is not used.` },
      { id: "pii", title: "Dual-layer PII redaction", body: `Local patterns cover Bangladesh mobiles (including Bengali digits), global E.164, email, NID, passport, bKash/Nagad, Luhn cards, and 12/24 BIP39 seeds. Tokens are [REDACTED_PHONE|EMAIL|ID|CARD|SEED]. When the key is set, a second POST uses ${PRIVACY_FILTER_MODEL}. Account ids and amounts stay visible.` },
    ],
  },
  {
    id: "shakkhi",
    index: "3",
    name: "Shakkhi On-Chain Audit Vault",
    summary: "Frozen receipts, record_execution / get_execution on NEAR Testnet, and NEAR Intents public or confidential dry-run and execution.",
    stages: [
      { id: "freeze", title: "Frozen receipt", body: "The canonical receipt JSON is hashed once with SHA-256. A second save does not replace those bytes. tx_hash and chain_error update beside the frozen blob. Downloads return the stored bytes." },
      { id: "record", title: "record_execution", body: "Wallet-authenticated execute signs { execution: VerifiedExecution } with method record_execution, gas 30000000000000, deposit 0, via callFunctionRaw. The receipt hash is response_sha256. The intent hash is request_sha256. It is not a bare { receipt_hash }." },
      { id: "read", title: "get_execution", body: "Verify on-chain calls get_execution with { correlation_id }. A match compares response_sha256 or receipt_hash to the local receipt hash. usd_amount_cents and timestamp_ns stay digit strings because values above 2^53 must not pass through JSON.parse as numbers." },
      { id: "intents", title: "NEAR Intents dry-run and execution", body: "dry_run is unsigned and does not broadcast. Public and confidential (intents.far) previews stay inside the policy. Execution, policy edits, grant rotation, and emergency freeze require the owner proof. The server broadcast path is skipped (skipChain) once the wallet is signing." },
    ],
  },
] as const;

export const SCOPE_ROWS = [
  {
    surface: "Wallet login",
    live: "NearProvider defaults to NEXT_PUBLIC_NETWORK or testnet, with autoConnect and no features filter. signIn() opens the NEAR Connect modal. Escape, the backdrop, and Cancel close it. NEP-413 signatures are checked against RPC view_access_key_list and near-api-js verifyMessage.",
    boundary: "HOT Wallet, Meteor, Intear, Nightly, and MyNearWallet stay available. A .near account uses https://rpc.mainnet.near.org. A .testnet account uses the testnet RPC.",
  },
  {
    surface: "TEE chat",
    live: `POST /api/tee-chat calls NEAR AI (${TEE_CHAT_MODEL}) with stream: true, then real GET /v1/signature/{chat_id} and GET /v1/attestation/report.`,
    boundary: "Green verified only when ECDSA recovery matches a report signing_address AND the hash inside the signed text matches SHA-256 of the raw chat body. SSE is assembled only for content and id. If the gateway signs other bytes, the row stays unverified and execute is blocked. No second non-stream completion is requested.",
  },
  {
    surface: "Voice",
    live: "MediaRecorder posts audio/webm to /api/voice-transcribe with language bn or en. Whisper returns {text}, which fills the input and sends. Recording stops at 30 seconds.",
    boundary: "SpeechRecognition is not used. Permission, missing microphone, unsupported browser, and transcription errors stay on screen and clear the listening state. A missing API key returns an error JSON body.",
  },
  {
    surface: "Dry-run",
    live: "POST /api/intents type dry_run calls the intents preview with no wallet proof.",
    boundary: "Dry-run does not broadcast, does not freeze a receipt, and does not call record_execution. It is a policy preview, including confidential intents.far quotes.",
  },
  {
    surface: "Owner actions",
    live: "execute, update_policy, rotate_grant, revoke_grant, emergency_freeze, and save_tx accept a fresh NEP-413 proof or no wallet object.",
    boundary: "A missing wallet object is server-signer mode and does not return 401. A proof that is present still fails closed when it is expired or signed by another account without sessionOwner. An empty execute intent returns 400 invalid_intent and does not write the chain.",
  },
  {
    surface: "On-chain anchor",
    live: "A connected wallet calls record_execution and the receipt stores signedAccountId. With no wallet, the server signer broadcasts when NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY are set.",
    boundary: "Wallet-authenticated execute uses skipChain: true and callFunctionRaw, not callFunction. Args are { execution: VerifiedExecution }. Gas 30000000000000. Deposit 0. Receipt hash maps to response_sha256 and intent hash maps to request_sha256. The server signer writes unquoted digits. Rust ABI is unchanged. timestamp_ns stays a digit string.",
  },
  {
    surface: "Audit statement",
    live: "GET /api/receipts/export-statement reads receipts already stored for this deployment and prints today's UTC rows, canonical hashes, and NearBlocks links.",
    boundary: "The statement does not call NEAR Intents, does not re-verify ECDSA, and does not mark a row TEE verified. Policy figures shown are the deployed init limits. The live owner policy is on GET /api/intents.",
  },
] as const;

export const ATTACKS = [
  {
    vector: "Prompt-Injection Drain",
    rejection: "A message that tells the copilot to ignore limits and send everything is classified as over-budget. Execute stays disabled. The demo fire prompt is the UI form of this case.",
    tests: "budget-math.test.ts, chat policy path, demoFireLabel",
  },
  {
    vector: "Local/Bangla BD & Global Phone PII Leak",
    rejection: "Bangladesh mobiles in ASCII or Bengali digits, plus global E.164 numbers, are replaced with [REDACTED_PHONE] before the model sees them.",
    tests: "pii-redact.test.ts (16 cases, including the Bengali mobile sentence)",
  },
  {
    vector: "Luhn Card & BIP39 Seed Leak",
    rejection: "Luhn-valid card numbers become [REDACTED_CARD]. 12-word and 24-word BIP39 seeds become [REDACTED_SEED].",
    tests: "pii-redact.test.ts",
  },
  {
    vector: "Unverified TEE Signature Tamper",
    rejection: "Flipping a verified signature clears verified. Execute returns before broadcast. A missing attestation stays amber unverified rather than a fake hardware quote.",
    tests: "chat-stream.test.ts (raw body vs assembled SSE) and the signature tamper lab in the proof panel",
  },
  {
    vector: "Over-Limit Single Spend",
    rejection: `A single action above $${POLICY_PER_TX_USD} is blocked even when today's total would still fit the daily budget.`,
    tests: "budget-math.test.ts and the intents dry-run policy gate",
  },
  {
    vector: "Daily Cap Exceeded",
    rejection: `Projected spend is current UTC-day receipts plus this action. Above $${POLICY_DAILY_USD} the preview is blocked for swap, transfer, shield, unshield, and withdraw.`,
    tests: "budget-math.test.ts",
  },
  {
    vector: "Replay/Expired NEP-413 Signature",
    rejection: "A proof whose ts is older than 5 minutes, or more than 60 seconds ahead, is 401 proof_expired. The nonce must be 32 bytes.",
    tests: "wallet-verify.test.ts",
  },
  {
    vector: "Non-Owner Execution Attempt",
    rejection: "A valid-looking proof from any account other than the configured owner is 401 owner_required or proof_invalid. Function-call keys are not FullAccess.",
    tests: "wallet-verify.test.ts and wallet-proof.test.ts",
  },
  {
    vector: "Zero-Amount Intent",
    rejection: "Amount 0 or a negative amount returns the inline error and clears the previous quote. Dry-run does not show a stale preview.",
    tests: "budget-math.test.ts (ZERO_AMOUNT_WARNING)",
  },
] as const;

const ORIGIN = LIVE_ORIGIN;

export const LIVE_CALLS = [
  {
    id: "llms",
    method: "GET" as const,
    path: "/llms.txt",
    title: "Machine-readable judge index",
    detail: "Plain text. Safe to call. No chain write.",
    body: null,
    form: false,
    curl: `curl -sS -D - ${ORIGIN}/llms.txt`,
  },
  {
    id: "openapi",
    method: "GET" as const,
    path: "/openapi.json",
    title: "OpenAPI 3.1 document",
    detail: "JSON specification. Safe to call. No chain write.",
    body: null,
    form: false,
    curl: `curl -sS -D - ${ORIGIN}/openapi.json`,
  },
  {
    id: "tee-get",
    method: "GET" as const,
    path: "/api/tee-chat",
    title: "TEE model list",
    detail: "Reads enclave telemetry. Does not start a completion.",
    body: null,
    form: false,
    curl: `curl -sS ${ORIGIN}/api/tee-chat`,
  },
  {
    id: "intents-get",
    method: "GET" as const,
    path: "/api/intents",
    title: "Intents catalog and policy",
    detail: "Live read of network, tokens, agentState.policy, vault info, and execution rows. No broadcast.",
    body: null,
    form: false,
    curl: `curl -sS ${ORIGIN}/api/intents`,
  },
  {
    id: "vault-get",
    method: "GET" as const,
    path: "/api/vault/execution?id=judge-missing",
    title: "get_execution raw read",
    detail: "Testnet view call for a correlation id that is not expected to exist. Inspect the JSON. No state change.",
    body: null,
    form: false,
    curl: `curl -sS '${ORIGIN}/api/vault/execution?id=judge-missing'`,
  },
  {
    id: "statement",
    method: "GET" as const,
    path: "/api/receipts/export-statement",
    title: "Executive audit statement",
    detail: "HTML for print. Uses stored receipts only. Does not mark TEE verified.",
    body: null,
    form: false,
    curl: `curl -sS -D - ${ORIGIN}/api/receipts/export-statement`,
  },
  {
    id: "receipt-404",
    method: "GET" as const,
    path: "/api/receipts/judge-missing",
    title: "Missing frozen receipt",
    detail: "Expect 404 receipt_not_found. The App Router path is /api/receipts/[id]. A 404 is a valid inspected response.",
    body: null,
    form: false,
    curl: `curl -sS -D - ${ORIGIN}/api/receipts/judge-missing`,
  },
  {
    id: "dry-run",
    method: "POST" as const,
    path: "/api/intents",
    title: "Unsigned dry-run",
    detail: "No wallet. Previews a 1 USD swap. Does not freeze a receipt and does not call record_execution.",
    body: '{"type":"dry_run","payload":{"intent":{"action":"swap","origin_asset":"nep141:wrap.near","destination_asset":"nep141:usdt.tether-token.near","amount":"1","amount_usd_estimate":1,"max_slippage_bps":50,"recipient":"","chain":"near","confidential":false}}}',
    form: false,
    curl: `curl -sS -X POST ${ORIGIN}/api/intents -H 'content-type: application/json' -d '{"type":"dry_run","payload":{"intent":{"action":"swap","origin_asset":"nep141:wrap.near","destination_asset":"nep141:usdt.tether-token.near","amount":"1","amount_usd_estimate":1,"max_slippage_bps":50,"recipient":"","chain":"near","confidential":false}}}'`,
  },
  {
    id: "execute-locked",
    method: "POST" as const,
    path: "/api/intents",
    title: "Execute without a proof",
    detail: "Empty execute payload and no wallet proof. Server-signer mode does not return 401. Expect 400 invalid_intent and no chain write.",
    body: '{"type":"execute","payload":{}}',
    form: false,
    curl: `curl -sS -D - -X POST ${ORIGIN}/api/intents -H 'content-type: application/json' -d '{"type":"execute","payload":{}}'`,
  },
  {
    id: "voice-empty",
    method: "POST" as const,
    path: "/api/voice-transcribe",
    title: "Voice route without audio",
    detail: "Empty multipart body. Expect 400. Does not upload a recording.",
    body: null,
    form: true,
    curl: `curl -sS -D - -X POST ${ORIGIN}/api/voice-transcribe`,
  },
  {
    id: "tee-post",
    method: "POST" as const,
    path: "/api/tee-chat",
    title: "Non-stream TEE completion",
    detail: "Calls NEAR AI and may be slow. stream is false, so the route returns one JSON body. This does not execute an intent.",
    body: '{"message":"Status check only. Do not move funds.","stream":false,"autoRedact":true}',
    form: false,
    curl: `curl -sS -X POST ${ORIGIN}/api/tee-chat -H 'content-type: application/json' -d '{"message":"Status check only. Do not move funds.","stream":false,"autoRedact":true}'`,
  },
] as const;
