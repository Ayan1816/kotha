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
  const response = await fetch("/api/intents", { cache: "no-store", credentials: "include" });
  const data = await readJson(response);
  if (!response.ok) throw fail(data, response.status);
  if (!isRecord(data) || !isRecord(data.agentState) || !isRecord(data.vaultInfo) || !Array.isArray(data.executions)) {
    throw new DeckRequestError("bad_response", "Dashboard response was missing agent state.");
  }
  return data as DashboardResponse;
}

const NEAR_AI_STORAGE = "kotha-near-ai-key";
const NEAR_AI_MAX = 500;

export function readNearAiSessionKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(NEAR_AI_STORAGE)?.trim() || "";
  } catch {
    return "";
  }
}

export function saveNearAiSessionKey(value: string): boolean {
  if (typeof window === "undefined") return false;
  const trimmed = value.trim();
  if (trimmed.length > NEAR_AI_MAX) return false;
  try {
    if (!trimmed) window.sessionStorage.removeItem(NEAR_AI_STORAGE);
    else window.sessionStorage.setItem(NEAR_AI_STORAGE, trimmed);
    return true;
  } catch {
    return false;
  }
}

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

function aiHeaders(headers: Record<string, string>, accountId?: string): Record<string, string> {
  const account = accountId?.trim() || "";
  if (account) headers["x-kotha-account"] = account.slice(0, 80);
  return withNearAiKey(headers);
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

export async function postTeeChat(body: { message: string; model: string; autoRedact: boolean; locale?: string; accountId?: string }): Promise<TeeChatResponse> {
  const { accountId, ...payload } = body;
  const response = await fetch("/api/tee-chat", {
    method: "POST",
    credentials: "include",
    headers: aiHeaders({ "content-type": "application/json" }, accountId),
    body: JSON.stringify(payload),
  });
  const data = await readJson(response);
  if (!response.ok) throw fail(data, response.status);
  return readTeeChat(data);
}

export async function postTranslate(body: { text: string; target: "bn" | "en"; accountId?: string }): Promise<string> {
  const { accountId, ...payload } = body;
  const response = await fetch("/api/translate", {
    method: "POST",
    credentials: "include",
    headers: aiHeaders({ "content-type": "application/json" }, accountId),
    body: JSON.stringify(payload),
  });
  const data = await readJson(response);
  if (!response.ok) throw fail(data, response.status);
  if (!isRecord(data) || typeof data.text !== "string" || !data.text.trim()) {
    throw new DeckRequestError("translate_failed", "Translation failed.");
  }
  return data.text.trim();
}

export async function postTranslateMany(body: { texts: string[]; target: "bn" | "en"; accountId?: string }): Promise<string[]> {
  const { accountId, texts, target } = body;
  const response = await fetch("/api/translate", {
    method: "POST",
    credentials: "include",
    headers: aiHeaders({ "content-type": "application/json" }, accountId),
    body: JSON.stringify({ texts, target }),
  });
  const data = await readJson(response);
  if (!response.ok) throw fail(data, response.status);
  if (!isRecord(data) || !Array.isArray(data.texts) || data.texts.length !== texts.length) {
    throw new DeckRequestError("translate_failed", "Translation failed.");
  }
  const translated = data.texts.map((item) => (typeof item === "string" ? item.trim() : ""));
  if (translated.some((item) => !item)) throw new DeckRequestError("translate_failed", "Translation failed.");
  return translated;
}

export async function postTeeChatStream(
  body: { message: string; model: string; autoRedact: boolean; locale?: string; accountId?: string },
  handlers: { onStep?: (step: LoaderStep) => void; onDelta?: (text: string) => void; onDone?: () => void } = {},
): Promise<TeeChatResponse> {
  const { accountId, ...payload } = body;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 48_000);
  try {
    const response = await fetch("/api/tee-chat", {
      method: "POST",
      credentials: "include",
      headers: aiHeaders({ "content-type": "application/json", accept: "text/event-stream" }, accountId),
      body: JSON.stringify({ ...payload, stream: true }),
      signal: controller.signal,
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
  } catch (error) {
    if (error instanceof DeckRequestError) throw error;
    if (controller.signal.aborted) {
      throw new DeckRequestError("request_timeout", "Request timed out. Please try again.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    handlers.onDone?.();
  }
}

function readTeeChat(data: unknown): TeeChatResponse {
  if (!isRecord(data) || !isRecord(data.attestation) || !isRecord((data.attestation as { decision?: unknown }).decision)) {
    throw new DeckRequestError("bad_response", "TEE chat response was missing attestation.");
  }
  return data as TeeChatResponse;
}

export async function postPolicy(policy: PolicyPatch, wallet?: WalletProofWire | null): Promise<PolicyUpdateResponse> {
  return postIntent<PolicyUpdateResponse>("update_policy", { policy }, wallet);
}

export async function postGrant(type: "rotate_grant" | "revoke_grant", wallet?: WalletProofWire | null): Promise<GrantResponse> {
  return postIntent<GrantResponse>(type, {}, wallet);
}

export async function postFreeze(frozen: boolean, wallet?: WalletProofWire | null): Promise<FreezeResponse> {
  return postIntent<FreezeResponse>("emergency_freeze", { frozen }, wallet);
}

export async function postDryRun(intent: unknown, accountId?: string): Promise<DryRunResponse> {
  return postIntent<DryRunResponse>("dry_run", { intent }, undefined, accountId);
}

export async function postExecute(
  intent: unknown,
  teeAttestation: Record<string, string>,
  wallet?: WalletProofWire | null,
): Promise<ExecuteResponse> {
  return postIntent<ExecuteResponse>("execute", { intent, teeAttestation }, wallet);
}

export async function postSaveTx(id: string, txHash: string, wallet?: WalletProofWire | null): Promise<{ type: "save_tx"; id: string; tx_hash: string }> {
  return postIntent("save_tx", { id, tx_hash: txHash }, wallet);
}

export async function postAdminUnlock(code: string): Promise<{ type: "admin_unlock"; admin: true }> {
  return postIntent("admin_unlock", { code });
}

export async function postAdminLock(): Promise<{ type: "admin_lock"; admin: false }> {
  return postIntent("admin_lock", {});
}

async function postIntent<T>(type: string, payload: Record<string, unknown>, wallet?: WalletProofWire | null, accountId?: string): Promise<T> {
  const body: Record<string, unknown> = { type, payload };
  if (wallet) body.wallet = wallet;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const account = accountId?.trim() || "";
  if (account) headers["x-kotha-account"] = account.slice(0, 80);
  const response = await fetch("/api/intents", {
    method: "POST",
    credentials: "include",
    headers,
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
