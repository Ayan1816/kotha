"use client";

import { useKothaSession } from "@/app/providers";
import { ApiKeyCard } from "@/components/aegis/api-key-card";
import { DeckRequestError, fetchDashboard, fetchTeeCatalog, postAdminLock, postAdminUnlock, postDryRun, postExecute, postFreeze, postGrant, postLocalPreview, postPolicy, postSaveTx, postTeeChatStream, postTranslateMany } from "@/components/aegis/api";
import { ProofsTable, type ChainLink } from "@/components/aegis/audit-panel";
import { CopilotPanel, isChipKey, usesFixedPreviewCopy, type ChatMessage } from "@/components/aegis/copilot-panel";
import { translate, type Lang } from "@/components/aegis/copy";
import { PhoneBook } from "@/components/aegis/phone-book";
import { PolicyPanel } from "@/components/aegis/policy-panel";
import { SpendingGuard } from "@/components/aegis/spending-guard";
import { TelemetryBar } from "@/components/aegis/telemetry-bar";
import { ShimmerActionButton } from "@/components/ui/aegis-primitives";
import { invalidAmountReason } from "@/lib/budget-math";
import { acceptedTranslation, displayReply, withoutStaleSwapRefusals, type LoaderStep } from "@/lib/chat-stream";
import { selectArmedQuote } from "@/lib/guard-quote";
import { isLocalChatPreview } from "@/lib/local-command";
import { isLocalPreview, overallTeePhase } from "@/lib/tee-status";
import { resolveRemittance } from "@/lib/phone-resolver";
import {
  chainMatches,
  configuredOwnerId,
  isInsufficientBalance,
  TESTNET_FAUCET_URL,
  createWalletProof,
  executionViewCall,
  parseFrozenReceiptJson,
  proofUsesSessionOwner,
  publicContractId,
  strictOwnerMode,
  txHashFromOutcome,
  walletRecordCall,
} from "@/lib/wallet-proof";
import { yoctoToNear } from "near-api-js";
import { useNearWallet } from "near-connect-hooks";
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
import { useCallback, useEffect, useRef, useState } from "react";

const MESSAGE_KEY = "kotha-messages";

type TabId = "chat" | "guard" | "proofs" | "settings";

