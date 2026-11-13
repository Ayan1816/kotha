import { dayFromTimestampNs, sumTodayReceiptUsd, utcDayStamp } from "./budget-math";
import {
  ATTACKS,
  CORE_TEST_CASES,
  GITHUB_REPO,
  JUDGE_TITLE,
  LIVE_CONTRACT_ID,
  LIVE_ORIGIN,
  NEARBLOCKS_ACCOUNT,
  OFFICIAL_REFERENCES,
  PILLARS,
  POLICY_DAILY_CENTS,
  POLICY_DAILY_USD,
  POLICY_PER_TX_CENTS,
  POLICY_PER_TX_USD,
  PRIVACY_FILTER_MODEL,
  REST_ENDPOINTS,
  SOURCE_MODULES,
  TEE_CHAT_MODEL,
  TEST_FILES,
  WHISPER_MODEL,
} from "./judge-catalog";
import { centsToUsd, parseFrozenReceipt, type ReceiptBody } from "./receipt-canonical";

/**
 * Statement and spec builders stay off the intents client and the BIP39 wordlist.
 * Those modules are large and are not needed to describe or render stored receipts.
 */

type StoredReceipt = { bytes: string; tx_hash: string | null; chain_error: string | null };

const HEX_64 = /^[0-9a-fA-F]{64}$/;

