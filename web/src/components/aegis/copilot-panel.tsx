"use client";

import { CopyButton, HashRow } from "@/components/aegis/bits";
import { translate, type CopyKey, type Lang } from "@/components/aegis/copy";
import { attestationCurl, signatureCurl } from "@/components/aegis/format";
import { displayReply, LOADER_STEPS, readActionCard, type LoaderStep } from "@/lib/chat-stream";
import { cn } from "@/lib/utils";
import { EnclaveSwitch, SignatureTamperLab, SpotlightGlassCard, VoiceWaveform } from "@/components/ui/aegis-primitives";
import type { AttestedInference, ChatModelId, DryRunPreview, PolicyStatus } from "@/lib/dashboard-types";
import { Mic, MicOff, Send, Shield } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

const CHIPS = ["chipSwap", "chipRemit", "chipShield", "chipSecurity"] as const;

const SPEECH_LANG: Record<Lang, string> = {
  en: "en-US",
  bn: "bn-BD",
  es: "es-ES",
  ar: "ar-SA",
  hi: "hi-IN",
  fr: "fr-FR",
  zh: "zh-CN",
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  attestation?: AttestedInference;
  dryRun?: DryRunPreview | null;
};

type SpeechAlternative = { transcript: string };
type SpeechResult = ArrayLike<SpeechAlternative> & { isFinal?: boolean };

