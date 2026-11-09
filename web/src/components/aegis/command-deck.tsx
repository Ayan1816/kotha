"use client";

import { useKothaSession } from "@/app/providers";
import { ApiKeyCard } from "@/components/aegis/api-key-card";
import { DeckRequestError, fetchDashboard, fetchTeeCatalog, postDryRun, postExecute, postFreeze, postGrant, postPolicy, postSaveTx, postTeeChatStream } from "@/components/aegis/api";
import type { ChainLink } from "@/components/aegis/audit-panel";
import { CopilotPanel, type ChatMessage } from "@/components/aegis/copilot-panel";
import { translate, type Lang } from "@/components/aegis/copy";
import { PhoneBook } from "@/components/aegis/phone-book";
import { PolicyPanel } from "@/components/aegis/policy-panel";
import { SpendingGuard } from "@/components/aegis/spending-guard";
import { TelemetryBar, type TeePhase } from "@/components/aegis/telemetry-bar";
import { ShimmerActionButton } from "@/components/ui/aegis-primitives";
import { invalidAmountReason } from "@/lib/budget-math";
import { displayReply, type LoaderStep } from "@/lib/chat-stream";
import { resolveRemittance } from "@/lib/phone-resolver";
import {
  chainMatches,
  configuredOwnerId,
  createWalletProof,
  executionViewCall,
  parseFrozenReceiptJson,
  proofUsesSessionOwner,
  publicContractId,
  strictOwnerMode,
  txHashFromOutcome,
  walletRecordCall,
} from "@/lib/wallet-proof";
import { useNearWallet } from "near-connect-hooks";
import dynamic from "next/dynamic";
import type {
  AegisIntent,
  AttestedInference,
  ChatModelId,
  DashboardResponse,
  DryRunPreview,
  EnclaveTelemetry,
  ExecutionResult,
  PolicyPatch,
  PublicGrant,
} from "@/lib/dashboard-types";
import { useCallback, useEffect, useState } from "react";

const ProofsTable = dynamic(() => import("@/components/aegis/audit-panel").then((mod) => mod.ProofsTable), { ssr: false });

type TabId = "chat" | "guard" | "proofs" | "settings";

type ArmedQuote = {
  intent: AegisIntent;
  dryRun: DryRunPreview;
  attestation: AttestedInference;
  execution: ExecutionResult | null;
};

