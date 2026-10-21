"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { LumenClient } from "@lumen/web-sdk";
import { useIsMounted } from "./hooks/use-is-mounted.js";

/** Stellar networks a `LumenProvider` can switch between. */
export type LumenNetwork = "testnet" | "futurenet" | "mainnet";

export const DEFAULT_SUPPORTED_NETWORKS: LumenNetwork[] = ["testnet", "futurenet", "mainnet"];

export interface LumenContextValue {
  /** Client bound to `currentNetwork`. Changes identity when the network is switched. */
  client: LumenClient;
  /**
   * `true` once the provider has mounted on the client, `false` during
   * server-side rendering and hydration. Gate browser-only APIs
   * (`window.crypto`, `navigator.credentials`, …) behind this flag together
   * with `typeof window !== "undefined"` to avoid
   * `ReferenceError: window is not defined` on the server.
   */
  isMounted: boolean;
  /** The network the active `client` is connected to. */
  currentNetwork: LumenNetwork;
  /** Networks that `switchNetwork` accepts. */
  supportedNetworks: LumenNetwork[];
  /**
   * Switches the active network. Every hook reading `client` from this
   * context (`useBalance`, `useWallet`, …) refetches against the new network.
   */
  switchNetwork: (network: LumenNetwork) => void;
}

export const LumenContext = createContext<LumenContextValue | null>(null);

/**
 * `true` when running in a browser environment. Safe to evaluate during
 * React Server Component rendering because it never touches `window`
 * directly until the guard passes.
 */
export function isBrowserEnvironment(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/**
 * Creates a proxy that stands in for a `LumenClient` on the server. Any
 * property access or invocation throws a clear error explaining that a
 * browser environment is required, instead of failing with an opaque
 * `ReferenceError` or `TypeError` during RSC rendering.
 */
function createServerSafeClientProxy(): LumenClient {
  const thrower = (): never => {
    throw new Error(
      "@lumen/react: LumenClient requires a browser environment. " +
        "Render Lumen components inside a client component (\"use client\") " +
        "or use LumenServerProvider during React Server Component rendering.",
    );
  };

  return new Proxy({} as LumenClient, {
    get(_target, prop) {
      // Allow introspection helpers to behave sanely without throwing.
      if (prop === "then") {
        return undefined;
      }
      if (prop === Symbol.toStringTag) {
        return "LumenServerSafeClient";
      }
      if (typeof prop === "symbol") {
        return undefined;
      }
      return thrower;
    },
    apply() {
      return thrower();
    },
  });
}

/**
 * Server-safe fallback context value. `isMounted` is always `false` and the
 * `client` is a proxy that throws a descriptive error if used. This value is
 * safe to construct during RSC rendering and produces no hydration mismatch
 * because it matches the pre-mount client state.
 */
export const serverSafeLumenContextValue: LumenContextValue = {
  client: createServerSafeClientProxy(),
  isMounted: false,
  currentNetwork: "testnet",
  supportedNetworks: ["testnet"],
  switchNetwork: () => {},
};

export interface LumenProviderProps {
  /** Client connected to the initial `network`. */
  client: LumenClient;
  /** Network the provided `client` is connected to. Defaults to "testnet". */
  network?: LumenNetwork;
  /**
   * Networks the user may switch to. Defaults to all networks when
   * `createClient` is provided, otherwise only the initial `network`.
   */
  supportedNetworks?: LumenNetwork[];
  /**
   * Factory used to create a client for a network other than the initial
   * one. Clients are created lazily on first switch and cached.
   */
  createClient?: (network: LumenNetwork) => LumenClient;
  /**
   * BCP-47 locale code used to translate all prebuilt Lumen UI components.
   * Supported values: "en" | "es" | "pt" | "fr" | "ja"
   * Defaults to "en".
   */
  locale?: LumenLocale;
  children: React.ReactNode;
}

export function LumenProvider({
  client,
  network = "testnet",
  supportedNetworks,
  createClient,
  locale = "en",
  children,
}: LumenProviderProps) {
  const isMounted = useIsMounted();
  const [currentNetwork, setCurrentNetwork] = useState<LumenNetwork>(network);
  const clientsRef = useRef(new Map<LumenNetwork, LumenClient>());

  const networks = supportedNetworks ?? (createClient ? DEFAULT_SUPPORTED_NETWORKS : [network]);

  const activeClient = useMemo(() => {
    if (currentNetwork === network || !createClient) {
      return client;
    }
    let networkClient = clientsRef.current.get(currentNetwork);
    if (!networkClient) {
      networkClient = createClient(currentNetwork);
      clientsRef.current.set(currentNetwork, networkClient);
    }
    return networkClient;
  }, [client, network, currentNetwork, createClient]);

  const switchNetwork = useCallback(
    (next: LumenNetwork) => {
      if (!networks.includes(next)) {
        throw new Error(
          `@lumen/react: Network "${next}" is not supported. ` +
            `Supported networks: ${networks.join(", ")}`,
        );
      }
      if (next !== network && !createClient) {
        throw new Error(
          `@lumen/react: Cannot switch to "${next}" without a createClient prop on LumenProvider.`,
        );
      }
      setCurrentNetwork(next);
    },
    [networks, network, createClient],
  );

  // On the server, expose the server-safe proxy so browser crypto / WebAuthn
  // calls fail with a descriptive error instead of a `ReferenceError`.
  const safeClient = isBrowserEnvironment() ? activeClient : serverSafeLumenContextValue.client;

  return (
    <LumenContext.Provider
      value={{
        client: safeClient,
        isMounted,
        currentNetwork,
        supportedNetworks: networks,
        switchNetwork,
      }}
    >
      {children}
    </LumenContext.Provider>
  );
}

export interface LumenServerProviderProps {
  /**
   * Optional client to expose on the server. When omitted, a server-safe
   * proxy is used that throws a descriptive error if any method is invoked.
   */
  client?: LumenClient;
  /** Network to report during server rendering. Defaults to "testnet". */
  network?: LumenNetwork;
  children: React.ReactNode;
}

/**
 * Server-safe mock provider for React Server Components. It supplies a
 * context value with `isMounted: false` so that components render their
 * pre-hydration state on the server, avoiding hydration mismatches. It never
 * accesses browser globals.
 */
export function LumenServerProvider({
  client,
  network = "testnet",
  children,
}: LumenServerProviderProps) {
  const value: LumenContextValue = {
    ...serverSafeLumenContextValue,
    client: client ?? serverSafeLumenContextValue.client,
    isMounted: false,
    currentNetwork: network,
    supportedNetworks: [network],
  };

  return (
    <LumenContext.Provider value={value}>{children}</LumenContext.Provider>
  );
}

export function useLumen(): LumenContextValue {
  const context = useContext(LumenContext);

  if (!context) {
    throw new Error("useLumen must be used within a LumenProvider");
  }

  return context;
}