type SpeechSession = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<SpeechResult> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
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
  onAutoRedact,
  onSend,
  onDryRun,
  onOpenGuard,
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
  teePhase?: "idle" | "unverified" | "verified";
  onAutoRedact: (next: boolean) => void;
  onSend: (text: string) => void;
  onDryRun?: () => void;
  onOpenGuard?: () => void;
}) {
  const [input, setInput] = useState("");
  const [listening, setListening] = useState(false);
  const [demoWave, setDemoWave] = useState(false);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const session = useRef<SpeechSession | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const recordChunks = useRef<Blob[]>([]);
  const discardRecording = useRef(false);
  const speechText = useRef("");
  const hintRef = useRef("");
  const settled = useRef(false);
  const captureGen = useRef(0);
  const langRef = useRef(lang);
  langRef.current = lang;
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
      session.current?.stop();
      if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
      if (demoTimer.current != null) window.clearTimeout(demoTimer.current);
    };
  }, []);

  function submit(text: string) {
    const message = text.trim();
    if (!message || thinkingRef.current) return;
    setInput("");
    onSendRef.current(message);
  }

  function capturedSpeech(): string {
    return (speechText.current || hintRef.current).trim();
  }

  async function finishCapture(blob: Blob | null) {
    if (settled.current || discardRecording.current) return;
    const text = capturedSpeech();
    if (text) {
      settled.current = true;
      setListening(false);
      setInput(text);
      setVoiceNote(null);
      submit(text);
      return;
    }
    if (blob && blob.size > 0) {
      settled.current = true;
      setListening(false);
      await uploadVoice(blob, hintRef.current);
      return;
    }
    if (recorder.current && recorder.current.state !== "inactive") return;
    settled.current = true;
    setListening(false);
    setVoiceNote(translate(langRef.current, "voiceUnavailable"));
  }

  function stopCapture() {
    captureGen.current += 1;
    try {
      session.current?.stop();
    } catch {
      // Recognition may already be stopped.
    }
    const rec = recorder.current;
    if (rec && rec.state !== "inactive") {
      rec.stop();
      return;
    }
    void finishCapture(null);
  }

  async function toggleMic() {
    if (uploading) return;
    if (listening) {
      stopCapture();
      return;
    }
    const gen = ++captureGen.current;
    settled.current = false;
    speechText.current = "";
    hintRef.current = "";
    recordChunks.current = [];
    setVoiceNote(translate(lang, "tapStopSend"));
    setListening(true);
    const ctor = speechCtor();
    if (ctor) {
      const recognition = new ctor();
      recognition.lang = SPEECH_LANG[lang];
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event) => {
        let finalText = "";
        let interim = "";
        for (let index = 0; index < event.results.length; index += 1) {
          const result = event.results[index];
          const piece = result?.[0]?.transcript ?? "";
          if (result?.isFinal) finalText += piece;
          else interim += piece;
        }
        const live = `${finalText}${interim}`.trim();
        if (finalText.trim()) speechText.current = finalText.trim();
        hintRef.current = live;
        if (live) setInput(live);
      };
      recognition.onerror = () => {
        // Mobile Chromium can error without a transcript. The recorder still uploads.
      };
      recognition.onend = () => {
        if (settled.current || captureGen.current !== gen) return;
        if (!capturedSpeech()) return;
        const rec = recorder.current;
        if (rec && rec.state !== "inactive") {
          rec.stop();
          return;
        }
        void finishCapture(null);
      };
      session.current = recognition;
      try {
        recognition.start();
      } catch {
        session.current = null;
      }
    }
    let recorderStarted = false;
    try {
      if (typeof MediaRecorder !== "undefined" && navigator.mediaDevices?.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (captureGen.current !== gen || settled.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((item) => MediaRecorder.isTypeSupported(item)) || "";
        const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        recordChunks.current = [];
        rec.ondataavailable = (event) => {
          if (event.data.size > 0) recordChunks.current.push(event.data);
        };
        rec.onstop = () => {
          stream.getTracks().forEach((track) => track.stop());
          if (discardRecording.current) return;
          const blob = new Blob(recordChunks.current, { type: rec.mimeType || "audio/webm" });
          void finishCapture(blob);
        };
        recorder.current = rec;
        rec.start();
        recorderStarted = true;
      }
    } catch {
      recorderStarted = false;
    }
    if (!recorderStarted && !session.current) {
      settled.current = true;
      setListening(false);
      setVoiceNote(translate(langRef.current, "micMissing"));
    }
  }

  async function uploadVoice(blob: Blob, hint: string) {
    setUploading(true);
    setVoiceNote(translate(langRef.current, "transcribing"));
    try {
      const form = new FormData();
      form.set("audio", blob, "speech.webm");
      form.set("language", langRef.current);
      form.set("hint", hint);
      const response = await fetch("/api/voice-transcribe", { method: "POST", body: form });
      const data = (await response.json().catch(() => null)) as { text?: string; fallback?: boolean; message?: string; error?: { message?: string } } | null;
      const text = typeof data?.text === "string" ? data.text.trim() : "";
      if (text) {
        setInput(text);
        setVoiceNote(data?.fallback ? translate(langRef.current, "voiceFallback") : null);
        submit(text);
        return;
      }
      setVoiceNote(data?.message || data?.error?.message || translate(langRef.current, "voiceUnavailable"));
    } catch (error) {
      setVoiceNote(error instanceof Error ? error.message : translate(langRef.current, "voiceUnavailable"));
    } finally {
      setUploading(false);
    }
  }

  function playVoiceDemo() {
    if (demoTimer.current != null) window.clearTimeout(demoTimer.current);
    setDemoWave(true);
    demoTimer.current = window.setTimeout(() => {
      setDemoWave(false);
      demoTimer.current = null;
    }, 10_000);
    submit(translate(lang, "chipSwap"));
  }

  const teeLabel =
    teePhase === "verified" ? translate(lang, "verifiedBadge") : teePhase === "unverified" ? translate(lang, "unverifiedBadge") : translate(lang, "teeReady");
  const teeClass =
    teePhase === "verified" ? "border-[#00EC97]/50 bg-[#00EC97]/15 text-[#b8ffe0]" : "border-[#FF8A00]/50 bg-[#FF8A00]/15 text-[#ffd7a1]";

  return (
    <div className="flex min-h-[calc(100dvh-11rem)] flex-col gap-2">
      <div className="flex justify-end">
        <span title={teeLabel} className={cn("max-w-full rounded-full border px-3 py-1 text-sm", teeClass)}>
          {teeLabel}
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {CHIPS.map((key) => (
          <button
            key={key}
            type="button"
            disabled={thinking}
            onClick={() => submit(translate(lang, key))}
            className="shrink-0 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-left text-sm text-white hover:border-[#00EC97]/40 disabled:opacity-50"
          >
            {translate(lang, key)}
          </button>
        ))}
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
          {messages.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="ml-8 rounded-2xl rounded-br-md border border-[#00D2FF]/25 bg-[#00D2FF]/8 px-3 py-2 text-sm text-white">
                <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-[#00D2FF]">{translate(lang, "you")}</div>
                {message.text}
              </div>
            ) : (
              <AssistantBubble key={message.id} lang={lang} message={message} baseUrl={baseUrl} onDryRun={onDryRun} onOpenGuard={onOpenGuard} />
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
          {listening ? <p className="mt-2 text-sm text-[#00EC97]">{translate(lang, "tapStopSend")}</p> : null}
          {voiceNote && !listening ? <p className="mt-2 text-sm text-[#FFB020]" role="status">{voiceNote}</p> : null}
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
  onDryRun,
  onOpenGuard,
}: {
  lang: Lang;
  message: ChatMessage;
  baseUrl: string;
  onDryRun?: () => void;
  onOpenGuard?: () => void;
}) {
  const attestation = message.attestation;
  if (!attestation) {
    return <div className="mr-8 rounded-2xl border border-[#FF8A00]/30 bg-[#FF8A00]/8 px-3 py-2 text-sm text-white">{displayReply(message.text)}</div>;
  }
  const decision = attestation.decision;
  const redaction = attestation.redaction;
  const piiKey: CopyKey = !redaction ? "piiOff" : redaction.redactionsCount > 0 ? "piiMasked" : "piiClear";
  const curl = signatureCurl(baseUrl, attestation.chatId, attestation.model);
  const reportCurl = attestationCurl(baseUrl, attestation.model, attestation.nonce);
  const combined = `${attestation.requestSha256}:${attestation.responseSha256}`;
  const serverVerified = attestation.verification.status === "verified";
  const badgeLabel = translate(lang, serverVerified ? "verifiedBadge" : "unverifiedBadge");
  return (
    <article className="mr-6 min-w-0 max-w-full rounded-2xl border border-white/10 bg-black/25 px-3 py-3">
      <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-[#00EC97]">KOTHA</div>
      <div className="mb-2 flex flex-wrap gap-2">
        <span
          title={attestation.verification.reason}
          className={cn(
            "max-w-full whitespace-normal break-words rounded-full border px-2 py-0.5 font-mono text-[10px] leading-snug",
            serverVerified
              ? "border-[#00EC97]/50 bg-[#00EC97]/15 text-[#b8ffe0]"
              : "border-[#FF8A00]/50 bg-[#FF8A00]/15 text-[#ffd7a1]",
          )}
        >
          {badgeLabel}
        </span>
        <Badge className={riskTone(decision.risk_score)}>
          {translate(lang, "risk")} {decision.risk_score}
        </Badge>
        <Badge className={policyTone(decision.policy_status)} title={decision.policy_reason}>
          {translate(lang, policyKey(decision.policy_status))}
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
            ? ` · ${redaction.redactionsCount} · ${redaction.piiTypesFound.join(", ")}`
            : ""}
        </span>
      </div>
      <p className="text-sm leading-relaxed text-white/90">{displayReply(decision.explanation)}</p>
      <ActionCard lang={lang} intentAmount={decision.intent?.amount} fallbackText={decision.explanation} onDryRun={onDryRun} onOpenGuard={onOpenGuard} />
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
            <CurlBlock lang={lang} label="signature" value={curl} />
            <CurlBlock lang={lang} label="attestation" value={reportCurl} />
          </section>
          <SignatureTamperLab
            signature={attestation.signature}
            serverVerified={serverVerified}
            verifiedLabel={translate(lang, "verifiedBadge")}
            unverifiedLabel={translate(lang, "unverifiedBadge")}
            tamperedLabel={translate(lang, "tamperedBadge")}
            tamperLabel={translate(lang, "tamper")}
            restoreLabel={translate(lang, "restoreSignature")}
            reason={attestation.verification.reason}
          />
        </div>
      </details>
    </article>
  );
}

function ActionCard({
  lang,
  intentAmount,
  fallbackText,
  onDryRun,
  onOpenGuard,
}: {
  lang: Lang;
  intentAmount?: string;
  fallbackText: string;
  onDryRun?: () => void;
  onOpenGuard?: () => void;
}) {
  const numeric = Number(intentAmount);
  const fromIntent = Number.isFinite(numeric) && numeric > 0;
  const fromText = readActionCard(fallbackText);
  if (!fromIntent && !fromText) return null;
  return (
    <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 p-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onDryRun} className="h-9 rounded-xl border border-white/15 px-3 text-sm text-white">
          {translate(lang, "dryRun")}
        </button>
        <button type="button" onClick={onOpenGuard} className="h-9 rounded-xl bg-[#00EC97] px-3 text-sm font-semibold text-[#04140d]">
          {translate(lang, "goToGuard")}
        </button>
      </div>
    </div>
  );
}