export function buildLlmsTxt(): string {
  const lines = [
    `# ${JUDGE_TITLE}`,
    "",
    "Kotha is a Bangla-first NEAR testnet copilot. Speak a remittance or swap, redact PII, verify the NEAR AI TEE signature against the raw response body, preview the intent, and let the owner wallet record the execution under a Rust spending vault.",
    "",
    "## Live URLs",
    `- App: ${LIVE_ORIGIN}`,
    `- Docs and judge portal: ${LIVE_ORIGIN}/docs`,
    `- This index: ${LIVE_ORIGIN}/llms.txt`,
    `- OpenAPI: ${LIVE_ORIGIN}/openapi.json`,
    `- Printable audit statement: ${LIVE_ORIGIN}/api/receipts/export-statement`,
    `- GitHub: ${GITHUB_REPO}`,
    `- NearBlocks: ${NEARBLOCKS_ACCOUNT}`,
    "",
    "## Cryptographic pillars",
    "",
    `### 1. Prohori Firewall & Rust Policy Vault (${LIVE_CONTRACT_ID}) + NEP-413 Owner Authentication`,
    `- Contract account: ${LIVE_CONTRACT_ID}`,
    "- Methods: record_execution(execution: VerifiedExecution) and get_execution(correlation_id).",
    "- Owner actions require a NEP-413 signature. The server checks nonce length, proof age, owner id, RPC view_access_key_list, and nep413 verifyMessage.",
    `- Init policy limits: daily $${POLICY_DAILY_USD} (${POLICY_DAILY_CENTS} cents), per-transaction $${POLICY_PER_TX_USD} (${POLICY_PER_TX_CENTS} cents). Shield and unshield count toward the UTC-day spend.`,
    "- Chat, voice, and dry-run stay available without a wallet. Execute, policy save, grant rotation, revoke, emergency freeze, and save_tx return 401 when an owner id is configured and the request has no valid NEP-413 wallet proof. Admin mode skips that proof. A wallet object that is present still fails closed on a bad proof.",
    "",
    "### 2. Kotha TEE Enclave",
    `- Chat model: ${TEE_CHAT_MODEL}`,
    "- Verification uses the real NEAR AI endpoints /v1/signature/{chat_id} and /v1/attestation/report.",
    "- Green verified only when ECDSA recovery matches a report signing_address and the hash inside the signed text matches SHA-256 of the raw chat HTTP body.",
    "- SSE is assembled only to read the chat id and the assistant content. A mismatch leaves the receipt unverified and blocks execute. Kotha does not fake a TDX or NVIDIA quote and does not send a second non-stream completion.",
    `- Voice fallback: Whisper ${WHISPER_MODEL}, used only when the browser has no Web Speech constructor.`,
    `- Dual-layer PII redaction: Bangladesh mobiles (including Bengali digits) and global E.164, plus email, NID, Luhn cards, and BIP39 seeds, then ${PRIVACY_FILTER_MODEL} when the NEAR AI key is configured.`,
    "",
    "### 3. Shakkhi On-Chain Audit Vault",
    "- record_execution and get_execution run on NEAR Testnet against the Prohori vault.",
    "- NEAR Intents public and confidential dry-run and execution. dry_run is unsigned and does not require a wallet. Execute without a valid wallet proof returns 401 when an owner id is configured. A present proof is verified, then the wallet anchors.",
    "- Wallet-authenticated execute sets skipChain and uses callFunctionRaw with args { execution: VerifiedExecution }, gas 30000000000000, deposit 0. Server-signer execute broadcasts with NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY when those are set.",
    "- Hash mapping: receipt hash is response_sha256, intent hash is request_sha256. Not a bare { receipt_hash }.",
    "- usd_amount_cents and timestamp_ns stay digit strings so values above 2^53 survive the wallet's JSON.parse. The Rust ABI is unchanged.",
    "",
    "## Core source modules",
    ...SOURCE_MODULES.map((mod) => `- ${mod.path} — ${mod.role}`),
    "",
    "## REST API",
    ...REST_ENDPOINTS.map((endpoint) => `- ${endpoint}`),
    "- GET /api/receipts/[id] is the App Router file web/src/app/api/receipts/[id]/route.ts. OpenAPI writes that path as /api/receipts/{id}.",
    "- POST /api/intents types: dry_run, execute, update_policy, rotate_grant, revoke_grant, emergency_freeze, save_tx.",
    "- POST /api/tee-chat accepts message (max 8000), optional model, autoRedact, and stream. stream true returns text/event-stream.",
    "- POST /api/voice-transcribe expects multipart field audio. The upstream field is file.",
    "",
    "## Automated verification tests",
    `${CORE_TEST_CASES} core node:test cases across the files below, plus judge-portal response checks for /llms.txt, /openapi.json, and /api/receipts/export-statement.`,
    ...TEST_FILES.map((file) => `- ${file.file}: ${file.cases} — ${file.covers}`),
    `- Core total: ${TEST_FILES.reduce((sum, file) => sum + file.cases, 0)}`,
    "",
    "Attack vectors covered by those tests:",
    ...ATTACKS.map((attack) => `- ${attack.vector}: ${attack.rejection} (${attack.tests})`),
    "",
    "## Honest boundary",
    "- Testnet Demo. Chat and dry-run are live service calls. Chain writes require the owner wallet on testnet.",
    "- The audit statement lists stored receipts and tells a reader to re-verify ECDSA. It does not itself mark a receipt TEE verified.",
    "- Official references: " + JSON.stringify(OFFICIAL_REFERENCES),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export function buildOpenApiSpec() {
  const errorSchema = {
    type: "object",
    properties: {
      error: {
        type: "object",
        properties: {
          code: { type: "string" },
          message: { type: "string" },
        },
        required: ["code", "message"],
      },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Kotha API",
      version: "1.0.0",
      summary: JUDGE_TITLE,
      description:
        "HTTP API for the Kotha testnet copilot: TEE chat, NEAR Intents dry-run and owner actions, frozen receipts, the Shakkhi vault, and the judge portal documents.",
    },
    externalDocs: {
      description: "Kotha docs and judge portal",
      url: `${LIVE_ORIGIN}/docs`,
    },
    "x-official-references": OFFICIAL_REFERENCES,
    servers: [{ url: LIVE_ORIGIN, description: "Live Kotha deployment" }],
    paths: {
      "/api/tee-chat": {
        get: {
          operationId: "getTeeChat",
          summary: "List TEE models and enclave telemetry",
          responses: {
            "200": {
              description: "models and enclave",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
        post: {
          operationId: "postTeeChat",
          summary: "Redact, complete, and verify a TEE chat",
          description:
            "message is required (max 8000). model must be in the TEE model list. autoRedact defaults to true. stream true returns text/event-stream events step, delta, done, and error. Otherwise JSON { attestation, dryRun }.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["message"],
                  properties: {
                    message: { type: "string", maxLength: 8000 },
                    model: { type: "string", examples: [TEE_CHAT_MODEL] },
                    autoRedact: { type: "boolean" },
                    stream: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "JSON attestation or SSE stream" },
            "400": { description: "Invalid message or model", content: { "application/json": { schema: errorSchema } } },
          },
        },
      },
      "/api/intents": {
        get: {
          operationId: "getIntents",
          summary: "Network, tokens, agent policy, vault, and executions",
          responses: { "200": { description: "Dashboard catalog" } },
        },
        post: {
          operationId: "postIntents",
          summary: "Dry-run or owner-gated intent action",
          description:
            "type is dry_run, execute, update_policy, rotate_grant, revoke_grant, emergency_freeze, or save_tx. dry_run is unsigned. Other types accept either a valid NEP-413 wallet proof or no wallet object (server signer / API-key mode, not a 401). A wallet object that fails verification returns 401 owner_required, proof_expired, or proof_invalid. Wallet execute anchors with skipChain. Server-signer execute broadcasts when NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY are set.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["type"],
                  properties: {
                    type: { type: "string" },
                    payload: { type: "object" },
                    wallet: { type: "object", description: "NEP-413 proof. Omit for dry_run and for server-signer mode." },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Action result" },
            "400": { description: "Invalid action or payload", content: { "application/json": { schema: errorSchema } } },
            "401": { description: "Owner proof rejected", content: { "application/json": { schema: errorSchema } } },
            "404": { description: "save_tx receipt missing", content: { "application/json": { schema: errorSchema } } },
          },
        },
      },
      "/api/receipts/{id}": {
        get: {
          operationId: "getReceipt",
          summary: "Download one frozen receipt",
          description:
            "App Router file path is /api/receipts/[id] (web/src/app/api/receipts/[id]/route.ts). OpenAPI uses {id}. The body is the exact stored canonical JSON. Filename kotha-receipt-<id>.json.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", maxLength: 200 } },
          ],
          responses: {
            "200": { description: "Frozen receipt bytes", content: { "application/json": { schema: { type: "object" } } } },
            "400": { description: "Missing or oversized id", content: { "application/json": { schema: errorSchema } } },
            "404": { description: "receipt_not_found", content: { "application/json": { schema: errorSchema } } },
          },
        },
      },
      "/api/receipts/export-statement": {
        get: {
          operationId: "getAuditStatement",
          summary: "Printable executive cryptographic audit statement",
          description:
            "Self-contained HTML. Lists today's UTC stored receipts, canonical SHA-256 hashes, init policy limits, an honest TEE re-verify note, PII token counts, and NearBlocks links. Does not mark a receipt TEE verified.",
          responses: {
            "200": { description: "HTML statement", content: { "text/html": { schema: { type: "string" } } } },
          },
        },
      },
      "/api/vault/execution": {
        get: {
          operationId: "getVaultExecution",
          summary: "Raw get_execution JSON",
          parameters: [{ name: "id", in: "query", required: true, schema: { type: "string", maxLength: 200 } }],
          responses: {
            "200": { description: "{ raw } from the testnet vault" },
            "400": { description: "Missing or oversized id", content: { "application/json": { schema: errorSchema } } },
          },
        },
      },
      "/api/voice-transcribe": {
        post: {
          operationId: "postVoiceTranscribe",
          summary: "Whisper fallback transcription",
          description: `Multipart field audio, optional language bn or en. Forwarded to NEAR AI as file with model ${WHISPER_MODEL}. Returns { text }. 503 when the NEAR AI key is unset. 413 above 12 MB.`,
          requestBody: {
            required: true,
            content: { "multipart/form-data": { schema: { type: "object", properties: { audio: { type: "string", format: "binary" }, language: { type: "string" } } } } },
          },
          responses: {
            "200": { description: "{ text }" },
            "400": { description: "Missing audio" },
            "413": { description: "Audio too large" },
            "503": { description: "Transcription key unset" },
          },
        },
      },
      "/llms.txt": {
        get: {
          operationId: "getLlmsTxt",
          summary: "Machine-readable AI judge index",
          responses: { "200": { description: "text/plain judge index", content: { "text/plain": { schema: { type: "string" } } } } },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "getOpenApi",
          summary: "This document",
          responses: { "200": { description: "OpenAPI 3.1.0 JSON" } },
        },
      },
    },
  };
}

export function buildAuditStatementHtml(input: {
  contractId: string;
  records: Record<string, StoredReceipt>;
  generatedAt: string;
}): string {
  const day = utcDayStamp();
  const spent = sumTodayReceiptUsd(Object.values(input.records), day);
  const rows = todayRows(input.records, day);
  const pii = piiSummary(rows.map((row) => row.bytes));
  const body = rows.length === 0 ? `<p>No stored execution receipts for this UTC day.</p>` : table(rows);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kotha Executive Cryptographic Audit & Reconciliation Statement</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font-family: Georgia, "Noto Sans Bengali", serif; color: #102018; background: #f4f7f5; }
  main { max-width: 920px; margin: 0 auto; padding: 72px 24px 48px; }
  h1 { font-size: 1.45rem; line-height: 1.3; margin: 0 0 8px; }
  h2 { font-size: 1.05rem; margin: 28px 0 8px; }
  p, li { line-height: 1.45; }
  code, td { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; background: #fff; }
  th, td { border: 1px solid #c9d5ce; padding: 8px; vertical-align: top; text-align: left; word-break: break-all; }
  th { background: #e7f6ef; }
  a { color: #0b6b45; }
  .meta { color: #3d5148; font-size: 0.92rem; }
  .print-btn { position: fixed; top: 16px; right: 16px; background: #00EC97; color: #04140c; border: 0; border-radius: 999px; padding: 10px 16px; font-weight: 700; cursor: pointer; }
  @media print { .print-btn { display: none !important; } body { background: #fff; } main { padding-top: 0; } }
</style>
</head>
<body>
<button class="print-btn" type="button" onclick="window.print()">Print / Save as PDF</button>
<main>
  <h1>Kotha Executive Cryptographic Audit & Reconciliation Statement</h1>
  <p class="meta">Generated ${esc(input.generatedAt)} · UTC day ${esc(day)} · This page does not call NEAR Intents and does not mark a receipt TEE verified.</p>
  <h2>Live contract</h2>
  <p>Live contract ID: <code>${esc(LIVE_CONTRACT_ID)}</code></p>
  <p>Resolved for this process: <code>${esc(input.contractId)}</code></p>
  <p>NearBlocks account: <a href="${esc(NEARBLOCKS_ACCOUNT)}">${esc(NEARBLOCKS_ACCOUNT)}</a></p>
  <h2>Policy limits</h2>
  <p>Deployed init limits from the vault policy (dailyBudgetUsd ${POLICY_DAILY_USD}, perTxCapUsd ${POLICY_PER_TX_USD}). This statement does not call the intents network. The live owner policy is on GET /api/intents <code>agentState.policy</code>.</p>
  <ul>
    <li>Daily budget: $${POLICY_DAILY_USD} (${POLICY_DAILY_CENTS} cents)</li>
    <li>Per-transaction cap: $${POLICY_PER_TX_USD} (${POLICY_PER_TX_CENTS} cents)</li>
    <li>Today's stored spend (UTC day ${esc(day)}): $${esc(spent.toFixed(2))}</li>
  </ul>
  <h2>Today's stored execution receipts</h2>
  ${body}
  <h2>PII redaction summary</h2>
  <p>${esc(pii)}</p>
  <h2>Pillars checked by this statement</h2>
  <ol>
    ${PILLARS.map((pillar) => `<li>${esc(pillar.name)} — ${esc(pillar.summary)}</li>`).join("")}
  </ol>
</main>
</body>
</html>
`;
}

function todayRows(records: Record<string, StoredReceipt>, day: string) {
  const rows: Array<StoredReceipt & { id: string; receipt: ReceiptBody; receipt_hash: string }> = [];
  for (const [id, record] of Object.entries(records)) {
    const parsed = parseFrozenReceipt(record.bytes);
    if (!parsed) continue;
    if (dayFromTimestampNs(parsed.receipt.timestamp_ns) !== day) continue;
    rows.push({ id, ...record, receipt: parsed.receipt, receipt_hash: parsed.receipt_hash });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
}

function table(rows: Array<StoredReceipt & { id: string; receipt: ReceiptBody; receipt_hash: string }>): string {
  const head = `<table><thead><tr><th>Id</th><th>Action</th><th>USD</th><th>Canonical SHA-256 receipt_hash</th><th>TEE verification status</th><th>NearBlocks</th></tr></thead><tbody>`;
  const body = rows
    .map((row) => {
      const usd = safeUsd(row.receipt.usd_amount_cents);
      return `<tr><td>${esc(row.id)}</td><td>${esc(row.receipt.action)}</td><td>${esc(usd)}</td><td><code>${esc(row.receipt_hash)}</code></td><td>${esc(teeStatus(row.receipt))}</td><td>${txCell(row.tx_hash, row.chain_error)}</td></tr>`;
    })
    .join("");
  return `${head}${body}</tbody></table>`;
}

function teeStatus(receipt: ReceiptBody): string {
  const signature = receipt.signature || "";
  const address = receipt.signing_address || "";
  const requestHash = receipt.request_sha256 || "";
  const responseHash = receipt.response_sha256 || "";
  if (signature.length >= 64 && /^0x[0-9a-fA-F]{40}$/.test(address) && HEX_64.test(requestHash) && HEX_64.test(responseHash)) {
    return "Fields frozen. Re-verify ECDSA against NEAR AI /v1/signature and /v1/attestation/report before treating this as TEE verified.";
  }
  return "Unverified — signature, signing address, or hashes are missing on the frozen receipt.";
}

function piiSummary(blobs: string[]): string {
  const counts: Record<string, number> = { PHONE: 0, EMAIL: 0, ID: 0, CARD: 0, SEED: 0 };
  let rawBd = 0;
  const tokenRe = /\[REDACTED_(PHONE|EMAIL|ID|CARD|SEED)\]/g;
  const bdRe = /(?:\+?880|0)1[3-9]\d{8}/g;
  for (const bytes of blobs) {
    tokenRe.lastIndex = 0;
    for (const match of bytes.matchAll(tokenRe)) {
      const kind = match[1];
      if (kind) counts[kind] = (counts[kind] ?? 0) + 1;
    }
    bdRe.lastIndex = 0;
    rawBd += bytes.match(bdRe)?.length ?? 0;
  }
  const present = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `[REDACTED_${kind}] x ${count}`);
  const tokens = present.length > 0 ? present.join(", ") : "No redaction tokens in today's frozen receipt bytes.";
  const raw = rawBd > 0 ? `BD mobile pattern still present in frozen bytes (${rawBd}).` : "No raw Bangladesh mobile pattern in today's frozen receipt bytes.";
  return `${tokens} ${raw} Second-layer redaction uses ${PRIVACY_FILTER_MODEL} when the NEAR AI key is set. This statement does not re-run the redactor.`;
}

function txCell(txHash: string | null, chainError: string | null): string {
  const hash = (txHash || "").trim();
  const error = chainError ? `<div>${esc(chainError)}</div>` : "";
  if (!hash) return `—${error}`;
  const url = `https://testnet.nearblocks.io/txns/${encodeURIComponent(hash)}`;
  return `<a href="${esc(url)}">${esc(url)}</a>${error}`;
}

function safeUsd(cents: string): string {
  if (!/^\d+$/.test(cents || "")) return cents || "";
  try {
    return centsToUsd(cents);
  } catch {
    return cents;
  }
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
