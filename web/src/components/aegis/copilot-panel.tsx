"use client";

import { DryRunSummary } from "@/components/aegis/audit-panel";
import { CopyButton, HashRow } from "@/components/aegis/bits";
import { fillCopy, translate, type CopyKey, type Lang } from "@/components/aegis/copy";
import { actionCopyKey, actionTone, attestationCurl, isNativeNearTransfer, previewSymbol, showSlippageRow, showWnearLine, signatureCurl } from "@/components/aegis/format";
import { displayReply, LOADER_STEPS, readActionCard, visibleMessageText, type LoaderStep } from "@/lib/chat-stream";
import { isLocalPreview } from "@/lib/tee-status";
import { recordedBlobToWav, voiceExceedsLimit } from "@/lib/wav";
import { cn } from "@/lib/utils";
import { EnclaveSwitch, SignatureTamperLab, SpotlightGlassCard, VoiceWaveform } from "@/components/ui/aegis-primitives";
import type { AegisIntent, AttestedInference, ChatModelId, DryRunPreview, PolicyStatus } from "@/lib/dashboard-types";
import { TESTNET_FAUCET_URL } from "@/lib/wallet-proof";
import { Info, Mic, MicOff, Send, Shield } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

const CHIPS = ["chipSwap", "chipRemit", "chipShield", "chipSecurity"] as const;
export type ChipKey = (typeof CHIPS)[number];
const RECORD_LIMIT_MS = 30_000;

export function isChipKey(value: unknown): value is ChipKey {
  return typeof value === "string" && (CHIPS as readonly string[]).includes(value);
}

const FIXED_PREVIEW_STATUS = new Set(["PASS", "WARNING", "BLOCKED", "NEEDS_WALLET", "INSUFFICIENT_BALANCE"]);

/** Preview and status copy is i18n. Only a free question answer is sent for translation. */
export function usesFixedPreviewCopy(message: ChatMessage): boolean {
  if (message.attestation?.decision.policy_reason === "QUESTION") return false;
  const status = message.statusCode || message.attestation?.decision.policy_status || "";
  return FIXED_PREVIEW_STATUS.has(status);
}

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  lang: Lang;
  text: string;
  chipKey?: string;
  translations?: { bn?: string; en?: string };
  translating?: boolean;
  translationFailed?: boolean;
  statusCode?: string;
  errorCode?: string;
  attestation?: AttestedInference;
  dryRun?: DryRunPreview | null;
  dryRunShown?: boolean;
};