function Badge({ children, className, title }: { children: ReactNode; className: string; title?: string }) {
  return (
    <span title={title} className={cn("max-w-full whitespace-normal break-words rounded-full border px-2 py-0.5 font-mono text-[10px] leading-snug", className)}>
      {children}
    </span>
  );
}

function policyKey(status: PolicyStatus): CopyKey {
  if (status === "WARNING") return "warning";
  if (status === "BLOCKED") return "blocked";
  return "pass";
}

function policyTone(status: PolicyStatus): string {
  if (status === "BLOCKED") return "border-[#FF3B5C]/50 bg-[#FF3B5C]/15 text-[#ffb3c0]";
  if (status === "WARNING") return "border-[#FF8A00]/50 bg-[#FF8A00]/15 text-[#ffd7a1]";
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
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (shown >= target) return;
    const timer = window.setTimeout(() => setShown((current) => Math.min(target, current + 1)), 280);
    return () => window.clearTimeout(timer);
  }, [shown, target]);
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

function speechCtor(): (new () => SpeechSession) | null {
  if (typeof window === "undefined") return null;
  const host = window as Window & {
    SpeechRecognition?: new () => SpeechSession;
    webkitSpeechRecognition?: new () => SpeechSession;
  };
  return host.SpeechRecognition ?? host.webkitSpeechRecognition ?? null;
}
