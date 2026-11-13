"use client";

import { DryRunSummary, QuoteBody, dryRunIsBlocked, dryRunLabel, dryRunTone, formatWarning } from "@/components/aegis/audit-panel";
import { translate, type Lang } from "@/components/aegis/copy";
import { ExecuteBanner } from "@/components/aegis/execute-banner";
import { actionCopyKey, isNativeNearTransfer, previewSymbol } from "@/components/aegis/format";
import type { AegisIntent, ActivePolicy, DryRunPreview } from "@/lib/dashboard-types";
import type { CardOutcome } from "@/lib/native-transfer";
import { nativeExecuteBlock } from "@/lib/native-transfer";
import { useId } from "react";

export function SpendingGuard({
  lang,
  policy,
  frozen,
  ownerLock,
  ownerReady,
  executeHint = null,
  vaultOwner = "",
  vaultAgent = "",
  quoteBusy,
  executeBusy,
  freezeBusy,
  intent,
  dryRun,
  remittanceLine,
  quoteError,
  executeReason,
  cardOutcome = null,
  onDryRun,
  onExecute,
  onFreeze,
}: {
  lang: Lang;
  policy: ActivePolicy;
  frozen: boolean;
  ownerLock: string | null;
  ownerReady: boolean;
  executeHint?: string | null;
  vaultOwner?: string;
  vaultAgent?: string;
  quoteBusy: boolean;
  executeBusy: boolean;
  freezeBusy: boolean;
  intent: AegisIntent | null;
  dryRun: DryRunPreview | null;
  remittanceLine: string | null;
  quoteError: string | null;
  executeReason: string | null;
  cardOutcome?: CardOutcome | null;
  onDryRun: () => void;
  onExecute: () => void;
  onFreeze: () => void;
}) {
  const limit = policy.dailyBudgetUsd > 0 ? policy.dailyBudgetUsd : 1;
  const used = Math.max(0, Math.min(100, (policy.spentTodayUsd / limit) * 100));
  const dryTitle = intent ? undefined : translate(lang, "noIntentReason");
  const policyBlocked = dryRunIsBlocked(dryRun);
  const nativeBlock = intent ? nativeExecuteBlock(intent) : null;
  const nativeReason = nativeBlock ? translate(lang, nativeBlock) : null;
  const canExecute = ownerReady && !nativeBlock && !policyBlocked && !executeReason && !executeHint && Boolean(intent);
  const executeTip = canExecute
    ? undefined
    : executeHint
      ? executeHint
      : nativeReason
        ? nativeReason
        : !ownerReady
          ? translate(lang, "connectOwner")
          : executeReason || translate(lang, "blockedByPolicy");
  const freezeTitle = ownerLock || undefined;
  const blockedLine = dryRun?.warnings[0] ? formatWarning(lang, dryRun.warnings[0]) : translate(lang, "blockedByPolicy");

  return (
    <section id="guard-card" className="rounded-2xl border border-white/10 bg-[#07110d] p-6 shadow-[0_16px_40px_rgba(0,0,0,0.35)]">
      <h2 className="text-xl font-semibold text-white">{translate(lang, "tabGuard")}</h2>
      {vaultOwner || vaultAgent ? (
        <p className="mt-2 break-words text-sm text-white/70">
          {vaultOwner ? `${translate(lang, "vaultOwner")}: ${vaultOwner}` : ""}
          {vaultOwner && vaultAgent ? " · " : ""}
          {vaultAgent ? `${translate(lang, "vaultAgent")}: ${vaultAgent}` : ""}
        </p>
      ) : null}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Stat label={translate(lang, "dailyLimit")} value={usd(policy.dailyBudgetUsd)} />
        <Stat label={translate(lang, "perTxLimit")} value={usd(policy.perTxCapUsd)} />
        <Stat label={translate(lang, "usedToday")} value={usd(policy.spentTodayUsd)} />
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
        <div className={`h-full ${frozen ? "bg-[#FF3B5C]" : used >= 80 ? "bg-[#FF8A00]" : "bg-[#00EC97]"}`} style={{ width: `${used}%` }} />
      </div>
      <p className="mt-2 text-sm text-white/60">{used.toFixed(0)}%</p>
      {remittanceLine ? <p className="mt-4 break-words text-sm leading-6 text-[#d9ffe8]">{remittanceLine}</p> : null}
      {quoteError ? (
        <p className="mt-4 text-sm text-[#ffb3c0]" role="alert">
          {quoteError}
        </p>
      ) : null}
      {intent ? <IntentLine lang={lang} intent={intent} /> : null}
      {intent && dryRun ? <DryRunCard key={`${intent.action}:${intent.amount}:${intent.recipient}:${intent.destination_asset}`} lang={lang} dryRun={dryRun} /> : null}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        {policyBlocked ? (
          <p className="text-sm text-[#ffb3c0]">{blockedLine}</p>
        ) : (
          <>
            <GuardButton label={translate(lang, "dryRun")} title={dryTitle} busy={quoteBusy} disabled={Boolean(dryTitle)} onClick={onDryRun} tone="ghost" />
            <GuardButton label={translate(lang, "executeButton")} title={executeTip} busy={executeBusy} disabled={!canExecute} onClick={onExecute} tone="primary" />
          </>
        )}
        <GuardButton
          label={frozen ? translate(lang, "unfreeze") : translate(lang, "freezeButton")}
          title={freezeTitle}
          busy={freezeBusy}
          disabled={Boolean(freezeTitle)}
          onClick={onFreeze}
          tone="danger"
        />
      </div>
      {executeTip && !policyBlocked ? <p className="mt-3 text-sm text-[#ffd7a1]">{executeTip}</p> : null}
      <ExecuteBanner lang={lang} outcome={cardOutcome} />
      <details className="mt-6 rounded-2xl border border-white/10 p-4">
        <summary className="cursor-pointer text-sm text-[#b8ffe0]">{translate(lang, "showDetails")}</summary>
        <div className="mt-4">
          {intent && dryRun ? (
            <QuoteBody lang={lang} intent={intent} dryRun={dryRun} remittanceLine={remittanceLine} />
          ) : (
            <p className="text-sm text-white/60">{translate(lang, "quoteEmpty")}</p>
          )}
        </div>
      </details>
    </section>
  );
}

