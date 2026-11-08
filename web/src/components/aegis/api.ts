import type {
  ApiErrorBody,
  DashboardResponse,
  DryRunPreview,
  DryRunResponse,
  ExecuteResponse,
  FreezeResponse,
  GrantResponse,
  PolicyPatch,
  PolicyUpdateResponse,
  TeeCatalogResponse,
  TeeChatResponse,
} from "@/lib/dashboard-types";
import { isLoaderStep, parseSseBlock, type LoaderStep } from "@/lib/chat-stream";
import type { WalletProofWire } from "@/lib/wallet-proof";

export class DeckRequestError extends Error {
  readonly code: string;
  readonly preview: DryRunPreview | null;

  constructor(code: string, message: string, preview: DryRunPreview | null = null) {
    super(message);
    this.name = "DeckRequestError";
    this.code = code;
    this.preview = preview;
  }
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function fail(data: unknown, status: number): DeckRequestError {
  const body = (data ?? {}) as ApiErrorBody;
  return new DeckRequestError(
    body.error?.code || "request_failed",
    body.error?.message || `Request failed (${status}).`,
    body.error?.preview ?? null,
  );
}

export async function fetchDashboard(): Promise<DashboardResponse> {
  const response = await fetch("/api/intents", { cache: "no-store" });
  const data = await readJson(response);
  if (!response.ok) throw fail(data, response.status);
  if (!isRecord(data) || !isRecord(data.agentState) || !isRecord(data.vaultInfo) || !Array.isArray(data.executions)) {
    throw new DeckRequestError("bad_response", "Dashboard response was missing agent state.");
  }
  return data as DashboardResponse;
}

const NEAR_AI_STORAGE = "kotha-near-ai-key";

function withNearAiKey(headers: Record<string, string>): Record<string, string> {
  if (typeof window === "undefined") return headers;
  try {
    const key = window.sessionStorage.getItem(NEAR_AI_STORAGE)?.trim();
    if (key) headers["x-kotha-near-ai-key"] = key;
  } catch {
    // sessionStorage can throw in a locked browser.
  }
  return headers;
}

export async function fetchTeeCatalog(): Promise<TeeCatalogResponse> {
  const response = await fetch("/api/tee-chat", { cache: "no-store", headers: withNearAiKey({}) });
  const data = await readJson(response);
  if (!response.ok) throw fail(data, response.status);
  if (!isRecord(data) || !isRecord(data.enclave) || !Array.isArray(data.models)) {
    throw new DeckRequestError("bad_response", "TEE catalog response was missing enclave telemetry.");
  }
  return data as TeeCatalogResponse;
}

export async function postTeeChat(body: { message: string; model: string; autoRedact: boolean; locale?: string }): Promise<TeeChatResponse> {
  const response = await fetch("/api/tee-chat", {
    method: "POST",
    headers: withNearAiKey({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  const data = await readJson(response);
  if (!response.ok) throw fail(data, response.status);
  return readTeeChat(data);
}

export async function postTeeChatStream(
  body: { message: string; model: string; autoRedact: boolean; locale?: string },
  handlers: { onStep?: (step: LoaderStep) => void; onDelta?: (text: string) => void } = {},
): Promise<TeeChatResponse> {
  const response = await fetch("/api/tee-chat", {
    method: "POST",
    headers: withNearAiKey({ "content-type": "application/json", accept: "text/event-stream" }),
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!response.ok) {
    const data = await readJson(response);
    throw fail(data, response.status);
  }
  if (!response.body) throw new DeckRequestError("bad_response", "TEE chat stream was empty.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let donePayload: TeeChatResponse | null = null;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const parsed = parseSseBlock(part);
      if (!parsed) continue;
      if (parsed.event === "step") {
        const step = isRecord(parsed.data) && typeof parsed.data.step === "string" ? parsed.data.step : "";
        if (isLoaderStep(step)) handlers.onStep?.(step);
      } else if (parsed.event === "delta") {
        const text = isRecord(parsed.data) && typeof parsed.data.text === "string" ? parsed.data.text : "";
        if (text) handlers.onDelta?.(text);
      } else if (parsed.event === "error") {
        const data = parsed.data;
        throw fail(isRecord(data) ? data : { error: { message: "TEE chat failed." } }, 500);
      } else if (parsed.event === "done") {
        donePayload = readTeeChat(parsed.data);
      }
    }
  }
  if (!donePayload) throw new DeckRequestError("bad_response", "TEE chat stream ended before a result.");
  return donePayload;
}

function readTeeChat(data: unknown): TeeChatResponse {
  if (!isRecord(data) || !isRecord(data.attestation) || !isRecord((data.attestation as { decision?: unknown }).decision)) {
    throw new DeckRequestError("bad_response", "TEE chat response was missing attestation.");
  }
  return data as TeeChatResponse;
}

export async function postPolicy(policy: PolicyPatch, wallet: WalletProofWire): Promise<PolicyUpdateResponse> {
  return postIntent<PolicyUpdateResponse>("update_policy", { policy }, wallet);
}

export async function postGrant(type: "rotate_grant" | "revoke_grant", wallet: WalletProofWire): Promise<GrantResponse> {
  return postIntent<GrantResponse>(type, {}, wallet);
}

export async function postFreeze(frozen: boolean, wallet: WalletProofWire): Promise<FreezeResponse> {
  return postIntent<FreezeResponse>("emergency_freeze", { frozen }, wallet);
}

export async function postDryRun(intent: unknown): Promise<DryRunResponse> {
  return postIntent<DryRunResponse>("dry_run", { intent });
}

export async function postExecute(
  intent: unknown,
  teeAttestation: Record<string, string>,
  wallet: WalletProofWire,
): Promise<ExecuteResponse> {
  return postIntent<ExecuteResponse>("execute", { intent, teeAttestation }, wallet);
}

export async function postSaveTx(id: string, txHash: string, wallet: WalletProofWire): Promise<{ type: "save_tx"; id: string; tx_hash: string }> {
  return postIntent("save_tx", { id, tx_hash: txHash }, wallet);
}

async function postIntent<T>(type: string, payload: Record<string, unknown>, wallet?: WalletProofWire | null): Promise<T> {
  const body: Record<string, unknown> = { type, payload };
  if (wallet) body.wallet = wallet;
  const response = await fetch("/api/intents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readJson(response);
  if (!response.ok) throw fail(data, response.status);
  if (!isRecord(data)) throw new DeckRequestError("bad_response", "Intent response was empty.");
  return data as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