export function CopilotPanel({
  lang,
  model,
  baseUrl,
  messages,
  thinking,
  chatStep,
  liveText,
  autoRedact,
  frozen,
  teePhase = "idle",
  accountId = "",
  ownerReady = false,
  walletConnected = false,
  nearBalance = null,
  onAutoRedact,
  onSend,
  onRetry,
  onRetryTranslate,
  onDryRun,
  onOpenGuard,
  onExecute,
}: {
  lang: Lang;
  model: ChatModelId;
  baseUrl: string;
  messages: ChatMessage[];
  thinking: boolean;
  chatStep: LoaderStep | null;
  liveText: string;
  autoRedact: boolean;
  frozen: boolean;
  teePhase?: "idle" | "local" | "unverified" | "verified";
  accountId?: string;
  ownerReady?: boolean;
  walletConnected?: boolean;
  nearBalance?: string | null;
  onAutoRedact: (next: boolean) => void;
  onSend: (text: string, chipKey?: string) => void;
  onRetry?: (id: string) => void;
  onRetryTranslate?: (id: string) => void;
  onDryRun?: (intentId: string) => void;
  onOpenGuard?: (intentId: string) => void;
  onExecute?: (intentId: string) => void;
}) {
  const [input, setInput] = useState("");
  const [listening, setListening] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [demoWave, setDemoWave] = useState(false);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const [micDenied, setMicDenied] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const recordChunks = useRef<Blob[]>([]);
  const discardRecording = useRef(false);
  const captureGen = useRef(0);
  const listeningRef = useRef(false);
  const langRef = useRef(lang);
  const accountRef = useRef(accountId);
  langRef.current = lang;
  accountRef.current = accountId;
  const recordLimit = useRef<number | null>(null);
  const recordTick = useRef<number | null>(null);
  const recordStarted = useRef(0);
  const [uploading, setUploading] = useState(false);
  const demoTimer = useRef<number | null>(null);
  const thinkingRef = useRef(thinking);
  const onSendRef = useRef(onSend);
  thinkingRef.current = thinking;
  onSendRef.current = onSend;

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, thinking, liveText, chatStep]);

  useEffect(() => {
    return () => {
      discardRecording.current = true;
      listeningRef.current = false;
      captureGen.current += 1;
      clearRecordTimers();
      if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
      if (demoTimer.current != null) window.clearTimeout(demoTimer.current);
    };
  }, []);

  function submit(text: string, chipKey?: string) {
    const message = text.trim();
    if (!message || thinkingRef.current) return;
    setInput("");
    onSendRef.current(message, chipKey);
  }

  function clearRecordTimers() {
    if (recordLimit.current != null) window.clearTimeout(recordLimit.current);
    if (recordTick.current != null) window.clearInterval(recordTick.current);
    recordLimit.current = null;
    recordTick.current = null;
  }

  function stopCapture() {
    captureGen.current += 1;
    clearRecordTimers();
    const rec = recorder.current;
    if (rec && rec.state !== "inactive") {
      rec.stop();
      return;
    }
    listeningRef.current = false;
    setListening(false);
  }

  async function startRecorder(pendingStream?: Promise<MediaStream>) {
    const gen = ++captureGen.current;
    recordChunks.current = [];
    discardRecording.current = false;
    clearRecordTimers();
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      listeningRef.current = false;
      setListening(false);
      setMicDenied(false);
      setVoiceNote(translate(langRef.current, "micUnsupported"));
      return;
    }
    listeningRef.current = true;
    setListening(true);
    setElapsed(0);
    setVoiceNote(null);
    setMicDenied(false);
    try {
      const stream = pendingStream ? await pendingStream : await navigator.mediaDevices.getUserMedia({ audio: true });
      if (captureGen.current !== gen || discardRecording.current) {
        stream.getTracks().forEach((track) => track.stop());
        listeningRef.current = false;
        setListening(false);
        return;
      }
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((item) => MediaRecorder.isTypeSupported(item)) || "";
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      rec.ondataavailable = (event) => {
        if (event.data.size > 0) recordChunks.current.push(event.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        clearRecordTimers();
        listeningRef.current = false;
        setListening(false);
        if (discardRecording.current) return;
        const blob = new Blob(recordChunks.current, { type: rec.mimeType || "audio/webm" });
        if (blob.size < 1000) {
          setVoiceNote(translate(langRef.current, "tooShort"));
          return;
        }
        void uploadVoice(blob);
      };
      recorder.current = rec;
      rec.start();
      recordStarted.current = Date.now();
      recordTick.current = window.setInterval(() => {
        setElapsed(Math.min(30, Math.floor((Date.now() - recordStarted.current) / 1000)));
      }, 250);
      recordLimit.current = window.setTimeout(() => {
        if (captureGen.current === gen) stopCapture();
      }, RECORD_LIMIT_MS);
    } catch (error) {
      listeningRef.current = false;
      setListening(false);
      clearRecordTimers();
      const denied = micFailureKey(error) === "micDenied";
      setMicDenied(denied);
      setVoiceNote(translate(langRef.current, denied ? "micDeniedHelp" : micFailureKey(error)));
    }
  }

  function toggleMic() {
    if (uploading) return;
    if (listeningRef.current) {
      stopCapture();
      return;
    }
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMicDenied(false);
      setVoiceNote(translate(langRef.current, "micUnsupported"));
      return;
    }
    const pending = media.getUserMedia({ audio: true });
    void startRecorder(pending);
  }

  async function uploadVoice(blob: Blob) {
    setUploading(true);
    setListening(false);
    listeningRef.current = false;
    setVoiceNote(translate(langRef.current, "transcribing"));
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), RECORD_LIMIT_MS);
    try {
      const converted = await recordedBlobToWav(blob);
      if (converted.duration < 0.5) {
        setVoiceNote(translate(langRef.current, "tooShort"));
        return;
      }
      if (voiceExceedsLimit(converted.duration)) {
        setVoiceNote(translate(langRef.current, "voiceTooLong"));
        return;
      }
      const language = langRef.current === "bn" ? "bn" : "en";
      const file = new File([converted.wav], "audio.wav", { type: "audio/wav" });
      const form = new FormData();
      form.set("file", file);
      form.set("language", language);
      const headers: HeadersInit = {};
      const account = accountRef.current.trim();
      if (account) headers["x-kotha-account"] = account;
      const response = await fetch("/api/voice-transcribe", {
        method: "POST",
        body: form,
        headers,
        credentials: "include",
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      const text = data && typeof data === "object" && "text" in data && typeof data.text === "string" ? data.text.trim() : "";
      if (response.ok && text) {
        setInput(text);
        setVoiceNote(null);
        submit(text);
        return;
      }
      const failure = voiceErrorParts(data);
      const capped = cappedVoiceNote(failure.code, response.status);
      if (capped) {
        setVoiceNote(translate(langRef.current, capped));
        return;
      }
      const spoken = await fallbackSpeech(language);
      if (spoken) {
        setInput(spoken);
        setVoiceNote(null);
        submit(spoken);
        return;
      }
      setVoiceNote(failure.message || translate(langRef.current, "voiceUnavailable"));
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      const spoken = aborted ? "" : await fallbackSpeech(langRef.current === "bn" ? "bn" : "en").catch(() => "");
      if (spoken) {
        setInput(spoken);
        setVoiceNote(null);
        submit(spoken);
        return;
      }
      setVoiceNote(aborted ? translate(langRef.current, "micTimeout") : error instanceof Error ? error.message : translate(langRef.current, "voiceUnavailable"));
    } finally {
      window.clearTimeout(timer);
      setUploading(false);
      setListening(false);
      listeningRef.current = false;
    }
  }

  function fallbackSpeech(language: "bn" | "en"): Promise<string> {
    const Ctor = speechCtor();
    if (!Ctor) return Promise.resolve("");
    setVoiceNote(translate(langRef.current, "listeningAgain"));
    return new Promise((resolve) => {
      const rec = new Ctor();
      let settled = false;
      const finish = (text: string) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(limit);
        resolve(text.trim());
      };
      const limit = window.setTimeout(() => {
        try {
          rec.stop();
        } catch {
          // Already stopped.
        }
        finish("");
      }, 12_000);
      rec.lang = language === "bn" ? "bn-BD" : "en-US";
      rec.interimResults = false;
      rec.continuous = false;
      rec.onresult = (event) => finish(event.results?.[0]?.[0]?.transcript || "");
      rec.onerror = () => finish("");
      try {
        rec.start();
      } catch {
        finish("");
      }
    });
  }

  function playVoiceDemo() {
    if (demoTimer.current != null) window.clearTimeout(demoTimer.current);
    setDemoWave(true);
    demoTimer.current = window.setTimeout(() => {
      setDemoWave(false);
      demoTimer.current = null;
    }, 10_000);
    submit(translate(lang, "chipSwap"), "chipSwap");
  }

  const teeLabel =
    teePhase === "verified"
      ? translate(lang, "verifiedBadge")
      : teePhase === "unverified"
        ? translate(lang, "unverifiedBadge")
        : teePhase === "local"
          ? translate(lang, "localPreview")
          : translate(lang, "teeReady");
  const teeClass =
    teePhase === "verified"
      ? "border-[#00EC97]/50 bg-[#00EC97]/15 text-[#b8ffe0]"
      : teePhase === "local"
        ? "border-white/20 bg-white/8 text-white/75"
        : "border-[#FF8A00]/50 bg-[#FF8A00]/15 text-[#ffd7a1]";

  return (
    <div className="flex min-h-[calc(100dvh-11rem)] flex-col gap-2">
      <div className="flex justify-end">
        <span title={teeLabel} className={cn("max-w-full rounded-full border px-3 py-1 text-sm", teeClass)}>
          {teeLabel}
        </span>
      </div>
      <SpotlightGlassCard alert={frozen} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-full min-h-[calc(100dvh-14rem)] flex-col">
        <details className="border-b border-white/10 px-4 py-3">
          <summary className="cursor-pointer text-sm text-[#b8ffe0]">{translate(lang, "showDetails")}</summary>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3" title={translate(lang, "autoRedactHint")}>
            <div className="flex items-center gap-2">
              <Shield className={`h-4 w-4 ${autoRedact ? "text-[#00EC97]" : "text-white/30"}`} />
              <span className="text-sm text-white/80">{translate(lang, "autoRedact")}</span>
            </div>
            <EnclaveSwitch
              checked={autoRedact}
              onChange={onAutoRedact}
              label={translate(lang, "autoRedact")}
              hint={translate(lang, "autoRedactHint")}
            />
          </div>
          <p className="mt-3 break-all text-sm text-white/50">{model}</p>
          <div className="mt-3">
            <button
              type="button"
              disabled={thinking}
              onClick={playVoiceDemo}
              className="rounded-xl border border-[#00EC97]/40 bg-[#00EC97]/10 px-3 py-2 text-left text-sm font-semibold text-[#d9ffe8] disabled:opacity-50"
            >
              {translate(lang, "voiceDemo")}
            </button>
          </div>
        </details>

        <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
          {messages.length === 0 && !thinking ? (
            <div className="mx-auto flex min-h-[50vh] w-full max-w-lg flex-col items-center justify-center">
            <div className="w-full rounded-2xl border border-white/10 bg-black/30 p-4">
              <h2 className="text-base font-semibold text-white">{translate(lang, "welcomeTitle")}</h2>
              <p className="mt-1 text-sm leading-6 text-white/65">{translate(lang, "welcomeBody")}</p>
            </div>
            </div>
          ) : null}
          {messages.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="ml-8 rounded-2xl rounded-br-md border border-[#00D2FF]/25 bg-[#00D2FF]/8 px-3 py-2 text-sm text-white">
                <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-[#00D2FF]">{translate(lang, "you")}</div>
                {userBubbleText(message, lang)}
                {!thinking && message.id === messages[messages.length - 1]?.id ? (
                  <button type="button" onClick={() => onRetry?.(message.id)} className="mt-2 block text-xs text-[#7DD3FC] underline-offset-2 hover:underline">
                    {translate(lang, "retry")}
                  </button>
                ) : null}
              </div>
            ) : (
              <AssistantBubble
                key={message.id}
                lang={lang}
                message={message}
                baseUrl={baseUrl}
                ownerReady={ownerReady}
                onDryRun={onDryRun}
                onOpenGuard={onOpenGuard}
                onExecute={onExecute}
                onRetryTranslate={onRetryTranslate}
              />
            ),
          )}
          {thinking ? (
            <div className="mr-6 min-w-0 rounded-2xl border border-[#00EC97]/25 bg-black/25 px-3 py-3">
              <StepLoader lang={lang} step={chatStep} />
              <p className="mt-2 min-h-5 whitespace-pre-wrap break-words text-sm leading-relaxed text-white/90">
                {displayReply(liveText)}
                <span className="ml-0.5 inline-block h-[1em] w-px animate-pulse bg-[#00EC97] align-middle" aria-hidden="true" />
              </p>
            </div>
          ) : null}
        </div>

        {listening || demoWave ? (
          <div className="px-4">
            <VoiceWaveform active={listening || demoWave} label={translate(lang, "voiceDemo")} />
          </div>
        ) : null}
        <div className="border-t border-white/10 px-4 pt-3">
          <p className="mb-2 text-xs text-white/55">
            {walletConnected ? `${translate(lang, "nearBalance")}: ${nearBalance ?? "…"}` : translate(lang, "balanceUnavailable")}
          </p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {CHIPS.map((key) => (
              <button
                key={key}
                type="button"
                disabled={thinking}
                onClick={() => submit(translate(lang, key), key)}
                className="shrink-0 whitespace-nowrap rounded-full border border-white/10 bg-black/25 px-3 py-2 text-sm text-white hover:border-[#00EC97]/40 disabled:opacity-50"
              >
                {translate(lang, key)}
              </button>
            ))}
          </div>
        </div>
        <form
          className="mt-auto border-t border-white/10 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit(input);
          }}
        >
          <div className="flex items-end gap-2">
            <button
              type="button"
              title={translate(lang, "voiceHint")}
              aria-label={listening ? translate(lang, "micStop") : translate(lang, "mic")}
              aria-pressed={listening}
              disabled={uploading}
              onClick={toggleMic}
              className={cn(
                "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border",
                listening ? "border-[#00EC97] bg-[#00EC97]/20 text-[#00EC97]" : "border-white/10 text-white/70",
              )}
            >
              {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </button>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit(input);
                }
              }}
              rows={2}
              placeholder={translate(lang, "placeholder")}
              className="min-h-11 flex-1 resize-none rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-[#00EC97]/50"
            />
            <button
              type="submit"
              disabled={thinking || input.trim().length === 0}
              aria-label={translate(lang, "send")}
              className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#00EC97] px-3 text-sm font-semibold text-[#04140d] disabled:opacity-40"
            >
              <Send className="h-4 w-4" />
              {translate(lang, "send")}
            </button>
          </div>
          {listening ? (
            <p className="mt-2 text-sm text-[#00EC97]">
              {formatClock(elapsed)} / 0:30
            </p>
          ) : null}
          {uploading ? <p className="mt-2 text-sm text-[#FFB020]">{translate(lang, "transcribing")}</p> : null}
          {micDenied && !listening && !uploading ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="text-sm text-[#FFB020]" role="status">{translate(lang, "micDeniedHelp")}</p>
              <button type="button" onClick={toggleMic} className="rounded-lg border border-white/15 px-3 py-1 text-sm text-white">
                {translate(lang, "retry")}
              </button>
            </div>
          ) : null}
          {voiceNote && !micDenied && !listening && !uploading ? <p className="mt-2 text-sm text-[#FFB020]" role="status">{voiceNote}</p> : null}
        </form>
      </div>
      </SpotlightGlassCard>
    </div>
  );
}

