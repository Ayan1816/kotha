"use client";

import { translate, type Lang } from "@/components/aegis/copy";
import { WalletButton } from "@/components/WalletButton";

export type TeePhase = "idle" | "unverified" | "verified";

export function TelemetryBar({
  lang,
  onLang,
  showTestnet,
}: {
  lang: Lang;
  onLang: (lang: Lang) => void;
  showTestnet: boolean;
}) {
  return (
    <header className="fixed inset-x-0 top-0 z-50 flex h-16 w-full items-center justify-between border-b border-white/10 bg-[#05070b] px-6">
      <div className="flex min-w-0 items-center gap-2">
        <Crest />
        <span className="truncate text-base font-semibold text-white">{translate(lang, "brandMark")}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {showTestnet ? (
          <span className="hidden rounded-full border border-amber-400/50 bg-amber-400/15 px-3 py-1 text-sm text-amber-200 md:inline-flex">
            {translate(lang, "testnetBadge")}
          </span>
        ) : null}
        <button
          type="button"
          aria-label={translate(lang, "langHint")}
          onClick={() => onLang(lang === "bn" ? "en" : "bn")}
          className="hidden h-9 items-center rounded-full border border-white/15 px-3 text-sm md:inline-flex"
        >
          <span className={lang === "bn" ? "text-[#00EC97]" : "text-white/50"}>বাংলা</span>
          <span className="px-1 text-white/30">/</span>
          <span className={lang === "en" ? "text-[#00EC97]" : "text-white/50"}>EN</span>
        </button>
        <WalletButton lang={lang} onLang={onLang} showTestnet={showTestnet} />
      </div>
    </header>
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
