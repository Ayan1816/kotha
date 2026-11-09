import { NextResponse } from "next/server";
import { connectedWalletAccount, limitAiRequest } from "@/lib/ai-rate-limit";
import { getAgentState, runDryRunPreview, type BalanceBook } from "@/lib/intents-agent";
import { nearBalanceBook, unavailableBalanceContext, viewAccountYocto, walletBalanceContext } from "@/lib/near-balance";
import { isTeeModel, normalizeChatLocale, readEnclaveTelemetry, runAttestedInference, TEE_MODELS, type ChatLocale } from "@/lib/near-ai-tee";
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
  const limited = await limitAiRequest(request);
  if (!limited.ok) {
    return NextResponse.json({ error: { code: limited.code, message: limited.message } }, { status: 429 });
  }
  const balance = await loadChatBalance(request);
  const input = {
    message,
    model: typeof record.model === "string" ? record.model : undefined,
    autoRedact: record.autoRedact !== false,
    locale: normalizeChatLocale(record.locale),
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

async function streamChat(input: ChatInput) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      let terminal = false;
      try {
        send("step", { step: "redacting" satisfies LoaderStep });
        const attestation = await infer(input, {
          onStep: (step) => {
            if (step !== "policy") send("step", { step });
          },
          onDelta: (text) => send("delta", { text }),
        });
        send("step", { step: "policy" satisfies LoaderStep });
        const dryRun = attestation.decision.intent ? await runDryRunPreview(attestation.decision.intent, input.balanceBook) : null;
        send("done", { attestation, dryRun });
        terminal = true;
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "TEE inference failed.";
        const status = messageText.startsWith("Unsupported TEE model") ? 400 : 500;
        send("error", { error: { code: status === 400 ? "unsupported_model" : "tee_failed", message: messageText } });
        terminal = true;
      } finally {
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
  const attestation = await infer(input);
  const dryRun = attestation.decision.intent ? await runDryRunPreview(attestation.decision.intent, input.balanceBook) : null;
  return { attestation, dryRun };
}

async function infer(input: ChatInput, hooks?: { onStep?: (step: LoaderStep) => void; onDelta?: (text: string) => void }) {
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
  });
}

async function loadChatBalance(request: Request): Promise<ChatBalance> {
  const account = connectedWalletAccount(request.headers.get("x-kotha-account"));
  if (!account) return { balancesContext: unavailableBalanceContext(), balanceBook: null };
  const yocto = await viewAccountYocto(account);
  if (!yocto) return { balancesContext: unavailableBalanceContext(), balanceBook: null };
  return { balancesContext: walletBalanceContext(account, yocto), balanceBook: nearBalanceBook(yocto) };
}

function callerKey(request: Request): string | null {
  const value = request.headers.get("x-kotha-near-ai-key")?.trim() || "";
  if (!value || value.length > 500) return null;
  return value;
}

function chatError(error: unknown) {
  const messageText = error instanceof Error ? error.message : "TEE inference failed.";
  const status = messageText.startsWith("Unsupported TEE model") ? 400 : 500;
  return NextResponse.json({ error: { code: status === 400 ? "unsupported_model" : "tee_failed", message: messageText } }, { status });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}