function AssistantBubble({
  lang,
  message,
  baseUrl,
  ownerReady,
  onDryRun,
  onOpenGuard,
  onExecute,
  onRetryTranslate,
}: {
  lang: Lang;
  message: ChatMessage;
  baseUrl: string;
  ownerReady: boolean;
  onDryRun?: (intentId: string) => void;
  onOpenGuard?: (intentId: string) => void;
  onExecute?: (intentId: string) => void;
  onRetryTranslate?: (id: string) => void;
}) {
  const body = visibleText(message, lang);
  const pendingTranslation = needsTranslation(message, lang);
  const retry = <TranslationRetry lang={lang} message={message} onRetry={onRetryTranslate} />;
  const attestation = message.attestation;
  if (!attestation) {
    return (
      <div className="mr-8 rounded-2xl border border-[#FF8A00]/30 bg-[#FF8A00]/8 px-3 py-2 text-sm text-white">
        {displayReply(body)}
        {pendingTranslation ? <p className="mt-1 text-xs text-white/50">{translate(lang, "translating")}</p> : null}
        {retry}
      </div>
    );
  }
  const decision = attestation.decision;
  const redaction = attestation.redaction;
  const piiKey: CopyKey = !redaction ? "piiOff" : redaction.redactionsCount > 0 ? "piiMasked" : "piiClear";
  const curl = signatureCurl(baseUrl, attestation.chatId, attestation.model);
  const reportCurl = attestationCurl(baseUrl, attestation.model, attestation.nonce);
  const combined = `${attestation.requestSha256}:${attestation.responseSha256}`;
  const localPreview = isLocalPreview(attestation.verification);
  const serverVerified = !localPreview && attestation.verification.status === "verified";
  const badgeLabel = translate(lang, localPreview ? "localPreview" : serverVerified ? "verifiedBadge" : "unverifiedBadge");
  return (
    <article className="mr-6 min-w-0 max-w-full rounded-2xl border border-white/10 bg-black/25 px-3 py-3">
      <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-[#00EC97]">KOTHA</div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span
          title={localPreview ? translate(lang, "localPreview") : translate(lang, serverVerified ? "teeVerifiedTip" : "teeUnverifiedTip")}
          className={cn(
            "max-w-full whitespace-normal break-words rounded-full border px-2 py-0.5 font-mono text-[10px] leading-snug",
            localPreview
              ? "border-white/20 bg-white/8 text-white/75"
              : serverVerified
                ? "border-[#00EC97]/50 bg-[#00EC97]/15 text-[#b8ffe0]"
                : "border-[#FF8A00]/50 bg-[#FF8A00]/15 text-[#ffd7a1]",
          )}
        >
          {badgeLabel}
        </span>
        <RiskMark lang={lang} score={decision.risk_score} />
        <Badge className={policyTone(decision.policy_status)} title={policyTip(lang, decision.policy_status, decision.policy_reason)}>
          {translate(lang, policyKey(message.statusCode || decision.policy_status))}
        </Badge>
        <span
          className={cn(
            "max-w-full whitespace-normal break-words rounded-full border px-2 py-0.5 font-mono text-[10px] leading-snug",
            redaction && redaction.redactionsCount > 0
              ? "border-[#7B61FF]/40 bg-[#7B61FF]/15 text-[#ddd6fe]"
              : "border-white/10 bg-white/5 text-white/70",
          )}
        >
          {translate(lang, piiKey)}
          {redaction && redaction.redactionsCount > 0
            ? ` · ${redaction.redactionsCount} · ${redaction.piiTypesFound.map((type) => piiTypeLabel(lang, type)).join(", ")}`
            : ""}
        </span>
      </div>
      <p className="text-sm leading-relaxed text-white/90">{displayReply(body)}</p>
      {pendingTranslation ? <p className="mt-1 text-xs text-white/50">{translate(lang, "translating")}</p> : null}
      {retry}
      {showFaucet(message) ? (
        <p className="mt-2 text-sm">
          <a href={TESTNET_FAUCET_URL} target="_blank" rel="noreferrer" className="text-[#7DD3FC] underline-offset-2 hover:underline">
            {translate(lang, "faucetLink")}
          </a>
        </p>
      ) : null}
      <ActionCard
        lang={lang}
        messageId={message.id}
        intent={decision.intent}
        dryRun={message.dryRun}
        dryRunShown={message.dryRunShown === true}
        fallbackText={body}
        status={decision.policy_status}
        ownerReady={ownerReady}
        onDryRun={onDryRun}
        onOpenGuard={onOpenGuard}
        onExecute={onExecute}
      />
      <details className="mt-3 rounded-xl border border-[#00EC97]/20 bg-[#00EC97]/5 px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-[#b8ffe0]">{translate(lang, "showDetails")}</summary>
        <div className="mt-2">
          <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-white/40">
            {translate(lang, "mode")} · {modeLabel(lang, attestation.mode)}
          </div>
          {redaction ? (
            <div className="mb-2">
              <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">{translate(lang, "promptLeft")}</div>
              <p className="mt-1 break-words font-mono text-[11px] text-[#d9ffe8]">{redaction.redactedText}</p>
            </div>
          ) : null}
          <HashRow lang={lang} label={translate(lang, "requestHash")} value={attestation.requestSha256} />
          <HashRow lang={lang} label={translate(lang, "responseHash")} value={attestation.responseSha256} />
          <HashRow lang={lang} label={translate(lang, "combined")} value={combined} />
          <section className="mt-3 rounded-xl border border-white/10 bg-black/30 p-2">
            <h3 className="text-[12px] font-semibold text-white/85">{translate(lang, "verifyYourself")}</h3>
            <HashRow lang={lang} label={translate(lang, "chatId")} value={attestation.chatId || "—"} />
            <HashRow lang={lang} label={translate(lang, "address")} value={attestation.signing_address || "—"} />
            <HashRow lang={lang} label={translate(lang, "signature")} value={attestation.signature || "—"} />
            <CurlBlock lang={lang} label={translate(lang, "signature")} value={curl} />
            <CurlBlock lang={lang} label={translate(lang, "mode")} value={reportCurl} />
          </section>
          <SignatureTamperLab
            signature={attestation.signature}
            serverVerified={serverVerified}
            verifiedLabel={translate(lang, "verifiedBadge")}
            unverifiedLabel={translate(lang, "unverifiedBadge")}
            tamperedLabel={translate(lang, "tamperedBadge")}
            tamperLabel={translate(lang, "tamper")}
            restoreLabel={translate(lang, "restoreSignature")}
            reason={translate(lang, serverVerified ? "teeVerifiedTip" : "teeUnverifiedTip")}
          />
        </div>
      </details>
    </article>
  );
}

function ActionCard({
  lang,
  messageId,
  intent,
  dryRun,
  dryRunShown,
  fallbackText,
  status,
  ownerReady,
  onDryRun,
  onOpenGuard,
  onExecute,
}: {
  lang: Lang;
  messageId: string;
  intent: AegisIntent | null;
  dryRun?: DryRunPreview | null;
  dryRunShown: boolean;
  fallbackText: string;
  status: PolicyStatus;
  ownerReady: boolean;
  onDryRun?: (intentId: string) => void;
  onOpenGuard?: (intentId: string) => void;
  onExecute?: (intentId: string) => void;
}) {
  const reasonId = useId();
  const numeric = Number(intent?.amount);
  const fromIntent = Number.isFinite(numeric) && numeric > 0;
  const fromText = readActionCard(fallbackText);
  if (!fromIntent && !fromText) return null;
  if (status === "BLOCKED") {
    return <p className="mt-3 text-sm text-[#ffb3c0]">{translate(lang, "blockedByPolicy")}</p>;
  }
  const enabled = ownerReady && status === "PASS";
  const tip = enabled ? undefined : !ownerReady ? translate(lang, "connectOwner") : translate(lang, "blockedByPolicy");
  return (
    <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 p-3">
      {intent ? <IntentFacts lang={lang} intent={intent} dryRun={dryRun} /> : null}
      {dryRunShown && dryRun ? (
        <div className="mb-3 rounded-xl border border-white/10 bg-black/30 p-3">
          <DryRunSummary lang={lang} dryRun={dryRun} />
          <button type="button" onClick={() => onOpenGuard?.(messageId)} className="mt-2 text-xs text-[#7DD3FC] underline-offset-2 hover:underline">
            {translate(lang, "openInGuard")}
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => onDryRun?.(messageId)} className="h-9 rounded-xl border border-white/15 px-3 text-sm text-white">
          {translate(lang, "dryRun")}
        </button>
        <span title={tip} className="inline-flex">
          {tip ? (
            <span id={reasonId} className="sr-only">
              {tip}
            </span>
          ) : null}
          <button
            type="button"
            disabled={!enabled}
            aria-disabled={!enabled}
            aria-describedby={tip ? reasonId : undefined}
            title={tip}
            onClick={enabled ? () => onExecute?.(messageId) : undefined}
            className="h-9 rounded-xl bg-[#00EC97] px-3 text-sm font-semibold text-[#04140d] disabled:cursor-not-allowed disabled:bg-[#2a3038] disabled:text-white/45 disabled:opacity-100"
          >
            {translate(lang, "executeButton")}
          </button>
        </span>
      </div>
    </div>
  );
}

function IntentFacts({ lang, intent, dryRun }: { lang: Lang; intent: AegisIntent; dryRun?: DryRunPreview | null }) {
  const origin = previewSymbol(intent.origin_asset, intent.action);
  const destination = previewSymbol(intent.destination_asset, intent.action);
  const native = isNativeNearTransfer(intent);
  return (
    <div className="mb-3 space-y-1 text-sm text-white/90">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase", actionTone(intent.action))}>
          {translate(lang, actionCopyKey(intent.action))}
        </span>
        {native ? <span className="text-xs text-[#d9ffe8]">{translate(lang, "nativeNear")}</span> : null}
      </div>
      <p>
        {translate(lang, "amount")}: {intent.amount} {origin}
        {intent.action === "swap" && dryRun ? ` → ${dryRun.quote.expectedAmountOut} ${destination}` : intent.recipient ? ` → ${intent.recipient}` : ""}
      </p>
      {showSlippageRow(intent) && dryRun ? (
        <p>
          {translate(lang, "slippage")}: {dryRun.quote.slippageBps} bps
        </p>
      ) : null}
      {showWnearLine(intent) ? <p className="text-xs text-white/55">{translate(lang, "nearSettles")}</p> : null}
    </div>
  );
}

function RiskMark({ lang, score }: { lang: Lang; score: number }) {
  const label = translate(lang, "riskScale");
  return (
    <span className="inline-flex items-center gap-1">
      <Badge className={riskTone(score)}>
        {translate(lang, "risk")} {score}
      </Badge>
      <span className="group relative inline-flex">
        <button type="button" className="inline-flex h-4 w-4 items-center justify-center text-white/55" aria-label={label} title={label}>
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <span
          role="tooltip"
          className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-56 rounded-lg border border-white/15 bg-[#0c1411] p-2 text-[11px] leading-snug text-white group-focus-within:block group-hover:block"
        >
          {label}
        </span>
      </span>
    </span>
  );
}

type SpeechEvent = { results?: ArrayLike<ArrayLike<{ transcript?: string }>> };
type SpeechRec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechEvent) => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function speechCtor(): (new () => SpeechRec) | null {
  if (typeof window === "undefined") return null;
  const host = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  return host.SpeechRecognition || host.webkitSpeechRecognition || null;
}

function formatClock(total: number): string {
  const seconds = Math.max(0, Math.min(30, total));
  return `0:${String(seconds).padStart(2, "0")}`;
}

function micFailureKey(error: unknown): CopyKey {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") return "micDenied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "micNone";
  return "micUnsupported";
}

function Badge({ children, className, title }: { children: ReactNode; className: string; title?: string }) {
  return (
    <span title={title} className={cn("max-w-full whitespace-normal break-words rounded-full border px-2 py-0.5 font-mono text-[10px] leading-snug", className)}>
      {children}
    </span>
  );
}

function policyKey(status: string): CopyKey {
  if (status === "WARNING") return "warning";
  if (status === "BLOCKED") return "blocked";
  if (status === "NEEDS_WALLET") return "needsWalletBadge";
  if (status === "INSUFFICIENT_BALANCE") return "insufficientBadge";
  if (status === "QUESTION") return "pass";
  return "pass";
}

function policyTip(lang: Lang, status: PolicyStatus, reason: string): string {
  if (reason === "NEEDS_WALLET" || status === "NEEDS_WALLET") return translate(lang, "needsWallet");
  if (reason === "INSUFFICIENT_BALANCE" || status === "INSUFFICIENT_BALANCE") return translate(lang, "insufficientBadge");
  if (reason === "BALANCE_UNAVAILABLE") return translate(lang, "balanceUnavailable");
  if (reason === "INVALID_RECIPIENT_FORMAT") return translate(lang, "invalidRecipient");
  if (reason === "QUESTION" || status === "PASS") return translate(lang, "pass");
  if (status === "WARNING") return translate(lang, "warning");
  return translate(lang, "blockedByPolicy");
}

function visibleText(message: ChatMessage, lang: Lang): string {
  if (message.errorCode === "free_limit") return translate(lang, "freeLimit");
  if (message.errorCode === "wallet_limit") return translate(lang, "walletLimit");
  if (message.errorCode === "voice_too_long") return translate(lang, "voiceTooLong");
  if (message.errorCode === "load_fail") return translate(lang, "loadFail");
  if (message.errorCode === "request_timeout") return translate(lang, "requestTimeout");
  const decision = message.attestation?.decision;
  if (decision && /prompt injection/i.test(decision.policy_reason)) return translate(lang, "injectionBlocked");
  if (decision?.policy_reason === "INVALID_NEAR_ACCOUNT") return translate(lang, "invalidNearAccount");
  if (decision?.intent?.action === "swap") {
    return swapReply(lang, decision.intent, message.dryRun, message.statusCode || decision.policy_status);
  }
  if (usesFixedPreviewCopy(message)) {
    const status = message.statusCode || message.attestation?.decision.policy_status;
    if (status === "NEEDS_WALLET") return translate(lang, "needsWallet");
    if (status === "INSUFFICIENT_BALANCE") return translate(lang, "insufficientBadge");
  }
  if (lang === "bn" || lang === "en") return visibleMessageText(message.text, message.translations?.[lang]);
  return message.text;
}

function swapReply(lang: Lang, intent: AegisIntent, dryRun: DryRunPreview | null | undefined, status: string): string {
  if (status === "NEEDS_WALLET") return translate(lang, "needsWallet");
  if (status === "INSUFFICIENT_BALANCE") return translate(lang, "insufficientBadge");
  if (status === "BLOCKED" || !dryRun) return translate(lang, "swapBlocked");
  return fillCopy(lang, "swapPreview", {
    amount: intent.amount,
    origin: previewSymbol(intent.origin_asset, "swap"),
    destination: previewSymbol(intent.destination_asset, "swap"),
    out: dryRun.quote.expectedAmountOut,
    slippage: dryRun.quote.slippageBps,
  });
}

function piiTypeLabel(lang: Lang, type: string): string {
  if (type === "phone") return translate(lang, "piiPhone");
  if (type === "email") return translate(lang, "piiEmail");
  if (type === "seed") return translate(lang, "piiSeed");
  if (type === "id") return translate(lang, "piiId");
  if (type === "card") return translate(lang, "piiCard");
  if (type === "api_key") return translate(lang, "piiApiKey");
  return type;
}

function userBubbleText(message: ChatMessage, lang: Lang): string {
  if (isChipKey(message.chipKey)) return translate(lang, message.chipKey);
  if (lang === "bn" || lang === "en") return visibleMessageText(message.text, message.translations?.[lang]);
  return message.text;
}

function showFaucet(message: ChatMessage): boolean {
  if (process.env.NEXT_PUBLIC_NETWORK === "mainnet") return false;
  return message.statusCode === "INSUFFICIENT_BALANCE" || message.attestation?.decision.policy_status === "INSUFFICIENT_BALANCE";
}

function TranslationRetry({ lang, message, onRetry }: { lang: Lang; message: ChatMessage; onRetry?: (id: string) => void }) {
  if (!message.translationFailed || message.role !== "assistant") return null;
  if (lang !== "bn" && lang !== "en") return null;
  if (message.lang === lang || message.translations?.[lang]) return null;
  return (
    <button type="button" onClick={() => onRetry?.(message.id)} className="mt-1 block text-xs text-[#7DD3FC] underline-offset-2 hover:underline">
      {translate(lang, "translateFailed")}
    </button>
  );
}

function needsTranslation(message: ChatMessage, lang: Lang): boolean {
  if (message.role !== "assistant" || message.errorCode) return false;
  if (lang !== "bn" && lang !== "en") return false;
  if (message.lang === lang) return false;
  return Boolean(message.translating) && !message.translations?.[lang];
}

function policyTone(status: PolicyStatus): string {
  if (status === "BLOCKED") return "border-[#FF3B5C]/50 bg-[#FF3B5C]/15 text-[#ffb3c0]";
  if (status === "WARNING" || status === "NEEDS_WALLET" || status === "INSUFFICIENT_BALANCE") {
    return "border-[#FF8A00]/50 bg-[#FF8A00]/15 text-[#ffd7a1]";
  }
  return "border-[#00EC97]/40 bg-[#00EC97]/12 text-[#b8ffe0]";
}

function riskTone(score: number): string {
  if (score >= 90) return "border-[#FF3B5C]/50 bg-[#FF3B5C]/15 text-[#ffb3c0]";
  if (score >= 58) return "border-[#FF8A00]/50 bg-[#FF8A00]/15 text-[#ffd7a1]";
  return "border-[#00D2FF]/40 bg-[#00D2FF]/10 text-[#c9f6ff]";
}

function CurlBlock({ lang, label, value }: { lang: Lang; label: string; value: string }) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-[0.16em] text-white/40">{label}</span>
        <CopyButton value={value} lang={lang} label={translate(lang, "curl")} />
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-black/40 p-2 font-mono text-[10px] text-white/75">{value}</pre>
    </div>
  );
}

