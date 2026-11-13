import { connectedWalletAccount } from "./ai-rate-limit";
import type { AttestedInference, DryRunPreview } from "./dashboard-types";
import { getAgentState, runDryRunPreview, type BalanceBook } from "./intents-agent";
import { nearBalanceBook, unavailableBalanceContext, viewAccountYocto, walletBalanceContext } from "./near-balance";
import { normalizeChatLocale, runAttestedInference, type ChatLocale } from "./near-ai-tee";

export type WalletChatBalance = { balancesContext: unknown; balanceBook: BalanceBook | null };

export async function loadWalletChatBalance(request: Request): Promise<WalletChatBalance> {
  const account = connectedWalletAccount(request.headers.get("x-kotha-account"));
  if (!account) return { balancesContext: unavailableBalanceContext(), balanceBook: null };
  const yocto = await viewAccountYocto(account);
  if (!yocto) return { balancesContext: unavailableBalanceContext(), balanceBook: null };
  return { balancesContext: walletBalanceContext(account, yocto), balanceBook: nearBalanceBook(yocto) };
}

export async function runLocalChatTurn(input: {
  message: string;
  model?: string;
  autoRedact: boolean;
  locale: ChatLocale;
  balancesContext: unknown;
  balanceBook: BalanceBook | null;
}): Promise<{ attestation: AttestedInference; dryRun: DryRunPreview | null }> {
  const state = await getAgentState();
  const attestation = await runAttestedInference({
    userMessage: input.message,
    model: input.model,
    autoRedact: input.autoRedact,
    locale: input.locale,
    policyContext: state.policy,
    balancesContext: input.balancesContext,
    apiKey: null,
  });
  const book = input.balanceBook ?? { public: {}, confidential: {}, prices: {}, skipBalance: true };
  const dryRun = attestation.decision.intent ? await runDryRunPreview(attestation.decision.intent, book) : null;
  return { attestation, dryRun };
}

export function chatLocale(value: unknown): ChatLocale {
  return normalizeChatLocale(typeof value === "string" ? value : null);
}
