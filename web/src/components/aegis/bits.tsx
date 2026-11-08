"use client";

import { translate, type CopyKey, type Lang } from "@/components/aegis/copy";
import { shortHash } from "@/components/aegis/format";
import { cn } from "@/lib/utils";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "true");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({
  value,
  lang,
  label,
  className,
}: {
  value: string;
  lang: Lang;
  label?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={value}
      onClick={() => {
        void copyText(value).then((ok) => {
          if (!ok) return;
          setDone(true);
          window.setTimeout(() => setDone(false), 1400);
        });
      }}
      className={cn(
        "inline-flex max-w-full items-center gap-1 whitespace-normal break-words rounded-xl border border-white/10 bg-white/5 px-2 py-1 text-left text-sm leading-snug text-white/75 hover:border-[#00EC97]/40 hover:text-[#00EC97]",
        className,
      )}
    >
      {done ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {done ? translate(lang, "copied") : label || translate(lang, "copy")}
    </button>
  );
}

export function HashRow({
  label,
  value,
  lang,
}: {
  label: string;
  value: string;
  lang: Lang;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1 border-t border-white/8 py-2">
      <span className="w-full min-w-0 text-sm text-white/60 min-[376px]:w-40 min-[376px]:shrink-0">{label}</span>
      <code className="min-w-0 flex-1 break-all text-sm text-[#d9ffe8] min-[376px]:truncate" title={value}>
        {shortHash(value, 10, 8)}
      </code>
      <CopyButton className="shrink-0" value={value} lang={lang} />
    </div>
  );
}

export function FieldLabel({ k, lang }: { k: CopyKey; lang: Lang }) {
  return <span className="text-sm text-white/60">{translate(lang, k)}</span>;
}
