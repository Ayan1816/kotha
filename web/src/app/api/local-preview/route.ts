import { NextResponse } from "next/server";
import { isLocalChatPreview } from "@/lib/local-command";
import { chatLocale, loadWalletChatBalance, runLocalChatTurn } from "@/lib/local-chat";
import { isTeeModel, TEE_MODELS } from "@/lib/near-ai-tee";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  if (!isLocalChatPreview(message)) {
    return NextResponse.json({ error: { code: "not_local", message: "This message is not a local preview." } }, { status: 400 });
  }
  if (record.model != null && (typeof record.model !== "string" || !isTeeModel(record.model))) {
    return NextResponse.json(
      { error: { code: "unsupported_model", message: "model is not in the TEE model list.", models: TEE_MODELS } },
      { status: 400 },
    );
  }
  try {
    const balance = await loadWalletChatBalance(request);
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
    const messageText = error instanceof Error ? error.message : "Local preview failed.";
    return NextResponse.json({ error: { code: "preview_failed", message: messageText } }, { status: 500 });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}
