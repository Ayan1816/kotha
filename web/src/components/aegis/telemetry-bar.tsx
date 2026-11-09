"use client";

import { translate, type CopyKey, type Lang } from "@/components/aegis/copy";
import { WalletButton } from "@/components/WalletButton";
import { useKothaSession, type KothaNetwork } from "@/app/providers";
import { useEffect, useRef, useState } from "react";

export type TeePhase = "idle" | "unverified" | "verified";

const LANGS: Array<{ id: Lang; key: CopyKey }> = [
  { id: "en", key: "langEnglish" },
  { id: "bn", key: "langBengali" },
  { id: "es", key: "langSpanish" },
  { id: "ar", key: "langArabic" },
  { id: "hi", key: "langHindi" },
  { id: "fr", key: "langFrench" },
  { id: "zh", key: "langChinese" },
];

export function TelemetryBar({ lang, onLang }: { lang: Lang; onLang: (lang: Lang) => void }) {
  const { network, setNetwork } = useKothaSession();
  const brand = lang === "bn" ? translate(lang, "brandMark") : translate(lang, "brand");
  return (
    <header className="fixed inset-x-0 top-0 z-50 flex h-16 w-full flex-nowrap items-center justify-between gap-2 overflow-hidden border-b border-white/10 bg-[#05070b] px-3 sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <Crest />
        <span className="truncate text-sm font-semibold text-white sm:text-base" title={brand}>
          {brand}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <NetworkToggle lang={lang} network={network} onNetwork={setNetwork} />
        <LanguageMenu lang={lang} onLang={onLang} />
        <WalletButton lang={lang} />
      </div>
    </header>
  );
}

function NetworkToggle({
  lang,
  network,
  onNetwork,
}: {
  lang: Lang;
  network: KothaNetwork;
  onNetwork: (network: KothaNetwork) => void;
}) {
  return (
    <div className="inline-flex h-9 items-center rounded-full border border-white/15 p-0.5" role="group" aria-label={translate(lang, "networkHint")}>
      {(["mainnet", "testnet"] as const).map((id) => {
        const selected = network === id;
        const label = translate(lang, id === "mainnet" ? "networkMainnet" : "networkTestnet");
        return (
          <button
            key={id}
            type="button"
            aria-pressed={selected}
            onClick={() => onNetwork(id)}
            className={`h-8 rounded-full px-2 text-[11px] font-semibold tracking-wide uppercase sm:px-3 sm:text-xs ${selected ? "bg-[#00EC97] text-[#04140d]" : "text-white/70"}`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function LanguageMenu({ lang, onLang }: { lang: Lang; onLang: (lang: Lang) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);
  return (
    <div className="relative" ref={root}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={translate(lang, "languageLabel")}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-9 items-center gap-1 whitespace-nowrap rounded-full border border-white/15 px-2 text-xs sm:px-3 sm:text-sm"
      >
        <span aria-hidden="true">🌐</span>
        <span>{translate(lang, "languageLabel")}</span>
      </button>
      {open ? (
        <div role="listbox" className="absolute right-0 z-50 mt-2 w-44 rounded-2xl border border-white/10 bg-[#07110d] p-1 text-sm shadow-[0_16px_40px_rgba(0,0,0,0.45)]">
          {LANGS.map((item) => {
            const selected = lang === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onLang(item.id);
                  setOpen(false);
                }}
                className={`block w-full rounded-xl px-3 py-2 text-left ${selected ? "bg-[#00EC97]/15 text-[#b8ffe0]" : "text-white hover:bg-white/5"}`}
              >
                {translate(lang, item.key)}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function Crest() {
  return (
    <svg viewBox="0 0 64 64" className="h-8 w-8 shrink-0" aria-hidden="true">
      <path d="M32 4 56 14v18c0 14.5-9.8 24.6-24 28C17.8 56.6 8 46.5 8 32V14L32 4Z" fill="none" stroke="#00EC97" strokeWidth="2.4" />
      <path d="M32 16 44 22v8c0 7-4.6 12-12 14-7.4-2-12-7-12-14v-8l12-6Z" fill="#00EC97" opacity="0.85" />
    </svg>
  );
}
