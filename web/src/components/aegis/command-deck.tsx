"use client";

import { useKothaSession } from "@/app/providers";
import { ApiKeyCard } from "@/components/aegis/api-key-card";
import { DeckRequestError, fetchDashboard, fetchTeeCatalog, postAdminLock, postAdminUnlock, postDryRun, postFreeze, postGrant, postLocalPreview, postPolicy, postSaveTx, postTeeChatStream, postTranslateMany } from "@/components/aegis/api";
import { ProofsTable, dryRunIsBlocked, formatWarning, type ChainLink } from "@/components/aegis/audit-panel";
import { CopilotPanel, isChipKey, usesFixedPreviewCopy, type ChatMessage } from "@/components/aegis/copilot-panel";
import { translate, type CopyKey, type Lang } from "@/components/aegis/copy";
import { isNativeNearTransfer } from "@/components/aegis/format";
import { PhoneBook } from "@/components/aegis/phone-book";
import { PolicyPanel } from "@/components/aegis/policy-panel";
import { SpendingGuard } from "@/components/aegis/spending-guard";
import { TelemetryBar } from "@/components/aegis/telemetry-bar";
import { ShimmerActionButton } from "@/components/ui/aegis-primitives";
import { viewAccountStatus, type AccountViewStatus } from "@/lib/account-view";
import { invalidAmountReason } from "@/lib/budget-math";
import { noticeForApiError } from "@/lib/deck-errors";
import { compareChainToReceipt, type VerifyResult } from "@/lib/chain-verify";
import { acceptedTranslation, displayReply, withoutStaleSwapRefusals, type LoaderStep } from "@/lib/chat-stream";
import { selectArmedQuote } from "@/lib/guard-quote";
import { isLocalChatPreview } from "@/lib/local-command";
import {
  DAILY_CAP_CENTS,
  NATIVE_GAS_BUFFER_YOCTO,
  PER_TX_CAP_CENTS,
  accountMissingError,
  asYocto,
  buildNativeTransferBatch,
  classifyWalletError,
  executeAdmission,
  executionFailed,
  hashesFromOutcomes,
  localTransferProof,
  namedAccountMustExist,
  nativeExecuteBlock,
  nearToYoctoString,
  notionalCents,
  senderCovers,
  unsupportedBatchError,
  type CardOutcome,
  type WalletExecution,
} from "@/lib/native-transfer";
import { overallTeePhase } from "@/lib/tee-status";
import { resolveRemittance } from "@/lib/phone-resolver";
import { clearPendingSend, mergeTransferHashes, persistCardOutcome, readPendingSend, readWalletLedger, rememberPendingSend, rememberWalletSend, type LedgerEntry } from "@/lib/wallet-ledger";
import { parseWalletReturnHashes, stripWalletReturnParams } from "@/lib/wallet-return";
import {
  configuredOwnerId,
  isInsufficientBalance,
  TESTNET_FAUCET_URL,
  createWalletProof,
  proofUsesSessionOwner,
  publicContractId,
  strictOwnerMode,
  txHashFromOutcome,
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
  const [cardOutcomes, setCardOutcomes] = useState<Record<string, CardOutcome>>({});
  const [executedIds, setExecutedIds] = useState<string[]>([]);
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);
  const [executeCardId, setExecuteCardId] = useState<string | null>(null);
  const [dashReady, setDashReady] = useState(false);
  const [ledgerReady, setLedgerReady] = useState(false);
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
  const executeFlight = useRef(false);
  const executedRef = useRef(new Set<string>());
  const refreshFlight = useRef<Promise<DashboardResponse | null> | null>(null);
  const lastRefreshAt = useRef(0);
  const accountChecks = useRef(new Set<string>());
  const langRef = useRef(lang);
  langRef.current = lang;
  const [accountGate, setAccountGate] = useState<Record<string, AccountViewStatus>>({});

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
    const store = readWalletLedger();
    executedRef.current = new Set(store.executedIds);
    setExecutedIds(store.executedIds);
    setLedgerEntries(store.entries);
    setCardOutcomes(store.outcomes);
    setLedgerReady(true);
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

  const refresh = useCallback(async (force = false): Promise<DashboardResponse | null> => {
    if (refreshFlight.current) return refreshFlight.current;
    if (!force && Date.now() - lastRefreshAt.current < 1500) return null;
    const run = fetchDashboard()
      .then((next) => {
        lastRefreshAt.current = Date.now();
        setDashboard(next);
        return next;
      })
      .finally(() => {
        refreshFlight.current = null;
      });
    refreshFlight.current = run;
    return run;
  }, []);

  const refreshUntil = useCallback(
    async (correlationId: string) => {
      const gaps = [0, 4000, 5000, 5000];
      for (const gap of gaps) {
        if (gap) await new Promise((resolve) => window.setTimeout(resolve, gap));
        try {
          const next = await refresh(true);
          if (next?.executions.some((row) => row.correlation_id === correlationId)) return;
        } catch {
          // list_executions can lag the send. The next gap tries again.
        }
      }
    },
    [refresh],
  );

  const recoverWalletReturn = useCallback(async () => {
    const parsed = parseWalletReturnHashes(window.location.search, window.location.hash);
    if (parsed.transferHash) {
      const pending = readPendingSend();
      const nextUrl = stripWalletReturnParams(window.location.href);
      window.history.replaceState(window.history.state, "", nextUrl);
      if (pending) {
        const proofMissing = !parsed.proofHash;
        const outcome: CardOutcome = {
          tone: proofMissing ? "warn" : "ok",
          amount: pending.amount,
          recipient: pending.recipient,
          proofMissing,
          transferHash: parsed.transferHash,
          proofHash: parsed.proofHash || undefined,
        };
        const stored = rememberWalletSend(
          {
            cardId: pending.cardId,
            correlationId: pending.correlationId,
            transferHash: parsed.transferHash,
            proofHash: parsed.proofHash,
            amount: pending.amount,
            recipient: pending.recipient,
            proofMissing,
          },
          outcome,
        );
        if (pending.cardId) executedRef.current.add(pending.cardId);
        setExecutedIds(stored.executedIds);
        setLedgerEntries(stored.entries);
        setCardOutcomes((current) => (pending.cardId ? { ...current, [pending.cardId]: outcome } : current));
        clearPendingSend();
        void postSaveTx(pending.correlationId, parsed.transferHash, null, parsed.proofHash).catch(() => undefined);
        await refreshUntil(pending.correlationId);
        return;
      }
    }
    await refresh(false);
  }, [refresh, refreshUntil]);

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
        setLoadError(noticeForApiError(langRef.current, error));
      })
      .finally(() => {
        if (live) setDashReady(true);
      });
    return () => {
      live = false;
    };
  }, [openDeck]);

  useEffect(() => {
    const onShow = () => {
      void recoverWalletReturn();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh(false);
    };
    window.addEventListener("pageshow", onShow);
    document.addEventListener("visibilitychange", onVisible);
    void recoverWalletReturn();
    return () => {
      window.removeEventListener("pageshow", onShow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [recoverWalletReturn, refresh]);

  useEffect(() => {
    const ids = new Set<string>();
    const consider = (intent: AegisIntent | null | undefined, blocked: boolean) => {
      if (blocked || !intent || !isNativeNearTransfer(intent)) return;
      const recipient = intent.recipient.trim();
      if (!namedAccountMustExist(recipient)) return;
      ids.add(recipient);
    };
    for (const message of messages) {
      const decision = message.attestation?.decision;
      consider(decision?.intent, decision?.policy_status === "BLOCKED");
    }
    consider(quote?.intent, false);
    for (const id of ids) {
      if (accountChecks.current.has(id)) continue;
      accountChecks.current.add(id);
      void viewAccountStatus(id).then((status) => {
        setAccountGate((current) => (current[id] === status ? current : { ...current, [id]: status }));
      });
    }
  }, [messages, quote]);

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
      const blockedInjection =
        result.attestation.decision.policy_status === "BLOCKED" &&
        (/prompt injection/i.test(result.attestation.decision.policy_reason) ||
          (result.attestation.decision.risk_score >= 99 && intent.recipient === "attacker.near"));
      if (blockedInjection) {
        setQuote(null);
        setQuoteError(null);
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
      const message = timeout ? "" : aiLimitText(lang, error) || noticeForApiError(lang, error);
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

  function walletMaySendNative(account: string): boolean {
    if (!account) return false;
    if (chainKnown) return account === chainOwner || account === chainAgent;
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
        setNotice(noticeForApiError(lang, error));
      }
    } catch (error) {
      setNotice(noticeForApiError(lang, error));
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
      setNotice(noticeForApiError(lang, error));
    }
  }

  async function lockAdmin() {
    try {
      await run("admin", () => postAdminLock());
      setNotice(translate(lang, "adminOff"));
      await refresh();
    } catch (error) {
      setNotice(noticeForApiError(lang, error));
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
      setNotice(noticeForApiError(lang, error));
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
      setNotice(noticeForApiError(lang, error));
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
      setNotice(noticeForApiError(lang, error));
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
      setNotice(noticeForApiError(lang, error));
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
      setNotice(noticeForApiError(lang, error));
    }
  }

  function openGuard(intentId: string) {
    const armed = quoteFromCard(intentId);
    if (armed) setQuote(armed);
    setTab("guard");
  }

  function showCard(cardId: string, outcome: CardOutcome) {
    setCardOutcomes((current) => ({ ...current, [cardId]: outcome }));
    persistCardOutcome(cardId, outcome);
    window.setTimeout(() => {
      const node = document.getElementById(`card-${cardId}`) || document.getElementById("guard-card");
      node?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
  }

  async function execute(intentId?: string) {
    const armed = resolveArmed(intentId);
    const cardId = armed?.id || intentId || quote?.intentId || "";
    const admission = executeAdmission({
      inFlight: executeFlight.current || !ledgerReady,
      alreadyExecuted: Boolean(cardId && executedRef.current.has(cardId)),
    });
    if (admission !== "start") return;
    executeFlight.current = true;
    if (cardId) setExecuteCardId(cardId);
    setBusy("execute");
    let wrotePending = false;
    const failKey = (key: CopyKey, faucet = false) => {
      if (cardId) showCard(cardId, { tone: "fail", failKey: key, faucet });
    };
    const failText = (text: string, faucet = false) => {
      if (cardId) showCard(cardId, { tone: "fail", text, faucet });
    };
    try {
      if (!armed) {
        failKey("executeFailed");
        return;
      }
      if (armed.dryRun) {
        setQuote({
          intentId: cardId,
          intent: armed.intent,
          dryRun: armed.dryRun,
          attestation: armed.attestation,
          execution: quote?.intentId === cardId ? quote.execution : null,
        });
      }
      const account = (near.signedAccountId || "").trim();
      if (!walletMaySendNative(account)) {
        failKey(account ? "walletUnauthorized" : "connectOwner");
        return;
      }
      const block = nativeExecuteBlock(armed.intent);
      if (block) {
        failKey(block);
        return;
      }
      if (frozen) {
        failKey("lockdown");
        return;
      }
      let yocto = "";
      try {
        yocto = nearToYoctoString(armed.intent.amount);
      } catch {
        failKey("invalidAmount");
        return;
      }
      let preview = armed.dryRun;
      try {
        const dry = await postDryRun(armed.intent, account);
        preview = dry.preview;
        publishPreview(cardId, armed.intent, dry.preview);
      } catch (error) {
        if (error instanceof DeckRequestError && error.preview) {
          preview = error.preview;
          publishPreview(cardId, armed.intent, error.preview);
        } else {
          failText(noticeForApiError(lang, error, "executeFailed"));
          return;
        }
      }
      if (!preview || dryRunIsBlocked(preview) || preview.policyAllowed === false) {
        failText(policyText(lang, preview?.warnings));
        return;
      }
      if (preview.balance === "insufficient") {
        failKey("lowBalance", true);
        return;
      }
      const cents = notionalCents(preview.budgetImpact?.txUsd, armed.intent.amount_usd_estimate);
      const spentCents = Math.round((dashboard?.agentState.policy.spentTodayUsd ?? 0) * 100);
      if (cents > PER_TX_CAP_CENTS || spentCents + cents > DAILY_CAP_CENTS) {
        failText(policyText(lang, preview.warnings));
        return;
      }
      const recipient = armed.intent.recipient.trim();
      if (namedAccountMustExist(recipient)) {
        try {
          await near.getBalance(recipient);
        } catch (error) {
          failKey(accountMissingError(error) ? "executeAccountMissing" : "executeCheckFailed");
          return;
        }
      }
      const senderBalance = asYocto(await near.getBalance(account));
      if (senderBalance == null) {
        failKey("executeCheckFailed");
        return;
      }
      if (!senderCovers(senderBalance, yocto, NATIVE_GAS_BUFFER_YOCTO)) {
        failKey("lowBalance", true);
        return;
      }
      const proof = await localTransferProof(armed.attestation);
      const execution: WalletExecution = {
        correlation_id: `nt-${crypto.randomUUID()}`,
        agent_id: account,
        action_type: "transfer",
        origin_asset: armed.intent.origin_asset,
        destination_asset: armed.intent.destination_asset,
        amount_atomic: yocto,
        usd_amount_cents: cents,
        near_ai_chat_id: proof.near_ai_chat_id,
        tee_signing_address: proof.tee_signing_address,
        request_sha256: proof.request_sha256,
        response_sha256: proof.response_sha256,
        tee_signature: proof.tee_signature,
        timestamp_ns: Number(BigInt(Date.now()) * 1_000_000n),
      };
      const contractId = publicContractId();
      const batch = buildNativeTransferBatch(recipient, yocto, contractId, execution);
      rememberPendingSend({
        correlationId: execution.correlation_id,
        cardId,
        amount: armed.intent.amount,
        recipient,
      });
      wrotePending = true;
      let transferHash = "";
      let proofHash = "";
      let usedBatch = false;
      if (typeof near.signAndSendTransactions === "function") {
        try {
          const outcomes = await near.signAndSendTransactions(batch);
          usedBatch = true;
          const list = Array.isArray(outcomes) ? outcomes : [outcomes];
          if (executionFailed(list[0])) {
            clearPendingSend();
            failKey("executeFailed");
            return;
          }
          const hashes = hashesFromOutcomes(list);
          transferHash = hashes.transferHash;
          proofHash = executionFailed(list[1]) ? "" : hashes.proofHash;
        } catch (error) {
          if (!unsupportedBatchError(error)) throw error;
        }
      }
      if (!usedBatch) {
        const transferred = await near.transfer({ receiverId: recipient, amount: yocto });
        transferHash = txHashFromOutcome(transferred) || "";
        if (!transferHash) throw new Error(translate(lang, "walletNoHash"));
        try {
          const recorded = await near.callFunctionRaw({
            contractId,
            method: "record_execution",
            args: { execution },
            gas: batch.transactions[1].actions[0].params.gas,
            deposit: "0",
          });
          proofHash = txHashFromOutcome(recorded) || "";
        } catch {
          proofHash = "";
        }
      }
      if (!transferHash && !proofHash) {
        clearPendingSend();
        failKey("walletNoHash");
        return;
      }
      const proofMissing = !proofHash;
      const outcome: CardOutcome = {
        tone: proofMissing ? "warn" : "ok",
        amount: armed.intent.amount,
        recipient,
        proofMissing,
        transferHash: transferHash || undefined,
        proofHash: proofHash && proofHash !== transferHash ? proofHash : undefined,
      };
      showCard(cardId, outcome);
      executedRef.current.add(cardId);
      const stored = rememberWalletSend(
        {
          cardId,
          correlationId: execution.correlation_id,
          transferHash,
          proofHash,
          amount: armed.intent.amount,
          recipient,
          proofMissing,
        },
        outcome,
      );
      setExecutedIds(stored.executedIds);
      setLedgerEntries(stored.entries);
      setQuote(null);
      clearPendingSend();
      if (transferHash || proofHash) {
        setLatestChain({ id: execution.correlation_id, hash: transferHash || proofHash, receiptHash: "" });
      }
      if (transferHash) void postSaveTx(execution.correlation_id, transferHash, null, proofHash).catch(() => undefined);
      await refreshUntil(execution.correlation_id);
    } catch (error) {
      if (wrotePending) clearPendingSend();
      const kind = classifyWalletError(error);
      if (kind === "rejected") failKey("executeRejected");
      else if (kind === "insufficient") failKey("lowBalance", true);
      else if (kind === "unauthorized") failKey("walletUnauthorized");
      else failKey("executeFailed");
    } finally {
      executeFlight.current = false;
      setExecuteCardId((current) => (current === cardId ? null : current));
      setBusy((current) => (current === "execute" ? null : current));
    }
  }

  function guardAccountStatus(intent: AegisIntent | null, gate: Record<string, AccountViewStatus>): AccountViewStatus | "checking" | null {
  if (!intent || !isNativeNearTransfer(intent)) return null;
  const recipient = intent.recipient.trim();
  if (!namedAccountMustExist(recipient)) return null;
  return gate[recipient] ?? "checking";
}

function resolveArmed(intentId?: string): { id: string; intent: AegisIntent; attestation: AttestedInference; dryRun: DryRunPreview | null } | null {
    if (intentId) {
      const message = messages.find((item) => item.id === intentId);
      const intent = message?.attestation?.decision.intent;
      if (message?.attestation && intent) {
        return { id: message.id, intent, attestation: message.attestation, dryRun: message.dryRun ?? null };
      }
    }
    if (!quote) return null;
    return { id: quote.intentId, intent: quote.intent, attestation: quote.attestation, dryRun: quote.dryRun };
  }

  async function verifyOnChain(correlationId: string): Promise<VerifyResult> {
    try {
      const [receiptRes, chainRes] = await Promise.all([
        fetch(`/api/receipts/${encodeURIComponent(correlationId)}`, { cache: "no-store" }),
        fetch(`/api/vault/execution?id=${encodeURIComponent(correlationId)}`, { cache: "no-store" }),
      ]);
      let receipt: unknown = null;
      if (receiptRes.ok) {
        try {
          receipt = JSON.parse(await receiptRes.text()) as unknown;
        } catch {
          receipt = null;
        }
      }
      let chain: unknown = null;
      if (chainRes.ok) {
        const body = (await chainRes.json().catch(() => null)) as { raw?: unknown } | null;
        chain = body?.raw ?? null;
      }
      return compareChainToReceipt(chain, receipt);
    } catch {
      return { status: "missing", code: "missing" };
    }
  }

  const executeReason = quoteError || (frozen ? translate(lang, "lockdown") : null) || (quote?.dryRun.balance === "insufficient" ? translate(lang, "lowBalance") : null);
  const executeReady = walletMaySendNative(accountId);
  const executeHint = !executeReady && accountId ? translate(lang, "walletUnauthorized") : null;

  const tabs: Array<{ id: TabId; key: "tabChat" | "tabGuard" | "tabProofs" | "tabSettings" }> = [
    { id: "chat", key: "tabChat" },
    { id: "guard", key: "tabGuard" },
    { id: "proofs", key: "tabProofs" },
    { id: "settings", key: "tabSettings" },
  ];

  return (
    <div className="kotha-app bg-[#05070b]">
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
                  setLoadError(noticeForApiError(lang, error));
                });
              }}
            >
              {translate(lang, "retry")}
            </ShimmerActionButton>
          </div>
        ) : null}
        <div role="tablist" aria-label={lang === "bn" ? translate(lang, "brandMark") : translate(lang, "brand")} className="mb-6 flex gap-1 pb-1">
          {tabs.map((item) => {
            const selected = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => {
                  setTab(item.id);
                  if (item.id === "proofs") void refresh(false);
                }}
                className={`min-w-0 flex-1 break-words rounded-full px-1.5 py-2 text-center text-xs leading-tight sm:px-3 sm:text-sm ${selected ? "bg-[#00EC97] text-[#04140d]" : "bg-white/5 text-white/75"}`}
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
            cardOutcomes={cardOutcomes}
            executeBusy={busy === "execute"}
            executeCardId={executeCardId}
            executedIds={executedIds}
            inputsReady={ledgerReady}
            accountGate={accountGate}
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
        {tab === "guard" && !dashReady ? <p className="text-sm text-white/60">{translate(lang, "dashboardLoading")}</p> : null}
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
            executeReason={executeReason}
            cardOutcome={quote ? cardOutcomes[quote.intentId] ?? null : null}
            executed={Boolean(quote && executedIds.includes(quote.intentId))}
            inputsReady={ledgerReady}
            accountStatus={guardAccountStatus(quote?.intent ?? null, accountGate)}
            onDryRun={() => void refreshQuote()}
            onExecute={() => void execute()}
            onFreeze={() => void freeze()}
          />
        ) : null}
        {tab === "proofs" && !dashReady ? <p className="text-sm text-white/60">{translate(lang, "dashboardLoading")}</p> : null}
        {tab === "proofs" && dashReady && dashboard ? (
          <ProofsTable
            lang={lang}
            executions={mergeTransferHashes(dashboard.executions ?? [], ledgerEntries)}
            contractId={dashboard.vaultInfo.contractId ?? ""}
            highlight={quote?.execution?.correlation_id || latestChain?.id || null}
            network={session.network}
            onVerifyChain={verifyOnChain}
          />
        ) : null}
        {tab === "settings" && !dashReady ? <p className="text-sm text-white/60">{translate(lang, "dashboardLoading")}</p> : null}
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

function policyText(lang: Lang, warnings: string[] | undefined): string {
  const warning = warnings?.find((item) => item !== "INSUFFICIENT_BALANCE" && item !== "BALANCE_SKIPPED") || warnings?.[0] || "";
  if (!warning) return translate(lang, "blockedByPolicy");
  const filled = formatWarning(lang, warning);
  if (/^PROHORI_[A-Z0-9_]+$/.test(filled.trim())) return translate(lang, "blockedByPolicy");
  return filled;
}
