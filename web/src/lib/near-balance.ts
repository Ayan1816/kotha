import { atomicToHuman, type BalanceBook } from "./intents-agent";
import { publicNetwork } from "./wallet-proof";

const WRAP_NEAR = "nep141:wrap.near";

export function balanceRpcUrl(): string {
  const configured = process.env.NEAR_RPC_URL?.trim() || "";
  if (configured) return configured;
  return publicNetwork() === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org";
}

export function yoctoToHumanNear(yocto: string): string {
  return atomicToHuman(BigInt(yocto), 24);
}

/** Live account balance from view_account. Null means unknown, not zero. */
export async function viewAccountYocto(accountId: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const account = accountId.trim();
  if (!account) return null;
  try {
    const response = await fetchImpl(balanceRpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "kotha-balance",
        method: "query",
        params: { request_type: "view_account", finality: "final", account_id: account },
      }),
      signal: AbortSignal.timeout(4_000),
    });
    const body = (await response.json()) as { result?: { amount?: unknown } };
    const amount = body.result?.amount;
    if (typeof amount !== "string" || !/^\d+$/.test(amount)) return null;
    return amount;
  } catch {
    return null;
  }
}

export function nearBalanceBook(yocto: string): BalanceBook {
  return {
    public: { [WRAP_NEAR]: BigInt(yocto) },
    confidential: {},
    prices: {},
  };
}

export function unavailableBalanceContext(): {
  balanceAvailable: false;
  near: null;
  public: Record<string, never>;
  confidential: Record<string, never>;
} {
  return { balanceAvailable: false, near: null, public: {}, confidential: {} };
}

export function walletBalanceContext(accountId: string, yocto: string): {
  balanceAvailable: true;
  accountId: string;
  near: string;
  public: Record<string, string>;
  confidential: Record<string, never>;
} {
  return {
    balanceAvailable: true,
    accountId,
    near: yoctoToHumanNear(yocto),
    public: { [WRAP_NEAR]: yocto },
    confidential: {},
  };
}