export function CommandDeck() {
  const [lang, setLang] = useState<Lang>("en");
  const [tab, setTab] = useState<TabId>("chat");
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [enclave, setEnclave] = useState<EnclaveTelemetry | null>(null);
  const [model, setModel] = useState<ChatModelId>("deepseek/deepseek-v3.2");
  const [autoRedact, setAutoRedact] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [quote, setQuote] = useState<ArmedQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [chatStep, setChatStep] = useState<LoaderStep | null>(null);
  const [liveText, setLiveText] = useState("");
  const [latestChain, setLatestChain] = useState<ChainLink | null>(null);
  const [teePhase, setTeePhase] = useState<TeePhase>("idle");
  const [remittanceLine, setRemittanceLine] = useState<string | null>(null);
  const [lastPrompt, setLastPrompt] = useState("");
  const near = useNearWallet();
  const session = useKothaSession();

  const frozen = dashboard?.agentState.frozen ?? dashboard?.agentState.policy.frozen ?? false;
  const accountId = (near.signedAccountId || "").trim();
  const ownerConfigured = strictOwnerMode() && configuredOwnerId().length > 0;
  const ownerLock = ownerConfigured && accountId !== configuredOwnerId() ? translate(lang, "connectOwner") : null;
  const grantNotice = accountId ? null : translate(lang, "connectOwner");
  const thinking = busy === "chat";

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    document.documentElement.dataset.intensity = "obsidian";
    document.documentElement.dataset.frozen = frozen ? "true" : "false";
  }, [lang, frozen]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("kotha-lang");
      if (stored === "en" || stored === "bn" || stored === "es" || stored === "ar" || stored === "hi" || stored === "fr" || stored === "zh") {
        setLang(stored);
      }
    } catch {
      // First paint stays English when storage is blocked.
    }
  }, []);

  const refresh = useCallback(async () => {
    const next = await fetchDashboard();
    setDashboard(next);
    return next;
  }, []);

  const openDeck = useCallback(async () => {
    const [dash, tee] = await Promise.all([fetchDashboard(), fetchTeeCatalog()]);
    setDashboard(dash);
    setEnclave(tee.enclave);
    setModel((current) => (tee.models.some((item) => item === current) ? current : "deepseek/deepseek-v3.2"));
    setLoadError(null);
    return dash;
  }, []);

  useEffect(() => {
    let live = true;
    void openDeck()
      .catch((error: unknown) => {
        if (!live) return;
        setLoadError(error instanceof Error ? error.message : translate("en", "loadFail"));
      });
    return () => {
      live = false;
    };
  }, [openDeck]);

  async function run<T>(key: string, task: () => Promise<T>): Promise<T> {
    setBusy(key);
    try {
      return await task();
    } finally {
      setBusy((current) => (current === key ? null : current));
    }
  }

  function publishPreview(intent: AegisIntent, preview: DryRunPreview) {
    const invalid = invalidAmountReason(intent, preview.warnings);
    if (invalid) {
      setQuote(null);
      setQuoteError(translate(lang, "invalidAmount"));
      return;
    }
    setQuoteError(null);
    setQuote((current) => (current && sameIntent(current.intent, intent) ? { ...current, dryRun: preview, execution: null } : current));
  }

  async function refreshRemittance(text: string) {
    setLastPrompt(text);
    const resolution = await resolveRemittance(text);
    setRemittanceLine(resolution?.line ?? null);
  }

  async function send(text: string) {
    const id = crypto.randomUUID();
    setQuote(null);
    setQuoteError(null);
    setChatStep("redacting");
    void refreshRemittance(text);
    setLiveText("");
    setMessages((current) => [...current, { id, role: "user", text }]);
    try {
      const result = await run("chat", async () => {
        return postTeeChatStream(
          { message: text, model, autoRedact, locale: lang },
          {
            onStep: (step) => setChatStep(step),
            onDelta: (next) => setLiveText(next),
          },
        );
      });
      const intent = result.attestation.decision.intent;
      const preview = result.dryRun;
      const invalid = intent && preview ? invalidAmountReason(intent, preview.warnings) : null;
      setTeePhase(result.attestation.verification.status === "verified" ? "verified" : "unverified");
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: displayReply(result.attestation.decision.explanation),
          attestation: result.attestation,
          dryRun: invalid ? null : preview,
        },
      ]);
      if (!intent || !preview) {
        setQuote(null);
        setQuoteError(null);
        return;
      }
      if (invalid) {
        setQuote(null);
        setQuoteError(translate(lang, "invalidAmount"));
        return;
      }
      setQuoteError(null);
      setQuote({
        intent,
        dryRun: preview,
        attestation: result.attestation,
        execution: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : translate(lang, "loadFail");
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", text: message }]);
      setQuote(null);
      setTeePhase("unverified");
      if (isAmountError(message, error)) setQuoteError(translate(lang, "invalidAmount"));
    } finally {
      setChatStep(null);
      setLiveText("");
    }
  }

  function chooseLang(next: Lang) {
    setLang(next);
    try {
      window.localStorage.setItem("kotha-lang", next);
    } catch {
      // The in-memory language still applies to this page.
    }
  }

  async function ownerProof(action: string, payload: Record<string, unknown>) {
    const account = (near.signedAccountId || "").trim();
    if (!account) {
      if (ownerConfigured) throw new Error(translate(lang, "connectOwner"));
      return null;
    }
    if (ownerConfigured && account !== configuredOwnerId()) throw new Error(translate(lang, "connectOwner"));
    const sessionOwner = proofUsesSessionOwner(account, { sessionOwnerOptIn: !strictOwnerMode() });
    return createWalletProof((params) => near.signNEP413Message(params), action, payload, Date.now(), sessionOwner);
  }

  async function savePolicy(patch: PolicyPatch) {
    const intent = quote?.intent ?? null;
    try {
      const payload = { policy: patch };
      const wallet = await ownerProof("update_policy", payload);
      const result = await run("policy", () => postPolicy(patch, wallet));
      setNotice(remoteLine(translate(lang, "saved"), result.remoteError));
      await refresh();
      if (!intent) return;
      try {
        const dry = await run("quote", () => postDryRun(intent));
        publishPreview(intent, dry.preview);
      } catch (error) {
        if (error instanceof DeckRequestError && error.preview) publishPreview(intent, error.preview);
        setNotice(error instanceof Error ? error.message : translate(lang, "loadFail"));
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : translate(lang, "loadFail"));
      throw error;
    }
  }

  async function rotate() {
    try {
      const wallet = await ownerProof("rotate_grant", {});
      const result = await run("rotate", () => postGrant("rotate_grant", wallet));
      setRevealedToken(result.token);
      setNotice(remoteLine(translate(lang, "rotated"), result.remoteError));
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : translate(lang, "loadFail"));
    }
  }

  async function revoke() {
    try {
      const wallet = await ownerProof("revoke_grant", {});
      const result = await run("revoke", () => postGrant("revoke_grant", wallet));
      setRevealedToken(null);
      setNotice(remoteLine(translate(lang, "revokedNotice"), result.remoteError));
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : translate(lang, "loadFail"));
    }
  }

  async function freeze() {
    const next = !frozen;
    try {
      const payload = { frozen: next };
      const wallet = await ownerProof("emergency_freeze", payload);
      const result = await run("freeze", () => postFreeze(next, wallet));
      setDashboard((current) =>
        current
          ? { ...current, agentState: { ...current.agentState, frozen: result.frozen, policy: result.policy } }
          : current,
      );
      setNotice(remoteLine(translate(lang, result.frozen ? "frozenNotice" : "unfrozenNotice"), result.remoteError));
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : translate(lang, "loadFail"));
    }
  }

  async function refreshQuote() {
    if (!quote) return;
    const intent = quote.intent;
    try {
      const result = await run("quote", () => postDryRun(intent));
      publishPreview(intent, result.preview);
    } catch (error) {
      if (error instanceof DeckRequestError && error.preview) publishPreview(intent, error.preview);
      setNotice(error instanceof Error ? error.message : translate(lang, "loadFail"));
    }
  }

  async function execute() {
    if (!quote) return;
    try {
      const account = (near.signedAccountId || "").trim();
      if (ownerConfigured && account !== configuredOwnerId()) {
        setNotice(translate(lang, "connectOwner"));
        return;
      }
      if (quote.attestation.verification.status !== "verified") {
        setNotice(quote.attestation.verification.reason || translate(lang, "unverifiedBadge"));
        return;
      }
      const teeAttestation = {
        chatId: quote.attestation.chatId,
        requestSha256: quote.attestation.requestSha256,
        responseSha256: quote.attestation.responseSha256,
        signature: quote.attestation.signature,
        signing_address: quote.attestation.signing_address,
        verificationStatus: quote.attestation.verification.status,
      };
      const payload = { intent: quote.intent, teeAttestation };
      const wallet = await ownerProof("execute", payload);
      const result = await run("execute", () => postExecute(quote.intent, teeAttestation, wallet));
      setQuote((current) => (current ? { ...current, execution: result.execution, dryRun: result.execution.preview } : current));
      if (result.simulated || result.execution.remote_status === "simulated-demo") {
        setNotice(translate(lang, "demoSimulated"));
        await refresh();
        return;
      }
      if (!account) {
        setNotice(result.vault.chain_error || translate(lang, "serverSigned"));
        if (result.vault.tx_hash || result.vault.receipt_hash) {
          setLatestChain({
            id: result.execution.correlation_id,
            hash: result.vault.tx_hash || "",
            receiptHash: result.vault.receipt_hash || "",
          });
        }
        await refresh();
        return;
      }
      setNotice(translate(lang, "executedNotice"));
      let txHash = result.vault.tx_hash || "";
      let receiptHash = result.vault.receipt_hash || "";
      if (!txHash) {
        try {
          const recorded = await submitOwnerRecord(result.execution.correlation_id);
          txHash = recorded.txHash;
          receiptHash = recorded.receiptHash || receiptHash;
          const savePayload = { id: result.execution.correlation_id, tx_hash: txHash };
          const saveProof = await ownerProof("save_tx", savePayload);
          await postSaveTx(savePayload.id, txHash, saveProof);
        } catch (chainError) {
          setNotice(chainError instanceof Error ? chainError.message : translate(lang, "loadFail"));
        }
      }
      if (txHash || receiptHash) setLatestChain({ id: result.execution.correlation_id, hash: txHash, receiptHash });
      await refresh();
      window.setTimeout(() => {
        document.getElementById(`exec-${result.execution.correlation_id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }, 50);
    } catch (error) {
      if (error instanceof DeckRequestError && error.preview) {
        setQuote((current) => (current ? { ...current, dryRun: error.preview as DryRunPreview } : current));
      }
      setNotice(error instanceof Error ? error.message : translate(lang, "loadFail"));
    }
  }

  async function submitOwnerRecord(id: string): Promise<{ txHash: string; receiptHash: string }> {
    const response = await fetch(`/api/receipts/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(translate(lang, "receiptNotStored"));
    const parsed = parseFrozenReceiptJson(await response.text());
    if (!parsed) throw new Error(translate(lang, "receiptUnreadable"));
    const call = walletRecordCall(publicContractId(), parsed.receipt, parsed.receipt_hash);
    const outcome = await near.callFunctionRaw(call);
    const txHash = txHashFromOutcome(outcome);
    if (!txHash) throw new Error(translate(lang, "walletNoHash"));
    return { txHash, receiptHash: parsed.receipt_hash };
  }

  async function verifyOnChain(correlationId: string, receiptHash?: string): Promise<"match" | "mismatch"> {
    let hash = receiptHash || "";
    if (!hash) {
      const response = await fetch(`/api/receipts/${encodeURIComponent(correlationId)}`, { cache: "no-store" });
      if (response.ok) hash = parseFrozenReceiptJson(await response.text())?.receipt_hash || "";
    }
    const viewed = await near.viewFunction(executionViewCall(publicContractId(), correlationId));
    return chainMatches(viewed, hash) ? "match" : "mismatch";
  }

  const grant = dashboard?.agentState.grant;
  const reason = ownerLock || quoteError || blockReason(lang, frozen, grant, quote);

  const tabs: Array<{ id: TabId; key: "tabChat" | "tabGuard" | "tabProofs" | "tabSettings" }> = [
    { id: "chat", key: "tabChat" },
    { id: "guard", key: "tabGuard" },
    { id: "proofs", key: "tabProofs" },
    { id: "settings", key: "tabSettings" },
  ];

  return (
    <div className="min-h-screen bg-[#05070b]">
      <TelemetryBar lang={lang} onLang={chooseLang} />
      <main className="mx-auto w-full max-w-[1200px] px-6 pb-6 pt-[88px]">
        {frozen ? (
          <div className="mb-4 rounded-2xl border border-[#FF3B5C]/50 bg-[#FF3B5C]/15 px-4 py-3 text-center text-sm text-[#ffd0d8]">
            {translate(lang, "lockdown")}
          </div>
        ) : null}
        {notice ? (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white/80">
            <p className="min-w-0 break-words">{notice}</p>
            <button type="button" className="text-base text-white/50" onClick={() => setNotice(null)} aria-label={translate(lang, "close")}>
              ×
            </button>
          </div>
        ) : null}
        {loadError ? (
          <div className="mb-4 max-w-md space-y-3">
            <p className="text-sm text-[#ffb3c0]">{loadError}</p>
            <ShimmerActionButton
              onClick={() => {
                setLoadError(null);
                void openDeck().catch((error: unknown) => {
                  setLoadError(error instanceof Error ? error.message : translate(lang, "loadFail"));
                });
              }}
            >
              {translate(lang, "retry")}
            </ShimmerActionButton>
          </div>
        ) : null}
        <div role="tablist" aria-label={lang === "bn" ? translate(lang, "brandMark") : translate(lang, "brand")} className="mb-6 flex gap-2 overflow-x-auto pb-2">
          {tabs.map((item) => {
            const selected = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setTab(item.id)}
                className={`shrink-0 rounded-full px-4 py-2 text-sm whitespace-nowrap ${selected ? "bg-[#00EC97] text-[#04140d]" : "bg-white/5 text-white/75"}`}
              >
                {translate(lang, item.key)}
              </button>
            );
          })}
        </div>
        {tab === "chat" ? (
          <CopilotPanel
            lang={lang}
            model={model}
            baseUrl={enclave?.base_url || "https://cloud-api.near.ai/v1"}
            messages={messages}
            thinking={thinking}
            chatStep={chatStep}
            liveText={liveText}
            autoRedact={autoRedact}
            frozen={frozen}
            teePhase={teePhase}
            onAutoRedact={setAutoRedact}
            onSend={(text) => void send(text)}
            onDryRun={() => {
              setTab("guard");
              void refreshQuote();
            }}
            onExecute={() => void execute()}
          />
        ) : null}
        {dashboard && tab === "guard" ? (
          <SpendingGuard
            lang={lang}
            policy={dashboard.agentState.policy}
            frozen={frozen}
            ownerLock={ownerLock}
            quoteBusy={busy === "quote"}
            executeBusy={busy === "execute"}
            freezeBusy={busy === "freeze"}
            intent={quote?.intent ?? null}
            dryRun={quote?.dryRun ?? null}
            remittanceLine={remittanceLine}
            quoteError={quoteError}
            executeReason={reason}
            onDryRun={() => void refreshQuote()}
            onExecute={() => void execute()}
            onFreeze={() => void freeze()}
          />
        ) : null}
        {dashboard && tab === "proofs" ? (
          <ProofsTable
            lang={lang}
            executions={dashboard.executions}
            contractId={dashboard.vaultInfo.contractId}
            highlight={quote?.execution?.correlation_id || latestChain?.id || null}
            network={session.network}
            onVerifyChain={verifyOnChain}
          />
        ) : null}
        {dashboard && tab === "settings" ? (
          <div className="space-y-4">
            <ApiKeyCard lang={lang} />
            <PolicyPanel
              lang={lang}
              policy={dashboard.agentState.policy}
              grant={dashboard.agentState.grant}
              frozen={frozen}
              revealedToken={revealedToken}
              policyBusy={busy === "policy"}
              rotateBusy={busy === "rotate"}
              revokeBusy={busy === "revoke"}
              ownerLock={ownerLock}
              grantNotice={grantNotice}
              onSave={savePolicy}
              onRotate={() => void rotate()}
              onRevoke={() => void revoke()}
            />
            <details className="rounded-2xl border border-white/10 bg-[#07110d] p-4 shadow-[0_16px_40px_rgba(0,0,0,0.35)]">
              <summary className="cursor-pointer text-sm text-[#b8ffe0]">{translate(lang, "showDetails")}</summary>
              <div className="mt-4">
                <PhoneBook
                  lang={lang}
                  onChange={() => {
                    if (lastPrompt) void refreshRemittance(lastPrompt);
                  }}
                />
              </div>
            </details>
          </div>
        ) : null}
      </main>
    </div>
  );
}

function sameIntent(left: AegisIntent, right: AegisIntent): boolean {
  return (
    left.action === right.action &&
    left.origin_asset === right.origin_asset &&
    left.destination_asset === right.destination_asset &&
    left.amount === right.amount &&
    left.recipient === right.recipient &&
    left.confidential === right.confidential
  );
}

function isAmountError(message: string, error: unknown): boolean {
  if (/invalid amount/i.test(message) || message.includes("Amount must be greater than zero")) return true;
  return error instanceof DeckRequestError && error.code === "invalid_amount";
}

function remoteLine(base: string, remoteError: string | null): string {
  if (!remoteError) return base;
  return `${base} ${remoteError}`;
}

function blockReason(lang: Lang, frozen: boolean, grant: PublicGrant | undefined, quote: ArmedQuote | null): string | null {
  if (frozen) return translate(lang, "frozenReason");
  if (!grant || grant.revoked || !grant.active || Date.parse(grant.expiresAt) <= Date.now()) return translate(lang, "grantReason");
  if (!quote) return translate(lang, "noIntentReason");
  if (!quote.dryRun.allowed) return quote.dryRun.warnings[0] || translate(lang, "blockedReason");
  return null;
}
