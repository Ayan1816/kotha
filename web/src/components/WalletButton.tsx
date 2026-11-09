"use client";

import { CopyButton } from "@/components/aegis/bits";
import { translate, type Lang } from "@/components/aegis/copy";
import { yoctoToNear } from "near-api-js";
import { useNearWallet } from "near-connect-hooks";
import { useEffect, useRef, useState } from "react";

const BOX = "h-9 px-3 text-sm";

function armWalletDismiss(): () => void {
  let stopped = false;
  const rejectOpen = () => {
    document.querySelectorAll(".hot-connector-popup .modal-container").forEach((node) => {
      if (node instanceof HTMLElement) node.click();
    });
  };
  const paint = () => {
    document.querySelectorAll(".hot-connector-popup").forEach((root) => {
      if (!(root instanceof HTMLElement) || root.querySelector("[data-kotha-cancel]")) return;
      const header = root.querySelector(".modal-header") || root.querySelector(".modal-content");
      if (!header) return;
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.kothaCancel = "1";
      button.textContent = "✕ Cancel";
      button.setAttribute("aria-label", "Cancel");
      button.style.cssText =
        "margin-left:auto;background:#141414;color:#fff;border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:6px 12px;cursor:pointer;font:600 13px/1 sans-serif;";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        rejectOpen();
      });
      header.appendChild(button);
    });
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    rejectOpen();
  };
  document.addEventListener("keydown", onKey);
  const observer = new MutationObserver(paint);
  observer.observe(document.body, { childList: true, subtree: true });
  const timer = window.setInterval(paint, 200);
  paint();
  return () => {
    if (stopped) return;
    stopped = true;
    document.removeEventListener("keydown", onKey);
    observer.disconnect();
    window.clearInterval(timer);
  };
}

function shortAccount(id: string): string {
  if (id.length <= 16) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function formatNear(yocto: bigint): string {
  return `${yoctoToNear(yocto, 4)} NEAR`;
}

export function WalletButton({ lang }: { lang: Lang }) {
  const { loading, signedAccountId, signIn, signOut, getBalance, network } = useNearWallet();
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const balanceReader = useRef(getBalance);
  balanceReader.current = getBalance;

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  useEffect(() => {
    if (!open || !signedAccountId) return;
    let live = true;
    setBalance(null);
    void balanceReader
      .current(signedAccountId)
      .then((value) => {
        if (live) setBalance(formatNear(value));
      })
      .catch(() => {
        if (live) setBalance("—");
      });
    return () => {
      live = false;
    };
  }, [open, signedAccountId]);

  if (loading) {
    return <div className="h-9 w-28 animate-pulse rounded-full bg-white/10" aria-hidden="true" />;
  }

  if (!signedAccountId) {
    return (
      <button
        type="button"
        title={error || undefined}
        onClick={() => {
          setError(null);
          const stop = armWalletDismiss();
          void signIn()
            .catch((connectError: unknown) => {
              const message = connectError instanceof Error ? connectError.message : "";
              if (/reject|cancel|closed/i.test(message)) return;
              setError(message || translate(lang, "walletConnectFailed"));
            })
            .finally(stop);
        }}
        className={`${BOX} whitespace-nowrap rounded-full bg-[#00EC97] font-semibold text-[#04140d]`}
      >
        {translate(lang, "connectWallet")}
      </button>
    );
  }

  const explorer =
    network === "mainnet"
      ? `https://nearblocks.io/address/${signedAccountId}`
      : `https://testnet.nearblocks.io/address/${signedAccountId}`;

  return (
    <div className="relative" ref={root}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => !current)}
        className={`${BOX} inline-flex max-w-40 items-center justify-center gap-2 whitespace-nowrap rounded-full border border-[#00EC97]/40 bg-[#00EC97]/10 text-[#d9ffe8]`}
      >
        <span className="h-2 w-2 shrink-0 rounded-full bg-[#00EC97]" aria-hidden="true" />
        <span className="max-w-36 truncate">{shortAccount(signedAccountId)}</span>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-[80] mt-2 w-80 max-w-[calc(100vw-3rem)] space-y-3 rounded-2xl border border-white/10 bg-[#07110d] p-4 text-sm text-white shadow-[0_16px_40px_rgba(0,0,0,0.45)]"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 flex-1 break-all text-sm text-white">{signedAccountId}</p>
            <CopyButton value={signedAccountId} lang={lang} />
          </div>
          <p className="text-sm text-white/70">
            {translate(lang, "nearBalance")} <span className="text-white">{balance ?? "…"}</span>
          </p>
          <a href={explorer} target="_blank" rel="noreferrer" className="block break-all text-sm text-[#7DD3FC] underline-offset-2 hover:underline">
            {translate(lang, "viewOnExplorer")}
          </a>
          <button
            type="button"
            className="w-full rounded-xl border border-white/15 px-3 py-2 text-left text-sm text-white hover:bg-white/5"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
          >
            {translate(lang, "disconnectWallet")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