function IntentLine({ lang, intent }: { lang: Lang; intent: AegisIntent }) {
  const origin = previewSymbol(intent.origin_asset, intent.action);
  const destination = previewSymbol(intent.destination_asset, intent.action);
  const target = intent.action === "swap" ? destination : intent.recipient;
  return (
    <p className="mt-4 break-words text-sm text-white">
      <span className="mr-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#b8ffe0]">{translate(lang, actionCopyKey(intent.action))}</span>
      {isNativeNearTransfer(intent) ? `${translate(lang, "nativeNear")} · ` : null}
      {intent.amount} {origin}
      {target ? ` → ${target}` : ""}
    </p>
  );
}

function DryRunCard({ lang, dryRun }: { lang: Lang; dryRun: DryRunPreview }) {
  const tone = dryRunTone(dryRun);
  const shell =
    tone === "fail" ? "border-[#FF3B5C]/50 bg-[#FF3B5C]/10" : tone === "warn" ? "border-[#FF8A00]/40 bg-[#FF8A00]/10" : "border-[#00EC97]/40 bg-[#00EC97]/10";
  const title = tone === "fail" ? "text-[#ffb3c0]" : tone === "warn" ? "text-[#ffd7a1]" : "text-[#00EC97]";
  const warning = dryRun.warnings.find((item) => item !== "INSUFFICIENT_BALANCE" && item !== "BALANCE_SKIPPED");
  return (
    <div className={`mt-4 rounded-2xl border p-4 ${shell}`}>
      <p className={`text-sm font-semibold uppercase ${title}`}>{dryRunLabel(lang, dryRun)}</p>
      <DryRunSummary lang={lang} dryRun={dryRun} />
      {warning ? <p className="mt-2 text-sm text-[#ffd7a1]">{formatWarning(lang, warning)}</p> : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-sm text-white/60">{label}</div>
      <div className="mt-1 truncate text-[28px] leading-9 text-white">{value}</div>
    </div>
  );
}

function usd(value: number): string {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function GuardButton({
  label,
  title,
  disabled,
  busy,
  onClick,
  tone,
}: {
  label: string;
  title?: string;
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
  tone: "primary" | "ghost" | "danger";
}) {
  const reasonId = useId();
  const toneClass =
    tone === "primary"
      ? "bg-[#00EC97] text-[#04140d] disabled:bg-[#2a3038] disabled:text-white/45 disabled:opacity-100"
      : tone === "danger"
        ? "border border-[#FF3B5C]/60 text-[#ffb3c0]"
        : "border border-white/15 text-white";
  const disabledClass = tone === "primary" ? "disabled:cursor-not-allowed" : "disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <span title={title} className="inline-flex">
      {title ? (
        <span id={reasonId} className="sr-only">
          {title}
        </span>
      ) : null}
      <button
        type="button"
        disabled={disabled || busy}
        title={title}
        aria-describedby={title ? reasonId : undefined}
        onClick={onClick}
        className={`h-10 rounded-xl px-4 text-sm font-semibold ${disabledClass} ${toneClass}`}
      >
        {busy ? "…" : label}
      </button>
    </span>
  );
}
