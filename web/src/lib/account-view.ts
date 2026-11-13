import { rpcCandidates, VIEW_TIMEOUT_MS } from "./near-rpc";

export type AccountViewStatus = "exists" | "missing" | "unknown";

/** Classify a view_account JSON-RPC body. A network failure is not this function's job. */
export function accountStatusFromBody(body: unknown): AccountViewStatus {
  if (!body || typeof body !== "object") return "unknown";
  const row = body as {
    result?: { amount?: unknown };
    error?: { message?: unknown; cause?: { name?: unknown }; data?: unknown };
  };
  const amount = row.result?.amount;
  if (typeof amount === "string" && /^\d+$/.test(amount)) return "exists";
  const causeName = typeof row.error?.cause?.name === "string" ? row.error.cause.name : "";
  const message = errorText(row.error);
  if (causeName === "UNKNOWN_ACCOUNT" || /does not exist/i.test(message)) return "missing";
  return "unknown";
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const row = error as { message?: unknown; data?: unknown; cause?: { info?: unknown } };
  const parts = [row.message, row.data, row.cause?.info].filter((part) => typeof part === "string") as string[];
  return parts.join(" ");
}

/**
 * view_account against the testnet RPC list.
 * exists: the account has a balance. missing: UNKNOWN_ACCOUNT. unknown: every endpoint failed.
 */
export async function viewAccountStatus(accountId: string, fetchImpl: typeof fetch = fetch): Promise<AccountViewStatus> {
  const account = accountId.trim();
  if (!account) return "unknown";
  for (const url of rpcCandidates()) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "kotha-account",
          method: "query",
          params: { request_type: "view_account", finality: "final", account_id: account },
        }),
        signal: AbortSignal.timeout(VIEW_TIMEOUT_MS),
      });
      const body = (await response.json()) as unknown;
      const status = accountStatusFromBody(body);
      if (status === "exists" || status === "missing") return status;
    } catch {
      // The next endpoint may still answer. All failures become unknown.
    }
  }
  return "unknown";
}