const STEP_KEYS = ["stepRedact", "stepThink", "stepVerify", "stepPolicy"] as const;

function StepLoader({ lang, step }: { lang: Lang; step: LoaderStep | null }) {
  const target = step ? Math.max(0, LOADER_STEPS.indexOf(step)) : 0;
  const [shown, setShown] = useState(target);
  useEffect(() => {
    setShown(target);
  }, [target]);
  return (
    <p className="flex flex-wrap items-center gap-x-1 gap-y-1 font-mono text-[11px] leading-snug" aria-live="polite">
      {STEP_KEYS.map((key, index) => (
        <span key={key} className={index <= shown ? "text-[#00EC97]" : "text-white/35"}>
          {index > 0 ? <span className="text-white/30"> → </span> : null}
          {translate(lang, key)}
        </span>
      ))}
    </p>
  );
}

function modeLabel(lang: Lang, mode: AttestedInference["mode"]): string {
  if (mode === "hardware-tee") return translate(lang, "modeHardware");
  return translate(lang, "modeUnverified");
}

function voiceErrorParts(data: unknown): { code: string; message: string } {
  if (!data || typeof data !== "object") return { code: "", message: "" };
  const record = data as { error?: unknown; message?: unknown };
  if (typeof record.error === "string") return { code: "", message: record.error };
  if (record.error && typeof record.error === "object") {
    const err = record.error as { code?: unknown; message?: unknown };
    return {
      code: typeof err.code === "string" ? err.code : "",
      message: typeof err.message === "string" ? err.message : "",
    };
  }
  if (typeof record.message === "string") return { code: "", message: record.message };
  return { code: "", message: "" };
}

function cappedVoiceNote(code: string, status: number): CopyKey | null {
  if (code === "free_limit") return "freeLimit";
  if (code === "wallet_limit") return "walletLimit";
  if (code === "voice_too_long") return "voiceTooLong";
  if (status === 429) return "freeLimit";
  return null;
}
