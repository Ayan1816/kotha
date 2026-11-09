"use client";

import { CopyButton, FieldLabel } from "@/components/aegis/bits";
import { translate, type Lang } from "@/components/aegis/copy";
import { formatIso, shortHash } from "@/components/aegis/format";
import { EnclaveSwitch, ShimmerActionButton, SpotlightGlassCard } from "@/components/ui/aegis-primitives";
import type { ActivePolicy, PolicyPatch, PublicGrant } from "@/lib/dashboard-types";
import { INTENT_ACTIONS } from "@/lib/dashboard-types";
import { useEffect, useState } from "react";

const ACTION_KEY = {
  swap: "actionSwap",
  transfer: "actionTransfer",
  withdraw: "actionWithdraw",
  shield: "actionShield",
  unshield: "actionUnshield",
} as const;

export function PolicyPanel({
  lang,
  policy,
  grant,
  frozen,
  revealedToken,
  policyBusy,
  rotateBusy,
  revokeBusy,
  ownerLock = null,
  grantNotice = null,
  onSave,
  onRotate,
  onRevoke,
}: {
  lang: Lang;
  policy: ActivePolicy;
  grant: PublicGrant;
  frozen: boolean;
  revealedToken: string | null;
  policyBusy: boolean;
  rotateBusy: boolean;
  revokeBusy: boolean;
  ownerLock?: string | null;
  grantNotice?: string | null;
  onSave: (patch: PolicyPatch) => Promise<void>;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  const [draft, setDraft] = useState(policy);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setDraft(policy);
  }, [policy, dirty]);

  const grantState = grant.revoked ? "revoked" : grant.active ? "active" : "expired";
  const grantText = grantNotice || ownerLock || translate(lang, grantState);
  const grantLive = !grantNotice && !ownerLock && grantState === "active";

  return (
    <div className="flex flex-col gap-3">
      <SpotlightGlassCard alert={frozen}>
        <div className="space-y-4 p-4">
          <div>
            <h2 className="text-xl font-semibold leading-snug text-white">{translate(lang, "policyTitle")}</h2>
            <p className="mt-1 text-xs text-white/55" title={translate(lang, "policyHint")}>
              {translate(lang, "policyHint")}
            </p>
            {ownerLock ? <p className="mt-2 text-[11px] leading-snug text-amber-200/90">{translate(lang, "readOnly")}</p> : null}
          </div>

          <label className="block space-y-2">
            <span className="flex items-center justify-between text-xs text-white/70">
              <FieldLabel k="dailyBudget" lang={lang} />
              <span className="font-mono text-[#d9ffe8]">${draft.dailyBudgetUsd.toFixed(0)}</span>
            </span>
            <input
              className="aegis-range w-full"
              type="range"
              min={10}
              max={1000}
              step={1}
              value={draft.dailyBudgetUsd}
              disabled={Boolean(ownerLock)}
              title={ownerLock || undefined}
              aria-label={translate(lang, "dailyBudget")}
              onChange={(event) => {
                setDirty(true);
                setDraft((current) => ({ ...current, dailyBudgetUsd: Number(event.target.value) }));
              }}
            />
          </label>

          <label className="block space-y-2">
            <span className="flex items-center justify-between text-xs text-white/70">
              <FieldLabel k="perTx" lang={lang} />
              <span className="font-mono text-[#d9ffe8]">${draft.perTxCapUsd.toFixed(0)}</span>
            </span>
            <input
              className="aegis-range w-full"
              type="range"
              min={1}
              max={1000}
              step={1}
              value={draft.perTxCapUsd}
              disabled={Boolean(ownerLock)}
              title={ownerLock || undefined}
              aria-label={translate(lang, "perTx")}
              onChange={(event) => {
                setDirty(true);
                setDraft((current) => ({ ...current, perTxCapUsd: Number(event.target.value) }));
              }}
            />
          </label>

          <div className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-black/20 px-3 py-2">
            <div>
              <div className="text-sm text-white">{translate(lang, "shardTitle")}</div>
              <p className="text-[11px] text-white/45" title={translate(lang, "shardHint")}>
                {draft.confidentialShardEnabled ? translate(lang, "confidentialOn") : translate(lang, "confidentialOff")}
              </p>
            </div>
            <EnclaveSwitch
              checked={draft.confidentialShardEnabled}
              disabled={Boolean(ownerLock)}
              label={translate(lang, "shardTitle")}
              hint={ownerLock || translate(lang, "shardHint")}
              onChange={(next) => {
                setDirty(true);
                setDraft((current) => ({ ...current, confidentialShardEnabled: next }));
              }}
            />
          </div>

          <fieldset disabled={Boolean(ownerLock)} className={ownerLock ? "opacity-60" : undefined}>
            <legend className="mb-2 text-[10px] uppercase tracking-[0.16em] text-white/45" title={translate(lang, "allowedHint")}>
              {translate(lang, "allowed")}
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {INTENT_ACTIONS.map((action) => {
                const on = draft.allowedActions.includes(action);
                return (
                  <label key={action} className="flex items-center gap-2 rounded-lg border border-white/8 px-2 py-1.5 text-xs text-white/80">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => {
                        setDirty(true);
                        setDraft((current) => ({
                          ...current,
                          allowedActions: on
                            ? current.allowedActions.filter((item) => item !== action)
                            : [...current.allowedActions, action],
                        }));
                      }}
                      disabled={Boolean(ownerLock)}
                      className="accent-[#00EC97]"
                    />
                    <span>{translate(lang, ACTION_KEY[action])}</span>
                    <span className="font-mono text-[10px] text-white/35">{action}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <span title={ownerLock || undefined} className="block">
          <ShimmerActionButton
            loading={policyBusy}
            disabled={Boolean(ownerLock)}
            title={ownerLock || undefined}
            onClick={() => {
              void onSave({
                dailyBudgetUsd: draft.dailyBudgetUsd,
                perTxCapUsd: draft.perTxCapUsd,
                allowedActions: draft.allowedActions,
                confidentialShardEnabled: draft.confidentialShardEnabled,
              })
                .then(() => setDirty(false))
                .catch(() => undefined);
            }}
          >
            {translate(lang, "savePolicy")}
          </ShimmerActionButton>
          </span>
        </div>
      </SpotlightGlassCard>

      <SpotlightGlassCard alert={frozen || grant.revoked}>
        <div className="space-y-3 p-4">
          <div>
            <h2 className="text-xl font-semibold text-white">{translate(lang, "grantTitle")}</h2>
            <p className="mt-1 text-xs text-white/50" title={translate(lang, "grantHint")}>
              {grant.label}
            </p>
          </div>
          <div className="flex items-center justify-between gap-2">
            <code className="truncate font-mono text-sm text-[#00EC97]" title={grant.tokenPreview}>
              {grant.tokenPreview}
            </code>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                grantLive ? "bg-[#00EC97]/15 text-[#00EC97]" : grantNotice || ownerLock ? "bg-[#FFB020]/15 text-[#FFB020]" : "bg-[#FF3B5C]/15 text-[#FF8A9A]"
              }`}
            >
              {grantText}
            </span>
          </div>
          <div className="space-y-1 text-[11px] text-white/55">
            <div className="flex items-center justify-between gap-2">
              <span>{translate(lang, "commitment")}</span>
              <span className="flex items-center gap-2 font-mono text-[#d9ffe8]">
                {shortHash(grant.commitmentHash, 8, 6)}
                <CopyButton value={grant.commitmentHash} lang={lang} />
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span>{translate(lang, "issued")}</span>
              <span className="font-mono">{formatIso(grant.issuedAt, lang)}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span>{translate(lang, "expires")}</span>
              <span className="font-mono">{formatIso(grant.expiresAt, lang)}</span>
            </div>
          </div>
          {revealedToken ? (
            <div className="rounded-xl border border-[#00EC97]/30 bg-[#00EC97]/8 p-3">
              <div className="text-[10px] uppercase tracking-[0.16em] text-[#00EC97]">{translate(lang, "revealTitle")}</div>
              <p className="mt-1 text-[11px] text-white/60">{translate(lang, "revealHint")}</p>
              <code className="mt-2 block break-all font-mono text-[11px] text-white">{revealedToken}</code>
              <div className="mt-2">
                <CopyButton value={revealedToken} lang={lang} />
              </div>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <span title={ownerLock || undefined} className="block min-w-0">
              <ShimmerActionButton loading={rotateBusy} disabled={Boolean(ownerLock)} title={ownerLock || undefined} onClick={onRotate}>
                {translate(lang, "rotate")}
              </ShimmerActionButton>
            </span>
            <span title={ownerLock || undefined} className="block min-w-0">
              <ShimmerActionButton variant="ghost" loading={revokeBusy} disabled={Boolean(ownerLock)} title={ownerLock || undefined} onClick={onRevoke}>
                {translate(lang, "revoke")}
              </ShimmerActionButton>
            </span>
          </div>
        </div>
      </SpotlightGlassCard>
    </div>
  );
}
