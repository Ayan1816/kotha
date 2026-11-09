"use client";

import { CopyButton, HashRow } from "@/components/aegis/bits";
import { translate, type CopyKey, type Lang } from "@/components/aegis/copy";
import { actionTone, amountSummary, formatTimestamp, getExecutionCommand, shortHash } from "@/components/aegis/format";
import { judgeReceipt, readChainExecution, rehashReceipt } from "@/lib/receipt-canonical";
import { explorerTxUrl, publicNetwork } from "@/lib/wallet-proof";
import { AnimatedNumberTicker, ShimmerActionButton, SpotlightGlassCard } from "@/components/ui/aegis-primitives";
import type { AegisIntent, AttestedInference, DryRunPreview, ExecutionResult, VerifiedExecution } from "@/lib/dashboard-types";
import { assetLabel } from "@/components/aegis/format";
import { PhoneBook } from "@/components/aegis/phone-book";
import { Download } from "lucide-react";
import { useState } from "react";

export type ChainLink = { id: string; hash: string; receiptHash: string };

export function AuditPanel({
  lang,
  frozen,
  intent,
  dryRun,
  attestation,
  execution,
  executeReason,
  executeBusy,
  quoteBusy,
  quoteError,
  executions,
  contractId,
  chainLink,
  remittanceLine,
  onPhoneBookChange,
  onExecute,
  onRefresh,
  onVerifyChain,
}: {
  lang: Lang;
  frozen: boolean;
  intent: AegisIntent | null;
  dryRun: DryRunPreview | null;
  attestation: AttestedInference | null;
  execution: ExecutionResult | null;
  executeReason: string | null;
  executeBusy: boolean;
  quoteBusy: boolean;
  quoteError: string | null;
  executions: VerifiedExecution[];
  contractId: string;
  chainLink: ChainLink | null;
  remittanceLine: string | null;
  onPhoneBookChange?: () => void;
  onExecute: () => void;
  onRefresh: () => void;
  onVerifyChain: (correlationId: string, receiptHash?: string) => Promise<"match" | "mismatch">;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="px-1 text-sm font-semibold leading-snug text-white">{translate(lang, "auditTitle")}</h2>
      <SpotlightGlassCard alert={frozen || dryRun?.allowed === false || Boolean(quoteError)}>
        <div className="space-y-3 p-4">
          <div>
            <h2 className="text-sm font-semibold text-white">{translate(lang, "quoteTitle")}</h2>
            <p className="mt-1 text-[11px] text-white/45">{translate(lang, "dryFlag")}</p>
          </div>
          <PhoneBook lang={lang} onChange={onPhoneBookChange} />
          {remittanceLine && !(intent && dryRun) ? (
            <p className="break-words font-mono text-[11px] leading-relaxed text-[#d9ffe8]">{remittanceLine}</p>
          ) : null}
          {intent && dryRun ? (
            <QuoteBody lang={lang} intent={intent} dryRun={dryRun} remittanceLine={remittanceLine} />
          ) : quoteError ? (
            <p className="text-sm leading-relaxed text-[#ffb3c0]" role="alert">
              {quoteError}
            </p>
          ) : (
            <p className="text-sm text-white/60">{translate(lang, "quoteEmpty")}</p>
          )}
          {execution ? (
            <div className="rounded-xl border border-[#00EC97]/30 bg-[#00EC97]/8 px-3 py-2 text-xs text-[#d9ffe8]">
              <div className="uppercase tracking-[0.14em] text-[#00EC97]">{translate(lang, "executed")}</div>
              <div className="mt-1 break-all font-mono">{execution.correlation_id}</div>
              {chainLink && chainLink.id === execution.correlation_id && chainLink.hash ? (
                <a
                  href={explorerTxUrl(chainLink.hash)}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 block truncate font-mono text-[11px] text-[#7DD3FC] underline-offset-2 hover:underline"
                >
                  {explorerTxUrl(chainLink.hash)}
                </a>
              ) : null}
              {chainLink && chainLink.id === execution.correlation_id ? (
                <div className="mt-2">
                  <ChainVerifyButton lang={lang} onClick={() => onVerifyChain(execution.correlation_id, chainLink.receiptHash)} />
                </div>
              ) : null}
            </div>
          ) : null}
          <ShimmerActionButton variant="ghost" loading={quoteBusy} disabled={!intent} onClick={onRefresh}>
            {translate(lang, "refresh")}
          </ShimmerActionButton>
          <span title={executeReason || translate(lang, "executeHint")} className="block">
            <ShimmerActionButton
              loading={executeBusy}
              disabled={Boolean(executeReason) || !intent || !attestation}
              title={executeReason || translate(lang, "executeHint")}
              onClick={onExecute}
            >
              {translate(lang, "execute")}
            </ShimmerActionButton>
          </span>
          {executeReason ? <p className="text-xs leading-relaxed text-[#ffb3c0]">{executeReason}</p> : <p className="text-[11px] text-white/45">{translate(lang, "executeHint")}</p>}
        </div>
      </SpotlightGlassCard>
      <ProofsTable
        lang={lang}
        executions={executions}
        contractId={contractId}
        highlight={execution?.correlation_id ?? null}
        onVerifyChain={onVerifyChain}
      />
    </div>
  );
}

const CHECK_LABEL = {
  perTx: "perTxLimit",
  daily: "checkDaily",
  recipient: "recipientFormat",
  balance: "balanceCheck",
} as const;

export function dryRunTone(dryRun: DryRunPreview): "pass" | "warn" | "fail" {
  if (dryRun.balance === "skipped" && dryRun.policyAllowed !== false) return "pass";
  if (dryRun.balance === "insufficient" && dryRun.policyAllowed !== false) return "warn";
  return dryRun.allowed ? "pass" : "fail";
}

export function dryRunLabel(lang: Lang, dryRun: DryRunPreview): string {
  if (dryRun.balance === "skipped" && dryRun.policyAllowed !== false) return translate(lang, "passUnchecked");
  if (dryRun.balance === "insufficient" && dryRun.policyAllowed !== false) return translate(lang, "insufficientBadge");
  return dryRun.allowed ? translate(lang, "pass") : translate(lang, "blocked");
}

export function DryRunChecks({ lang, dryRun }: { lang: Lang; dryRun: DryRunPreview }) {
  if (!dryRun.checks?.length) return null;
  return (
    <ul className="mt-3 space-y-1 text-xs">
      {dryRun.checks.map((check) => (
        <li key={check.code} className="flex items-center justify-between gap-3">
          <span className="text-white/70">{translate(lang, CHECK_LABEL[check.code])}</span>
          <span className={check.result === "FAIL" ? "text-[#ffb3c0]" : check.result === "SKIPPED" ? "text-[#ffd7a1]" : "text-[#00EC97]"}>
            {check.result === "SKIPPED" ? translate(lang, "balanceSkipped") : check.result === "FAIL" ? translate(lang, "checkFail") : translate(lang, "pass")}
          </span>
        </li>
      ))}
    </ul>
  );
}

function warningLabel(lang: Lang, warning: string): string {
  if (warning === "INSUFFICIENT_BALANCE") return translate(lang, "insufficientBadge");
  if (warning === "BALANCE_SKIPPED") return translate(lang, "balanceSkipped");
  return warning;
}

export function QuoteBody({ lang, intent, dryRun, remittanceLine }: { lang: Lang; intent: AegisIntent; dryRun: DryRunPreview; remittanceLine: string | null }) {
  const origin = assetLabel(intent.origin_asset);
  const destination = assetLabel(intent.destination_asset);
  const impact = dryRun.budgetImpact;
  const width = Math.max(0, Math.min(100, impact.utilizationPct));
  const tone = dryRunTone(dryRun);
  const bar = tone === "fail" ? "bg-[#FF3B5C]" : tone === "warn" || width >= 80 ? "bg-[#FF8A00]" : "bg-[#00EC97]";
  const badge =
    tone === "fail" ? "border-[#FF3B5C]/50 text-[#ffb3c0]" : tone === "warn" ? "border-[#FF8A00]/50 text-[#ffd7a1]" : "border-[#00EC97]/40 text-[#00EC97]";
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase ${actionTone(intent.action)}`}>{intent.action}</span>
        <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase ${badge}`}>
          {dryRunLabel(lang, dryRun)}
        </span>
      </div>
      <DryRunChecks lang={lang} dryRun={dryRun} />
      <dl className="grid grid-cols-1 gap-2 text-xs min-[376px]:grid-cols-2">
        <Info label={translate(lang, "amount")} value={`${intent.amount} ${origin.symbol}`} />
        <Info label={translate(lang, "expected")} value={`${dryRun.quote.expectedAmountOut} ${destination.symbol}`} />
        <Info label={translate(lang, "fee")} value="" ticker={dryRun.quote.feeUsd} />
        <Info label={translate(lang, "targetShard")} value={testnetLabel(dryRun.quote.shard)} />
        <Info label={translate(lang, "rate")} value={dryRun.quote.rate} />
        <Info label={translate(lang, "slippage")} value={`${dryRun.quote.slippageBps} bps`} />
        <Info label={translate(lang, "recipient")} value={intent.recipient || "—"} wide />
      </dl>
      {remittanceLine ? <p className="break-words font-mono text-[11px] leading-relaxed text-[#d9ffe8]">{remittanceLine}</p> : null}
      <p className="break-words font-mono text-[11px] text-white/55">{testnetLabel(dryRun.quote.route)}</p>
      <div>
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-white/45">
          <span>{translate(lang, "budgetImpact")}</span>
          <AnimatedNumberTicker value={impact.utilizationPct} format="percent" maximumFractionDigits={1} />
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-white/10">
          <div className={`h-full ${bar}`} style={{ width: `${width}%` }} />
        </div>
        <p className="mt-1 font-mono text-[11px] text-white/55">
          <AnimatedNumberTicker value={impact.currentSpentUsd} format="usd" /> + <AnimatedNumberTicker value={impact.txUsd} format="usd" /> →{" "}
          <AnimatedNumberTicker value={impact.projectedSpentUsd} format="usd" /> / <AnimatedNumberTicker value={impact.dailyLimitUsd} format="usd" />
        </p>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-[0.14em] text-white/45">{translate(lang, "warnings")}</div>
        {dryRun.warnings.length === 0 ? (
          <p className="mt-1 text-xs text-white/55">{translate(lang, "noWarnings")}</p>
        ) : (
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-[#ffd7a1]">
            {dryRun.warnings.map((warning) => (
              <li key={warning}>{warningLabel(lang, warning)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function testnetLabel(value: string): string {
  if (process.env.NEXT_PUBLIC_NETWORK === "mainnet") return value;
  return value.replace(/\b(?:outlayer\.near|intents\.near|intents\.far)\b/g, "demo (testnet)");
}

function Info({ label, value, ticker, wide }: { label: string; value: string; ticker?: number; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2" : ""}>
      <div className="text-[10px] uppercase tracking-[0.14em] text-white/40">{label}</div>
      {ticker != null ? (
        <AnimatedNumberTicker value={ticker} format="usd" className="text-sm text-white" />
      ) : (
        <div className="break-all font-mono text-sm text-white">{value}</div>
      )}
    </div>
  );
}

export function ProofsTable({
  lang,
  executions,
  contractId,
  highlight,
  onVerifyChain,
  network = publicNetwork(),
}: {
  lang: Lang;
  executions: VerifiedExecution[];
  contractId: string;
  highlight: string | null;
  onVerifyChain: (correlationId: string, receiptHash?: string) => Promise<"match" | "mismatch">;
  network?: "mainnet" | "testnet";
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/10 bg-[#07110d] shadow-[0_16px_40px_rgba(0,0,0,0.35)]">
      <table className="w-full min-w-[720px] border-collapse text-left">
        <thead>
          <tr className="border-b border-white/10 text-sm text-white/60">
            <th className="px-4 py-3 font-medium">{translate(lang, "time")}</th>
            <th className="px-4 py-3 font-medium">{translate(lang, "action")}</th>
            <th className="px-4 py-3 font-medium">{translate(lang, "amount")}</th>
            <th className="px-4 py-3 font-medium">{translate(lang, "status")}</th>
            <th className="px-4 py-3 font-medium">{translate(lang, "txLink")}</th>
            <th className="px-4 py-3 font-medium">{translate(lang, "verify")}</th>
          </tr>
        </thead>
        <tbody>
          {executions.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-6 text-base text-white/60">
                {translate(lang, "empty")}
              </td>
            </tr>
          ) : (
            executions.map((row) => (
              <ProofRow
                key={row.correlation_id}
                lang={lang}
                row={row}
                contractId={contractId}
                highlight={highlight === row.correlation_id}
                network={network}
                onVerifyChain={onVerifyChain}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function ProofRow({
  lang,
  row,
  contractId,
  highlight,
  onVerifyChain,
  network,
}: {
  lang: Lang;
  row: VerifiedExecution;
  contractId: string;
  highlight: boolean;
  onVerifyChain: (correlationId: string, receiptHash?: string) => Promise<"match" | "mismatch">;
  network: "mainnet" | "testnet";
}) {
  const [chain, setChain] = useState<"idle" | "checking" | "match" | "mismatch">("idle");
  const [verifyDetail, setVerifyDetail] = useState("");
  const command = getExecutionCommand(contractId, row.correlation_id);
  const txUrl = row.tx_hash ? explorerTxUrl(row.tx_hash, network) : "";
  return (
    <>
      <tr id={`exec-${row.correlation_id}`} className={`scroll-mt-24 border-b border-white/8 ${highlight ? "bg-[#00EC97]/10" : ""}`}>
        <td className="whitespace-nowrap px-4 py-3 text-sm text-white">{formatTimestamp(row.timestamp_ns, lang)}</td>
        <td className="whitespace-nowrap px-4 py-3 text-sm text-white">{row.action_type}</td>
        <td className="max-w-48 px-4 py-3 text-sm break-words text-white">{amountSummary(row)}</td>
        <td className="whitespace-nowrap px-4 py-3 text-sm text-[#00EC97]">{translate(lang, "statusRecorded")}</td>
        <td className="px-4 py-3 text-sm">
          {txUrl ? (
            <a href={txUrl} target="_blank" rel="noreferrer" className="text-[#7DD3FC] underline-offset-2 hover:underline">
              {shortHash(row.tx_hash || "", 6, 4)}
            </a>
          ) : (
            <span className="text-white/40">—</span>
          )}
        </td>
        <td className="px-4 py-3 text-sm">
          <button
            type="button"
            onClick={() => {
              setChain("checking");
              void onVerifyChain(row.correlation_id, row.receipt_hash)
                .then(setChain)
                .catch(() => setChain("mismatch"));
            }}
            className="rounded-xl border border-white/15 px-3 py-1 text-sm text-white hover:border-[#00EC97]/50"
          >
            {translate(lang, "verify")}
            {chain === "checking" ? " …" : ""}
          </button>
          {chain === "match" ? <div className="mt-1 text-sm text-[#00EC97]">{translate(lang, "chainMatch")}</div> : null}
          {chain === "mismatch" ? <div className="mt-1 text-sm text-[#ffb3c0]">{translate(lang, "chainMismatch")}</div> : null}
        </td>
      </tr>
      <tr className="border-b border-white/8">
        <td colSpan={6} className="px-4 py-2">
          <details>
            <summary className="cursor-pointer text-sm text-[#b8ffe0]">{translate(lang, "showDetails")}</summary>
            <div className="mt-2 space-y-2">
              <MetaRow label={translate(lang, "correlation")} value={row.correlation_id} />
              <MetaRow label={translate(lang, "chatLabel")} value={row.near_ai_chat_id} />
              <MetaRow label={translate(lang, "address")} value={row.tee_signing_address} />
              <HashRow lang={lang} label={translate(lang, "requestHash")} value={row.request_sha256} />
              <HashRow lang={lang} label={translate(lang, "responseHash")} value={row.response_sha256} />
              {row.receipt_hash ? <HashRow lang={lang} label={translate(lang, "receiptHash")} value={row.receipt_hash} /> : null}
              <HashRow lang={lang} label={translate(lang, "signature")} value={row.tee_signature} />
              <CopyButton value={command} lang={lang} label={translate(lang, "cli")} />
              <button
                type="button"
                onClick={() => void downloadStoredReceipt(row.correlation_id)}
                className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-3 py-2 text-sm text-white"
              >
                <Download className="h-4 w-4" />
                {translate(lang, "receipt")}
              </button>
              <button
                type="button"
                onClick={() => void verifyStoredReceipt(lang, row.correlation_id, () => undefined, setVerifyDetail)}
                className="ml-2 inline-flex items-center rounded-xl border border-white/15 px-3 py-2 text-sm text-white"
              >
                {translate(lang, "verify")}
              </button>
              {verifyDetail ? <p className="break-words text-sm text-white/80">{verifyDetail}</p> : null}
            </div>
          </details>
        </td>
      </tr>
    </>
  );
}

function ChainVerifyButton({ lang, onClick }: { lang: Lang; onClick: () => Promise<"match" | "mismatch"> }) {
  const [state, setState] = useState<"idle" | "checking" | "match" | "mismatch">("idle");
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => {
          setState("checking");
          void onClick()
            .then(setState)
            .catch(() => setState("mismatch"));
        }}
        className="inline-flex items-center justify-center gap-2 whitespace-normal break-words rounded-md border border-white/10 px-2 py-2 text-center text-[10px] leading-snug text-white/75 hover:border-[#00EC97]/40"
      >
        {translate(lang, "verifyOnChain")}
        {state === "checking" ? " · …" : ""}
      </button>
      {state === "match" ? (
        <span className="inline-flex w-fit rounded-full bg-[#00EC97]/15 px-2 py-0.5 text-[10px] font-semibold text-[#00EC97]">
          {translate(lang, "chainMatch")}
        </span>
      ) : null}
      {state === "mismatch" ? (
        <span className="inline-flex w-fit rounded-full bg-[#FF3B5C]/15 px-2 py-0.5 text-[10px] font-semibold text-[#ffb3c0]">
          {translate(lang, "chainMismatch")}
        </span>
      ) : null}
    </div>
  );
}

async function downloadStoredReceipt(id: string): Promise<void> {
  const bytes = await fetchReceiptBytes(id);
  if (!bytes) return;
  const blob = new Blob([Uint8Array.from(bytes)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `kotha-receipt-${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
      <dt className="w-full text-[10px] uppercase tracking-[0.12em] text-white/45 min-[376px]:w-28 min-[376px]:shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1 break-all font-mono text-[#d9ffe8] min-[376px]:truncate" title={value}>
        {value}
      </dd>
    </div>
  );
}

const RECEIPT_REASON: Record<string, CopyKey> = {
  "Downloaded receipt hash does not match its canonical JSON.": "receiptHashMismatch",
  "get_execution returned no record.": "chainMissing",
  "receipt_hash does not match get_execution.": "chainReceiptMismatch",
  "intent hash does not match get_execution.": "chainIntentMismatch",
  "chat_id does not match get_execution.": "chainChatMismatch",
  "action does not match get_execution.": "chainActionMismatch",
  "amount_usd does not match get_execution.": "chainAmountMismatch",
  "timestamp does not match get_execution.": "chainTimeMismatch",
  "receipt_hash matches get_execution.": "chainReceiptMatch",
};

function localizedReason(lang: Lang, reason: string): string {
  const key = RECEIPT_REASON[reason];
  return key ? translate(lang, key) : reason;
}

async function verifyStoredReceipt(
  lang: Lang,
  id: string,
  setState: (state: "idle" | "checking" | "match" | "mismatch") => void,
  setDetail: (detail: string) => void,
): Promise<void> {
  setState("checking");
  setDetail("");
  try {
    const bytes = await fetchReceiptBytes(id);
    if (!bytes) {
      setState("mismatch");
      setDetail(translate(lang, "receiptMissing"));
      return;
    }
    const hashed = await rehashReceipt(new TextDecoder().decode(bytes));
    if (!hashed) {
      setState("mismatch");
      setDetail(translate(lang, "receiptBadJson"));
      return;
    }
    const chainResponse = await fetch(`/api/vault/execution?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    const chainBody = (await chainResponse.json().catch(() => null)) as { raw?: string | null } | null;
    const verdict = judgeReceipt(hashed.receipt, hashed.embedded, hashed.recomputed, readChainExecution(chainBody?.raw || ""));
    setState(verdict.match ? "match" : "mismatch");
    setDetail(localizedReason(lang, verdict.reason));
  } catch (error) {
    setState("mismatch");
    setDetail(error instanceof Error ? error.message : translate(lang, "verifyFailed"));
  }
}

async function fetchReceiptBytes(id: string): Promise<Uint8Array | null> {
  const response = await fetch(`/api/receipts/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (!response.ok) return null;
  return new Uint8Array(await response.arrayBuffer());
}
