"use client";

import { DEMO_OWNER_ID } from "@/lib/wallet-proof";
import { NearProvider } from "near-connect-hooks";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type KothaNetwork = "testnet" | "mainnet";

type KothaSessionValue = {
  network: KothaNetwork;
  setNetwork: (network: KothaNetwork) => void;
  demoAccountId: string | null;
  setDemoAccountId: (accountId: string | null) => void;
  sessionOwnerOptIn: boolean;
  setSessionOwnerOptIn: (on: boolean) => void;
};

const KothaSessionContext = createContext<KothaSessionValue | null>(null);
const DEMO_FLAG = "kotha-demo-owner-active";
const OPT_IN = "kotha-use-connected-owner";
const NETWORK_KEY = "kotha-network";

export function useKothaSession(): KothaSessionValue {
  const value = useContext(KothaSessionContext);
  if (!value) throw new Error("Kotha session is missing.");
  return value;
}

function configuredNetwork(): KothaNetwork {
  return process.env.NEXT_PUBLIC_NETWORK === "mainnet" ? "mainnet" : "testnet";
}

export function allowsMainnet(): boolean {
  return process.env.NEXT_PUBLIC_NETWORK === "mainnet";
}

export function Providers({ children }: { children: ReactNode }) {
  const [network, setNetworkState] = useState<KothaNetwork>(configuredNetwork());
  const [demoAccountId, setDemoAccountIdState] = useState<string | null>(null);
  const [sessionOwnerOptIn, setSessionOwnerOptInState] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(NETWORK_KEY);
      if (!allowsMainnet()) setNetworkState("testnet");
      else if (stored === "mainnet" || stored === "testnet") setNetworkState(stored);
      setDemoAccountIdState(window.sessionStorage.getItem(DEMO_FLAG) === "1" ? DEMO_OWNER_ID : null);
      setSessionOwnerOptInState(window.localStorage.getItem(OPT_IN) === "1");
    } catch {
      // Storage can be blocked. The menu still works for this page load.
    }
  }, []);

  const setNetwork = useCallback((next: KothaNetwork) => {
    const resolved = next === "mainnet" && !allowsMainnet() ? "testnet" : next;
    setNetworkState(resolved);
    try {
      window.localStorage.setItem(NETWORK_KEY, resolved);
    } catch {
      // The in-memory network still applies to this page.
    }
  }, []);

  const setDemoAccountId = useCallback((accountId: string | null) => {
    setDemoAccountIdState(accountId);
    try {
      if (accountId) window.sessionStorage.setItem(DEMO_FLAG, "1");
      else window.sessionStorage.removeItem(DEMO_FLAG);
    } catch {
      // The in-memory demo session still applies to this page.
    }
  }, []);

  const setSessionOwnerOptIn = useCallback((on: boolean) => {
    setSessionOwnerOptInState(on);
    try {
      window.localStorage.setItem(OPT_IN, on ? "1" : "0");
    } catch {
      // The in-memory toggle still applies to this page.
    }
  }, []);

  const value = useMemo(
    () => ({ network, setNetwork, demoAccountId, setDemoAccountId, sessionOwnerOptIn, setSessionOwnerOptIn }),
    [network, setNetwork, demoAccountId, setDemoAccountId, sessionOwnerOptIn, setSessionOwnerOptIn],
  );

  return (
    <KothaSessionContext.Provider value={value}>
      <NearProvider key={network} config={{ network, autoConnect: true }}>
        {children}
      </NearProvider>
    </KothaSessionContext.Provider>
  );
}
