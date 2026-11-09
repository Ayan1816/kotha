"use client";

import { readNearAiSessionKey, saveNearAiSessionKey } from "@/components/aegis/api";
import { translate, type Lang } from "@/components/aegis/copy";
import { useEffect, useState } from "react";

export function ApiKeyCard({ lang }: { lang: Lang }) {
  const [value, setValue] = useState("");
  const [usingSession, setUsingSession] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const stored = readNearAiSessionKey();
    setUsingSession(Boolean(stored));
    setValue(stored);
  }, []);

  return (
    <section className="rounded-2xl border border-white/10 bg-[#07110d] p-4 shadow-[0_16px_40px_rgba(0,0,0,0.35)]">
      <h2 className="text-xl font-semibold text-white">{translate(lang, "apiKeyTitle")}</h2>
      <p className="mt-2 text-sm leading-6 text-white/70">{usingSession ? translate(lang, "apiKeySession") : translate(lang, "apiKeyServer")}</p>
      <label className="mt-4 block">
        <span className="text-xs text-white/55">{translate(lang, "nearAiKeyLabel")}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={translate(lang, "apiKeyPlaceholder")}
          onChange={(event) => setValue(event.target.value)}
          className="mt-1 h-11 w-full rounded-xl border border-white/10 bg-black/30 px-3 text-sm text-white outline-none placeholder:text-white/30 focus:border-[#00EC97]/50"
        />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            const saved = saveNearAiSessionKey(value);
            if (!saved) {
              setNote(translate(lang, "apiKeyTooLong"));
              return;
            }
            const active = Boolean(value.trim());
            setUsingSession(active);
            setNote(active ? translate(lang, "apiKeySession") : translate(lang, "apiKeyServer"));
          }}
          className="h-10 rounded-xl bg-[#00EC97] px-4 text-sm font-semibold text-[#04140d]"
        >
          {translate(lang, "apiKeySave")}
        </button>
        <button
          type="button"
          onClick={() => {
            saveNearAiSessionKey("");
            setValue("");
            setUsingSession(false);
            setNote(translate(lang, "apiKeyServer"));
          }}
          className="h-10 rounded-xl border border-white/15 px-4 text-sm text-white"
        >
          {translate(lang, "apiKeyClear")}
        </button>
      </div>
      {note ? <p className="mt-3 text-sm text-white/70">{note}</p> : null}
    </section>
  );
}
