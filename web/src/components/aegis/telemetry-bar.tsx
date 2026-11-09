"use client";

import { translate, type Lang } from "@/components/aegis/copy";
import { WalletButton } from "@/components/WalletButton";
import { allowsMainnet, useKothaSession, type KothaNetwork } from "@/app/providers";

export type TeePhase = "idle" | "unverified" | "verified";

export function TelemetryBar({ lang, onLang, admin = false }: { lang: Lang; onLang: (lang: Lang) => void; admin?: boolean }) {
  const { network, setNetwork } = useKothaSession();
  const brand = lang === "bn" ? translate(lang, "brandMark") : translate(lang, "brand");
  return (
    <header className="fixed inset-x-0 top-0 z-50 flex h-16 w-full flex-nowrap items-center justify-between gap-2 border-b border-white/10 bg-[#05070b] px-3 sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <Crest />
        <span className="truncate text-sm font-semibold text-white sm:text-base" title={brand}>
          {brand}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <NetworkToggle lang={lang} network={network} onNetwork={setNetwork} />
        <LanguageToggle lang={lang} onLang={onLang} />
        {admin ? (
          <span className="inline-flex h-9 max-w-[9.5rem] items-center truncate rounded-full border border-[#00EC97]/40 bg-[#00EC97]/10 px-2 text-[11px] font-semibold text-[#00EC97] sm:max-w-none sm:px-3 sm:text-xs">
            {translate(lang, "adminBadge")}
          </span>
        ) : null}
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
  if (!allowsMainnet() || network !== "mainnet") {
    return (
      <span className="inline-flex h-9 items-center rounded-full border border-[#FFB020]/70 bg-[#FFB020]/15 px-2 text-[11px] font-semibold tracking-wide text-[#FFB020] uppercase sm:px-3 sm:text-xs">
        {translate(lang, "testnetBadge")}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-pressed
      title={translate(lang, "networkHint")}
      onClick={() => onNetwork("testnet")}
      className="inline-flex h-9 items-center rounded-full border border-[#00EC97]/40 bg-[#00EC97]/10 px-2 text-[11px] font-semibold tracking-wide text-[#d9ffe8] uppercase sm:px-3 sm:text-xs"
    >
      {translate(lang, "networkMainnet")}
    </button>
  );
}

function LanguageToggle({ lang, onLang }: { lang: Lang; onLang: (lang: Lang) => void }) {
  return (
    <div className="inline-flex h-9 items-center whitespace-nowrap rounded-full border border-white/15 px-1 text-xs font-semibold sm:text-sm" title={translate(lang, "languageLabel")}>
      <button
        type="button"
        aria-pressed={lang === "bn"}
        onClick={() => onLang("bn")}
        className={`rounded-full px-2 py-1 ${lang === "bn" ? "text-[#00EC97]" : "text-white/45"}`}
      >
        {translate(lang, "switchBn")}
      </button>
      <span className="px-0.5 text-white/30">|</span>
      <button
        type="button"
        aria-pressed={lang === "en"}
        onClick={() => onLang("en")}
        className={`rounded-full px-2 py-1 ${lang === "en" ? "text-[#00EC97]" : "text-white/45"}`}
      >
        EN
      </button>
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