type ArmedQuote = {
  intentId: string;
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
  const [messagesReady, setMessagesReady] = useState(false);
  const [nearBalance, setNearBalance] = useState<string | null>(null);
  const [quote, setQuote] = useState<ArmedQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [chatStep, setChatStep] = useState<LoaderStep | null>(null);
  const [liveText, setLiveText] = useState("");
  const [latestChain, setLatestChain] = useState<ChainLink | null>(null);
  const [remittanceLine, setRemittanceLine] = useState<string | null>(null);
  const [lastPrompt, setLastPrompt] = useState("");
  const [adminCode, setAdminCode] = useState("");
  const near = useNearWallet();
  const session = useKothaSession();
  const balanceReader = useRef(near.getBalance);
  balanceReader.current = near.getBalance;
  const translateFlight = useRef(new Set<string>());
  const dryTicket = useRef(0);
  const chatQueue = useRef<Array<{ text: string; chipKey?: string; existingId: string }>>([]);
  const chatActive = useRef(false);

  const frozen = dashboard?.agentState.frozen ?? dashboard?.agentState.policy.frozen ?? false;
  const accountId = (near.signedAccountId || "").trim();
  const admin = dashboard?.admin === true;
  const ownerConfigured = strictOwnerMode() && configuredOwnerId().length > 0;
  const vaultInfo = dashboard?.vaultInfo;
  const chainKnown = vaultInfo?.source === "chain";
  const chainOwner = chainKnown ? vaultInfo.owner.trim() : "";
  const chainAgent = chainKnown ? vaultInfo.agentAccount.trim() : "";
  const policyOwnerId = chainKnown ? chainOwner : ownerConfigured ? configuredOwnerId() : "";
  const ownerLock = !admin && policyOwnerId.length > 0 && accountId !== policyOwnerId ? translate(lang, "connectOwner") : null;
  const grantNotice = admin || accountId ? null : translate(lang, "grantLocked");
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

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(MESSAGE_KEY);
      if (raw) setMessages(readStoredMessages(JSON.parse(raw) as unknown));
    } catch {
      // A blocked or corrupt store starts from an empty transcript.
    }
    setMessagesReady(true);
  }, []);

  useEffect(() => {
    if (!messagesReady) return;
    try {
      window.localStorage.setItem(MESSAGE_KEY, JSON.stringify(messages.map(slimMessage)));
    } catch {
      // Quota or a private window must not block the live transcript.
    }
  }, [messages, messagesReady]);

  useEffect(() => {
    if (!accountId) {
      setNearBalance(null);
      return;
    }
    let live = true;
    setNearBalance(null);
    void balanceReader
      .current(accountId)
      .then((value) => {
        if (live) setNearBalance(`${yoctoToNear(value, 4)} NEAR`);
      })
      .catch(() => {
        if (live) setNearBalance(null);
      });
    return () => {
      live = false;
    };
  }, [accountId]);

  useEffect(() => {
    if (!messagesReady || (lang !== "bn" && lang !== "en")) return;
    const pending = messages.filter((message) => {
      if (message.role !== "assistant" || message.errorCode) return false;
      if (usesFixedPreviewCopy(message)) return false;
      if (message.lang !== "bn" && message.lang !== "en") return false;
      if (message.translationFailed) return false;
      if (message.lang === lang || message.translations?.[lang]) return false;
      return !translateFlight.current.has(`${message.id}:${lang}`);
    });
    if (pending.length === 0) return;
    const target = lang;
    const chunks: ChatMessage[][] = [];
    for (let index = 0; index < pending.length; index += 2) chunks.push(pending.slice(index, index + 2));
    for (const chunk of chunks) {
      const keys = chunk.map((message) => `${message.id}:${target}`);
      for (const key of keys) translateFlight.current.add(key);
      const ids = new Set(chunk.map((message) => message.id));
      setMessages((current) => current.map((message) => (ids.has(message.id) ? { ...message, translating: true } : message)));
      void translateChunk(chunk.map((message) => message.text), target, accountId)
        .then((texts) => chunk.map((message, index) => ({ id: message.id, text: texts[index] || "", failed: !texts[index] })))
        .catch(() => chunk.map((message) => ({ id: message.id, text: "", failed: true })))
        .then((results) => {
          for (const key of keys) translateFlight.current.delete(key);
          setMessages((current) =>
            current.map((message) => {
              const found = results.find((item) => item.id === message.id);
              if (!found) return message;
              const accepted = acceptedTranslation(found.failed ? "" : found.text);
              if (!accepted) return { ...message, translating: false, translationFailed: true, text: message.text };
              return {
                ...message,
                translating: false,
                translationFailed: false,
                translations: { ...message.translations, [target]: accepted },
              };
            }),
          );
        });
    }
  }, [accountId, lang, messages, messagesReady]);

  useEffect(() => {
    if (thinking || chatStep == null) return;
    const timer = window.setTimeout(() => setChatStep(null), 0);
    return () => window.clearTimeout(timer);
  }, [thinking, chatStep]);

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

  function publishPreview(intentId: string, intent: AegisIntent, preview: DryRunPreview) {
    const invalid = invalidAmountReason(intent, preview.warnings);
    if (invalid) {
      setQuote((current) => (current?.intentId === intentId ? null : current));
      setQuoteError(translate(lang, "invalidAmount"));
      return;
    }
    setQuoteError(null);
    setQuote((current) => (current && current.intentId === intentId ? { ...current, intent, dryRun: preview, execution: null } : current));
    setMessages((current) => current.map((item) => (item.id === intentId ? { ...item, dryRun: preview } : item)));
  }

  function intentCards(source: ChatMessage[]) {
    const cards: Array<{ id: string; intent: AegisIntent; dryRun: DryRunPreview | null; attestation: AttestedInference }> = [];
    for (const message of source) {
      const intent = message.attestation?.decision.intent;
      if (!intent || !message.attestation) continue;
      cards.push({ id: message.id, intent, dryRun: message.dryRun ?? null, attestation: message.attestation });
    }
    return cards;
  }

  function quoteFromCard(intentId: string): ArmedQuote | null {
    const card = selectArmedQuote(intentCards(messages), intentId);
    if (!card?.attestation) return null;
    const preview = card.dryRun;
    if (!preview) return null;
    return {
      intentId: card.id,
      intent: card.intent,
      dryRun: preview,
      attestation: card.attestation,
      execution: quote?.intentId === card.id ? quote.execution : null,
    };
  }

  async function refreshRemittance(text: string) {
    setLastPrompt(text);
    const resolution = await resolveRemittance(text);
    setRemittanceLine(resolution?.line ?? null);
  }

  function retryMessage(id: string) {
    const message = messages.find((item) => item.id === id);
    if (!message || message.role !== "user") return;
    enqueueChat(message.text, message.chipKey, id);
  }

  function retryTranslation(id: string) {
    if (lang !== "bn" && lang !== "en") return;
    translateFlight.current.delete(`${id}:${lang}`);
    setMessages((current) =>
      current.map((message) => (message.id === id ? { ...message, translationFailed: false, translating: false } : message)),
    );
  }

  function enqueueChat(text: string, chipKey?: string, existingId?: string) {
    const id = existingId || crypto.randomUUID();
    if (!existingId) {
      setMessages((current) => [
        ...current,
        { id, role: "user", lang: textLang(text, lang), text, chipKey: isChipKey(chipKey) ? chipKey : undefined },
      ]);
    }
    chatQueue.current.push({ text, chipKey, existingId: id });
    if (chatActive.current) return;
    chatActive.current = true;
    void drainChat();
  }

  async function drainChat() {
    try {
      while (chatQueue.current.length > 0) {
        const next = chatQueue.current.shift();
        if (!next) break;
        await deliverChat(next.text);
      }
    } finally {
      chatActive.current = false;
      if (chatQueue.current.length > 0) {
        chatActive.current = true;
        void drainChat();
      }
    }
  }

  async function deliverChat(text: string) {
    setQuote(null);
    setQuoteError(null);
    setChatStep("thinking");
    setLiveText("");
    setBusy("chat");
    void refreshRemittance(text);
    try {
      const result = await run("chat", async () => {
        if (isLocalChatPreview(text)) {
          setChatStep("thinking");
          return postLocalPreview({ message: text, model, autoRedact, locale: lang, accountId });
        }
        return postTeeChatStream(
          { message: text, model, autoRedact, locale: lang, accountId },
          {
            onStep: (step) => setChatStep(step),
            onDelta: (next) => {
              setLiveText(next);
              setChatStep((current) => (current === "redacting" ? "thinking" : current));
            },
            onDone: () => setChatStep(null),
          },
        );
      });
      const intent = result.attestation.decision.intent;
      const preview = result.dryRun;
      const invalid = intent && preview ? invalidAmountReason(intent, preview.warnings) : null;
      const reply = displayReply(result.attestation.decision.explanation);
      const replyLang = textLang(reply, lang);
      const replyId = crypto.randomUUID();
      setMessages((current) => [
        ...current,
        {
          id: replyId,
          role: "assistant",
          lang: replyLang,
          text: reply,
          translations: replyLang === "bn" || replyLang === "en" ? { [replyLang]: reply } : {},
          statusCode: result.attestation.decision.policy_status,
          attestation: result.attestation,
          dryRun: invalid ? null : preview,
          dryRunShown: false,
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
        intentId: replyId,
        intent,
        dryRun: preview,
        attestation: result.attestation,
        execution: null,
      });
    } catch (error) {
      const code = aiLimitCode(error);
      const timeout = error instanceof DeckRequestError && error.code === "request_timeout";
      const message = timeout ? "" : aiLimitText(lang, error) || (error instanceof Error ? error.message : translate(lang, "loadFail"));
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          lang,
          text: (code || timeout) ? "" : message,
          errorCode: timeout ? "request_timeout" : code || (message === translate(lang, "loadFail") ? "load_fail" : undefined),
        },
      ]);
      setQuote(null);
      if (isAmountError(message, error)) setQuoteError(translate(lang, "invalidAmount"));
    } finally {
      setChatStep(null);
      setLiveText("");
    }
  }

  function send(text: string, chipKey?: string, existingId?: string) {
    enqueueChat(text, chipKey, existingId);
  }

  function chooseLang(next: Lang) {
    setLang(next);
    try {
      window.localStorage.setItem("kotha-lang", next);
    } catch {
      // The in-memory language still applies to this page.
    }
  }

  function accountMayExecute(account: string): boolean {
    if (admin) return true;
    if (chainKnown) return account.length > 0 && (account === chainOwner || account === chainAgent);
    if (!ownerConfigured) return true;
    return account === configuredOwnerId();
  }

  async function ownerProof(action: string, payload: Record<string, unknown>) {
    if (admin) return null;
    const account = (near.signedAccountId || "").trim();
    if (!account) {
      if (ownerConfigured || chainKnown) throw new Error(translate(lang, "connectOwner"));
      return null;
    }
    if (action === "execute") {
      if (!accountMayExecute(account)) throw new Error(translate(lang, "walletUnauthorized"));
    } else if (policyOwnerId && account !== policyOwnerId) {
      throw new Error(translate(lang, "connectOwner"));
    }
    const sessionOwner = proofUsesSessionOwner(account, { sessionOwnerOptIn: !strictOwnerMode() });
    return createWalletProof((params) => near.signNEP413Message(params), action, payload, Date.now(), sessionOwner);
  }

  async function savePolicy(patch: PolicyPatch) {
    const intent = quote?.intent ?? null;
    const intentId = quote?.intentId ?? "";
    try {
      const payload = { policy: patch };
      const wallet = await ownerProof("update_policy", payload);
      const result = await run("policy", () => postPolicy(patch, wallet));
      setNotice(remoteLine(translate(lang, "saved"), result.remoteError));
      await refresh();
      if (!intent) return;
      try {
        const dry = await run("quote", () => postDryRun(intent, accountId));
        publishPreview(intentId, intent, dry.preview);
      } catch (error) {
        if (error instanceof DeckRequestError && error.preview) publishPreview(intentId, intent, error.preview);
        setNotice(error instanceof Error ? error.message : translate(lang, "loadFail"));
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : translate(lang, "loadFail"));
      throw error;
    }
  }

  async function unlockAdmin() {
    try {
      await run("admin", () => postAdminUnlock(adminCode));
      setAdminCode("");
      setNotice(translate(lang, "adminOn"));
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : translate(lang, "loadFail"));
    }
  }

  async function lockAdmin() {
    try {
      await run("admin", () => postAdminLock());
      setNotice(translate(lang, "adminOff"));
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : translate(lang, "loadFail"));
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
    const intentId = quote.intentId;
    const intent = quote.intent;
    try {
      const result = await run("quote", () => postDryRun(intent, accountId));
      publishPreview(intentId, intent, result.preview);
    } catch (error) {
      if (error instanceof DeckRequestError && error.preview) publishPreview(intentId, intent, error.preview);
      setNotice(error instanceof Error ? error.message : translate(lang, "loadFail"));
    }
  }

  async function dryRunCard(intentId: string) {
    const card = selectArmedQuote(intentCards(messages), intentId);
    if (!card) return;
    const intent = card.intent;
    const ticket = ++dryTicket.current;
    setMessages((current) => current.map((item) => (item.id === intentId ? { ...item, dryRunShown: true } : item)));
    if (card.dryRun) {
      setQuoteError(null);
      setQuote({
        intentId: card.id,
        intent,
        dryRun: card.dryRun,
        attestation: card.attestation,
        execution: quote?.intentId === card.id ? quote.execution : null,
      });
    }
    try {
      const result = await run("quote", () => postDryRun(intent, accountId));
      if (dryTicket.current !== ticket) return;
      const invalid = invalidAmountReason(intent, result.preview.warnings);
      if (invalid) {
        setQuote((current) => (current?.intentId === intentId ? null : current));
        setQuoteError(translate(lang, "invalidAmount"));
        return;
      }
      setQuoteError(null);
      setQuote({
        intentId: card.id,
        intent,
        dryRun: result.preview,
        attestation: card.attestation,
        execution: null,
      });
      setMessages((current) => current.map((item) => (item.id === intentId ? { ...item, dryRun: result.preview, dryRunShown: true } : item)));
    } catch (error) {
      if (dryTicket.current !== ticket) return;
      if (error instanceof DeckRequestError && error.preview) {
        setQuote({
          intentId: card.id,
          intent,
          dryRun: error.preview,
          attestation: card.attestation,
          execution: null,
        });
        setMessages((current) => current.map((item) => (item.id === intentId ? { ...item, dryRun: error.preview, dryRunShown: true } : item)));
      }
      setNotice(error instanceof Error ? error.message : translate(lang, "loadFail"));
    }
  }

  function openGuard(intentId: string) {
    const armed = quoteFromCard(intentId);
    if (armed) setQuote(armed);
    setTab("guard");
  }

  async function execute(intentId?: string) {
    const armed = intentId ? quoteFromCard(intentId) : quote;
    if (!armed) return;
    if (intentId) setQuote(armed);
    try {
      const account = (near.signedAccountId || "").trim();
      if (!admin && !accountMayExecute(account)) {
        setNotice(account ? translate(lang, "walletUnauthorized") : translate(lang, "connectOwner"));
        return;
      }
      if (!admin && !account && (ownerConfigured || chainKnown)) {
        setNotice(translate(lang, "connectOwner"));
        return;
      }
      if (armed.attestation.verification.status !== "verified") {
        setNotice(isLocalPreview(armed.attestation.verification) ? translate(lang, "localPreview") : armed.attestation.verification.reason || translate(lang, "unverifiedBadge"));
        return;
      }
      const teeAttestation = {
        chatId: armed.attestation.chatId,
        requestSha256: armed.attestation.requestSha256,
        responseSha256: armed.attestation.responseSha256,
        signature: armed.attestation.signature,
        signing_address: armed.attestation.signing_address,
        verificationStatus: armed.attestation.verification.status,
      };
      const payload = { intent: armed.intent, teeAttestation };
      const wallet = await ownerProof("execute", payload);
      const result = await run("execute", () => postExecute(armed.intent, teeAttestation, wallet));
      setQuote((current) =>
        current && current.intentId === armed.intentId ? { ...current, execution: result.execution, dryRun: result.execution.preview } : current,
      );
      if (result.simulated || result.execution.remote_status === "simulated-demo") {
        setNotice(translate(lang, "demoSimulated"));
        await refresh();
        return;
      }
      if (admin || !account) {
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
        setQuote((current) => (current && current.intentId === armed.intentId ? { ...current, dryRun: error.preview as DryRunPreview } : current));
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
  const executeReady = admin || (Boolean(accountId) && accountMayExecute(accountId));
  const executeHint = !executeReady && accountId ? translate(lang, "walletUnauthorized") : null;

  const tabs: Array<{ id: TabId; key: "tabChat" | "tabGuard" | "tabProofs" | "tabSettings" }> = [
    { id: "chat", key: "tabChat" },
    { id: "guard", key: "tabGuard" },
    { id: "proofs", key: "tabProofs" },
    { id: "settings", key: "tabSettings" },
  ];

  return (
    <div className="min-h-screen bg-[#05070b]">
      <TelemetryBar lang={lang} onLang={chooseLang} admin={admin} />
      <main className="mx-auto w-full max-w-[1200px] px-6 pb-6 pt-[88px]">
        {frozen ? (
          <div className="mb-4 rounded-2xl border border-[#FF3B5C]/50 bg-[#FF3B5C]/15 px-4 py-3 text-center text-sm text-[#ffd0d8]">
            {translate(lang, "lockdown")}
          </div>
        ) : null}
        {notice ? (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white/80">
            <p className="min-w-0 break-words">
              {isInsufficientBalance(notice) ? (
                <>
                  {translate(lang, "lowBalance")}{" "}
                  <a href={TESTNET_FAUCET_URL} target="_blank" rel="noreferrer" className="text-[#7DD3FC] underline-offset-2 hover:underline">
                    {translate(lang, "faucetLink")}
                  </a>
                </>
              ) : (
                notice
              )}
            </p>
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
            teePhase={overallTeePhase(messages)}
            accountId={accountId}
            ownerReady={executeReady}
            executeHint={executeHint}
            walletConnected={Boolean(accountId)}
            nearBalance={accountId ? nearBalance : null}
            onAutoRedact={setAutoRedact}
            onSend={(text, chipKey) => void send(text, chipKey)}
            onRetry={retryMessage}
            onRetryTranslate={retryTranslation}
            onDryRun={(id) => void dryRunCard(id)}
            onOpenGuard={openGuard}
            onExecute={(id) => void execute(id)}
          />
        ) : null}
        {dashboard && tab === "guard" ? (
          <SpendingGuard
            lang={lang}
            policy={dashboard.agentState.policy}
            frozen={frozen}
            ownerLock={ownerLock}
            ownerReady={executeReady}
            executeHint={executeHint}
            vaultOwner={vaultInfo?.owner || ""}
            vaultAgent={vaultInfo?.agentAccount || ""}
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
        {tab === "proofs" ? (
          <ProofsTable
            lang={lang}
            executions={dashboard?.executions ?? []}
            contractId={dashboard?.vaultInfo.contractId ?? ""}
            highlight={quote?.execution?.correlation_id || latestChain?.id || null}
            network={session.network}
            onVerifyChain={verifyOnChain}
          />
        ) : null}
        {dashboard && tab === "settings" ? (
          <div className="space-y-4">
            <p className="break-words text-sm text-white/70">
              {translate(lang, "vaultOwner")}: {vaultInfo?.owner || "—"}
              {" · "}
              {translate(lang, "vaultAgent")}: {vaultInfo?.agentAccount || "—"}
            </p>
            <ApiKeyCard lang={lang} />
            <AdminModeCard
              lang={lang}
              unlocked={admin}
              code={adminCode}
              busy={busy === "admin"}
              onCode={setAdminCode}
              onUnlock={() => void unlockAdmin()}
              onLock={() => void lockAdmin()}
            />
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
              showGrant={Boolean(accountId)}
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

function AdminModeCard({
  lang,
  unlocked,
  code,
  busy,
  onCode,
  onUnlock,
  onLock,
}: {
  lang: Lang;
  unlocked: boolean;
  code: string;
  busy: boolean;
  onCode: (value: string) => void;
  onUnlock: () => void;
  onLock: () => void;
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-[#07110d] p-4 shadow-[0_16px_40px_rgba(0,0,0,0.35)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold text-white">{translate(lang, "adminTitle")}</h2>
          <p className="mt-1 text-sm text-white/60">{translate(lang, "adminHint")}</p>
        </div>
        <ShimmerActionButton loading={busy} onClick={unlocked ? onLock : onUnlock}>
          {unlocked ? translate(lang, "adminLock") : translate(lang, "adminUnlock")}
        </ShimmerActionButton>
      </div>
      {unlocked ? null : (
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            onUnlock();
          }}
        >
          <input
            type="password"
            name="kotha-admin-code"
            autoComplete="off"
            value={code}
            onChange={(event) => onCode(event.target.value)}
            placeholder={translate(lang, "adminPlaceholder")}
            className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none placeholder:text-white/35"
          />
        </form>
      )}
    </section>
  );
}

async function translateChunk(texts: string[], target: "bn" | "en", accountId: string): Promise<string[]> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** (attempt - 1)));
    try {
      return await postTranslateMany({ texts, target, accountId });
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error("Translation failed.");
}

function aiLimitCode(error: unknown): string {
  if (!(error instanceof DeckRequestError)) return "";
  if (error.code === "free_limit" || error.code === "wallet_limit") return error.code;
  return "";
}

function textLang(text: string, ui: Lang): Lang {
  if (/[\u0980-\u09FF]/.test(text)) return "bn";
  if (/[A-Za-z]{2,}/.test(text)) return "en";
  return ui === "bn" ? "bn" : "en";
}

function readStoredMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const out: ChatMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || (record.role !== "user" && record.role !== "assistant") || typeof record.text !== "string") continue;
    const bag = record.translations && typeof record.translations === "object" ? (record.translations as { bn?: unknown; en?: unknown }) : {};
    const translations: { bn?: string; en?: string } = {};
    if (typeof bag.bn === "string") translations.bn = bag.bn;
    if (typeof bag.en === "string") translations.en = bag.en;
    const lang = record.lang === "bn" || record.lang === "en" || record.lang === "es" || record.lang === "ar" || record.lang === "hi" || record.lang === "fr" || record.lang === "zh" ? record.lang : "en";
    out.push({
      id: record.id,
      role: record.role,
      lang,
      text: record.text,
      chipKey: isChipKey(record.chipKey) ? record.chipKey : undefined,
      translations,
      translationFailed: record.translationFailed === true,
      statusCode: typeof record.statusCode === "string" ? record.statusCode : undefined,
      errorCode: typeof record.errorCode === "string" ? record.errorCode : undefined,
      attestation: record.attestation as ChatMessage["attestation"],
      dryRun: (record.dryRun as ChatMessage["dryRun"]) ?? null,
      dryRunShown: record.dryRunShown === true,
    });
  }
  return withoutStaleSwapRefusals(out).slice(-40);
}

function slimMessage(message: ChatMessage): ChatMessage {
  const attestation = message.attestation;
  if (!attestation) return { ...message, translating: false };
  return {
    ...message,
    translating: false,
    attestation: {
      ...attestation,
      intel_quote: "",
      nvidia_payload: "",
      rawResponseText: "",
      hardware: null,
      request: {
        model: attestation.model,
        stream: true,
        max_tokens: 800,
        response_format: { type: "json_object" },
        messages: [],
      },
    },
  };
}

function aiLimitText(lang: Lang, error: unknown): string {
  if (!(error instanceof DeckRequestError)) return "";
  if (error.code === "free_limit") return translate(lang, "freeLimit");
  if (error.code === "wallet_limit") return translate(lang, "walletLimit");
  return "";
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
  const dry = quote.dryRun;
  if (dry.balance === "skipped" && dry.policyAllowed !== false) return translate(lang, "needsWallet");
  if (dry.balance === "insufficient" && dry.policyAllowed !== false) return translate(lang, "lowBalance");
  if (!dry.allowed) return humanWarning(lang, dry.warnings[0]) || translate(lang, "blockedReason");
  return null;
}

function humanWarning(lang: Lang, warning: string | undefined): string {
  if (!warning) return "";
  if (warning === "INSUFFICIENT_BALANCE") return translate(lang, "insufficientBadge");
  if (warning === "BALANCE_SKIPPED") return translate(lang, "balanceSkipped");
  return warning;
}
