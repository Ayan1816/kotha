import { NextResponse } from "next/server";
import { limitAiRequest } from "@/lib/ai-rate-limit";
import { getAgentState, runDryRunPreview, type BalanceBook } from "@/lib/intents-agent";
import { isLocalChatPreview } from "@/lib/local-command";
import { chatLocale, loadWalletChatBalance, runLocalChatTurn } from "@/lib/local-chat";
import { isTeeModel, pipelineTimeoutMs, readEnclaveTelemetry, runAttestedInference, TEE_MODELS, type ChatLocale } from "@/lib/near-ai-tee";
import type { LoaderStep } from "@/lib/chat-stream";

type ChatBalance = { balancesContext: unknown; balanceBook: BalanceBook | null };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const enclave = await readEnclaveTelemetry(callerKey(request));
  return NextResponse.json({
    models: TEE_MODELS,
    enclave,
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: "invalid_json", message: "Request body must be JSON." } }, { status: 400 });
  }
  const record = asRecord(body);
  const message = typeof record.message === "string" ? record.message.trim() : "";
  if (!message) {
    return NextResponse.json({ error: { code: "message_required", message: "message is required." } }, { status: 400 });
  }
  if (message.length > 8000) {
    return NextResponse.json({ error: { code: "message_too_long", message: "message exceeds 8000 characters." } }, { status: 400 });
  }
  if (record.model != null && (typeof record.model !== "string" || !isTeeModel(record.model))) {
    return NextResponse.json(
      { error: { code: "unsupported_model", message: "model is not in the TEE model list.", models: TEE_MODELS } },
      { status: 400 },
    );
  }
  if (isLocalChatPreview(message)) {
    const balance = await loadWalletChatBalance(request);
    try {
      const payload = await runLocalChatTurn({
        message,
        model: typeof record.model === "string" ? record.model : undefined,
        autoRedact: record.autoRedact !== false,
        locale: chatLocale(record.locale),
        balancesContext: balance.balancesContext,
        balanceBook: balance.balanceBook,
      });
      return NextResponse.json(payload);
    } catch (error) {
      return chatError(error);
    }
  }
  const limited = await limitAiRequest(request);
  if (!limited.ok) {
    return NextResponse.json({ error: { code: limited.code, message: limited.message } }, { status: 429 });
  }
  const balance = await loadChatBalance(request);
  const input = {
    message,
    model: typeof record.model === "string" ? record.model : undefined,
    autoRedact: record.autoRedact !== false,
    locale: chatLocale(record.locale),
    apiKey: callerKey(request),
    balancesContext: balance.balancesContext,
    balanceBook: balance.balanceBook,
  };
  if (record.stream === true) return streamChat(input);
  try {
    const payload = await runChat(input);
    return NextResponse.json(payload);
  } catch (error) {
    return chatError(error);
  }
}

function pipelineSignal(): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), pipelineTimeoutMs());
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

async function streamChat(input: ChatInput) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      let terminal = false;
      const pipeline = pipelineSignal();
      try {
        send("step", { step: "redacting" satisfies LoaderStep });
        const attestation = await infer(
          input,
          {
            onStep: (step) => {
              if (step !== "policy") send("step", { step });
            },
            onDelta: (text) => send("delta", { text }),
          },
          pipeline.signal,
        );
        if (pipeline.signal.aborted) throw new Error("Request timed out. Please try again.");
        send("step", { step: "policy" satisfies LoaderStep });
        const dryRun = attestation.decision.intent ? await runDryRunPreview(attestation.decision.intent, chatBalanceBook(input)) : null;
        send("done", { attestation, dryRun });
        terminal = true;
      } catch (error) {
        const timedOut = pipeline.signal.aborted || (error instanceof Error && error.name === "TimeoutError");
        const messageText = timedOut ? "Request timed out. Please try again." : error instanceof Error ? error.message : "TEE inference failed.";
        const status = !timedOut && messageText.startsWith("Unsupported TEE model") ? 400 : 500;
        send("error", {
          error: {
            code: timedOut ? "request_timeout" : status === 400 ? "unsupported_model" : "tee_failed",
            message: messageText,
          },
        });
        terminal = true;
      } finally {
        pipeline.cancel();
        if (!terminal) {
          try {
            send("error", { error: { code: "tee_failed", message: "TEE inference failed." } });
          } catch {
            // The stream may already be closed.
          }
        }
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

type ChatInput = {
  message: string;
  model?: string;
  autoRedact: boolean;
  locale: ChatLocale;
  apiKey: string | null;
  balancesContext: unknown;
  balanceBook: BalanceBook | null;
};

async function runChat(input: ChatInput) {
  const pipeline = pipelineSignal();
  try {
    const attestation = await infer(input, undefined, pipeline.signal);
    if (pipeline.signal.aborted) throw new Error("Request timed out. Please try again.");
    const dryRun = attestation.decision.intent ? await runDryRunPreview(attestation.decision.intent, chatBalanceBook(input)) : null;
    return { attestation, dryRun };
  } catch (error) {
    if (pipeline.signal.aborted) {
      const timeout = new Error("Request timed out. Please try again.");
      timeout.name = "TimeoutError";
      throw timeout;
    }
    throw error;
  } finally {
    pipeline.cancel();
  }
}

function chatBalanceBook(input: ChatInput): BalanceBook {
  return input.balanceBook ?? { public: {}, confidential: {}, prices: {}, skipBalance: true };
}

async function infer(
  input: ChatInput,
  hooks?: { onStep?: (step: LoaderStep) => void; onDelta?: (text: string) => void },
  signal?: AbortSignal,
) {
  const state = await getAgentState();
  return runAttestedInference({
    userMessage: input.message,
    model: input.model,
    autoRedact: input.autoRedact,
    locale: input.locale,
    apiKey: input.apiKey,
    policyContext: state.policy,
    balancesContext: input.balancesContext,
    onStep: hooks?.onStep,
    onDelta: hooks?.onDelta,
    signal,
  });
}

async function loadChatBalance(request: Request): Promise<ChatBalance> {
  return loadWalletChatBalance(request);
}

function callerKey(request: Request): string | null {
  const value = request.headers.get("x-kotha-near-ai-key")?.trim() || "";
  if (!value || value.length > 500) return null;
  return value;
}

function chatError(error: unknown) {
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.message === "Request timed out. Please try again.");
  const messageText = timedOut ? "Request timed out. Please try again." : error instanceof Error ? error.message : "TEE inference failed.";
  const status = timedOut ? 504 : messageText.startsWith("Unsupported TEE model") ? 400 : 500;
  const code = timedOut ? "request_timeout" : status === 400 ? "unsupported_model" : "tee_failed";
  return NextResponse.json({ error: { code, message: messageText } }, { status });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}
