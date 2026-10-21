import React, { useEffect, useState } from "react";
import { useLumen, type LumenNetwork } from "../context.js";

/** Default Horizon endpoints pinged to measure latency for each network. */
export const DEFAULT_NETWORK_PING_URLS: Record<LumenNetwork, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  futurenet: "https://horizon-futurenet.stellar.org",
  mainnet: "https://horizon.stellar.org",
};

const NETWORK_LABELS: Record<LumenNetwork, string> = {
  testnet: "Testnet",
  futurenet: "Futurenet",
  mainnet: "Mainnet",
};

const NETWORK_COLORS: Record<LumenNetwork, string> = {
  testnet: "#2980b9",
  futurenet: "#8e44ad",
  mainnet: "#27ae60",
};

export type LumenNetworkLatencyStatus = "checking" | "good" | "fair" | "poor" | "offline";

const STATUS_COLORS: Record<LumenNetworkLatencyStatus, string> = {
  checking: "#95a5a6",
  good: "#27ae60",
  fair: "#f39c12",
  poor: "#e67e22",
  offline: "#c0392b",
};

export interface LumenNetworkBarProps {
  /** Latency ping interval in milliseconds. Set to 0 to ping only once. Defaults to 15 000. */
  pingInterval?: number;
  /** Override the URL pinged for each network. */
  pingUrls?: Partial<Record<LumenNetwork, string>>;
  /** Additional CSS class name(s) for the root element. */
  className?: string;
}

function getLatencyStatus(latency: number): LumenNetworkLatencyStatus {
  if (latency < 300) return "good";
  if (latency < 1000) return "fair";
  return "poor";
}

/**
 * Displays the active network as a badge alongside a latency indicator, and
 * lets the user switch between the provider's supported networks.
 */
export function LumenNetworkBar({
  pingInterval = 15_000,
  pingUrls,
  className,
}: LumenNetworkBarProps): React.ReactElement {
  const { currentNetwork, supportedNetworks, switchNetwork } = useLumen();
  const [latency, setLatency] = useState<number | null>(null);
  const [status, setStatus] = useState<LumenNetworkLatencyStatus>("checking");

  const pingUrl = pingUrls?.[currentNetwork] ?? DEFAULT_NETWORK_PING_URLS[currentNetwork];

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let cancelled = false;
    setLatency(null);
    setStatus("checking");

    const ping = async () => {
      const start = performance.now();
      try {
        const res = await fetch(pingUrl, { method: "GET", cache: "no-store" });
        if (!res.ok) throw new Error(`Ping failed (${res.status})`);
        if (cancelled) return;
        const elapsed = Math.round(performance.now() - start);
        setLatency(elapsed);
        setStatus(getLatencyStatus(elapsed));
      } catch {
        if (cancelled) return;
        setLatency(null);
        setStatus("offline");
      }
    };

    void ping();

    if (pingInterval <= 0) {
      return () => {
        cancelled = true;
      };
    }

    const intervalId = window.setInterval(() => {
      void ping();
    }, pingInterval);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [pingUrl, pingInterval]);

  const latencyLabel =
    status === "checking" ? "Checking…" : status === "offline" ? "Offline" : `${latency} ms`;

  return (
    <div
      className={["lumen-network-bar", className].filter(Boolean).join(" ")}
      style={{ display: "flex", alignItems: "center", gap: "0.5em" }}
    >
      <span
        className="lumen-network-bar__badge"
        data-network={currentNetwork}
        style={{
          padding: "0.15em 0.6em",
          borderRadius: "999px",
          color: "#fff",
          background: NETWORK_COLORS[currentNetwork],
          fontSize: "0.85em",
          fontWeight: 600,
        }}
      >
        {NETWORK_LABELS[currentNetwork]}
      </span>
      <span
        className="lumen-network-bar__latency"
        data-status={status}
        role="status"
        aria-live="polite"
        aria-label={`Network latency: ${latencyLabel}`}
        style={{ display: "inline-flex", alignItems: "center", gap: "0.3em" }}
      >
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: "0.6em",
            height: "0.6em",
            borderRadius: "50%",
            background: STATUS_COLORS[status],
          }}
        />
        {latencyLabel}
      </span>
      {supportedNetworks.length > 1 && (
        <select
          className="lumen-network-bar__select"
          aria-label="Select network"
          value={currentNetwork}
          onChange={(event) => switchNetwork(event.target.value as LumenNetwork)}
        >
          {supportedNetworks.map((network) => (
            <option key={network} value={network}>
              {NETWORK_LABELS[network]}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
