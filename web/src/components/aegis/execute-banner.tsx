import { translate, type Lang } from "@/components/aegis/copy";
import { describeExecuteOutcome, type CardOutcome } from "@/lib/native-transfer";
import { explorerTxUrl, TESTNET_FAUCET_URL } from "@/lib/wallet-proof";

export function ExecuteBanner({ lang, outcome }: { lang: Lang; outcome: CardOutcome | null }) {
  if (!outcome) return null;
  const shell =
    outcome.tone === "ok"
      ? "border-[#00EC97]/50 bg-[#00EC97]/12 text-[#d9ffe8]"
      : outcome.tone === "warn"
        ? "border-[#FF8A00]/50 bg-[#FF8A00]/12 text-[#ffd7a1]"
        : "border-[#FF3B5C]/50 bg-[#FF3B5C]/12 text-[#ffb3c0]";
  return (
    <div role="status" className={`mt-3 min-w-0 rounded-xl border px-3 py-2 text-sm ${shell}`}>
      <p className="min-w-0 break-words">{describeExecuteOutcome(lang, outcome)}</p>
      {outcome.transferHash ? (
        <a href={explorerTxUrl(outcome.transferHash)} target="_blank" rel="noreferrer" className="mt-1 block break-all text-[#7DD3FC] underline-offset-2 hover:underline">
          {translate(lang, "viewOnExplorer")}
        </a>
      ) : null}
      {outcome.proofHash ? (
        <a href={explorerTxUrl(outcome.proofHash)} target="_blank" rel="noreferrer" className="mt-1 block break-all text-[#7DD3FC] underline-offset-2 hover:underline">
          {translate(lang, "executeProofLink")}
        </a>
      ) : null}
      {outcome.faucet ? (
        <a href={TESTNET_FAUCET_URL} target="_blank" rel="noreferrer" className="mt-1 block text-[#7DD3FC] underline-offset-2 hover:underline">
          {translate(lang, "faucetLink")}
        </a>
      ) : null}
    </div>
  );
}
