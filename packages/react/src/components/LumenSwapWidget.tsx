import React, { useMemo, useState } from "react";

export interface LumenSwapWidgetProps {
  /** Asset code being sold. */
  fromAsset: string;
  /** Asset code being received. */
  toAsset: string;
  /** Amount currently entered for the source asset. */
  fromAmount: string;
  /** Amount currently entered for the destination asset. */
  toAmount: string;
  /** Allowed slippage as a percentage, e.g. 0.5 for 0.5%. */
  slippage: number;
  /** The fair market rate (toAsset per fromAsset) used to compute price impact. */
  marketRate?: number;
  /** Fraction (0–1) above which a price impact warning is shown. Default 0.02 (2%). */
  highPriceImpactThreshold?: number;
  /** Disables the form while a quote or execution is in flight. */
  loading?: boolean;
  /** Disables the widget completely. */
  disabled?: boolean;
  /** Optional custom class name. */
  className?: string;
  /** Called when the user updates the source amount. */
  onFromAmountChange?: (value: string) => void;
  /** Called when the user updates the quoted receive amount. */
  onToAmountChange?: (value: string) => void;
  /** Called when the user confirms the swap. */
  onSwap?: () => void;
}

function formatPrice(fromAmount: string, toAmount: string): string {
  const fromValue = Number(fromAmount);
  const toValue = Number(toAmount);

  if (!Number.isFinite(fromValue) || !Number.isFinite(toValue) || fromValue <= 0) {
    return "—";
  }

  return (toValue / fromValue).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function computePriceImpact(
  fromAmount: string,
  toAmount: string,
  marketRate: number | undefined,
): number | null {
  const fromValue = Number(fromAmount);
  const toValue = Number(toAmount);

  if (
    marketRate == null ||
    marketRate <= 0 ||
    !Number.isFinite(fromValue) ||
    !Number.isFinite(toValue) ||
    fromValue <= 0
  ) {
    return null;
  }

  const expectedTo = fromValue * marketRate;
  if (expectedTo <= 0) return null;
  return (expectedTo - toValue) / expectedTo;
}

const SEVERE_IMPACT_THRESHOLD = 0.05;

function HighPriceImpactWarning({
  priceImpact,
  severe,
  confirmed,
  onConfirmChange,
}: {
  priceImpact: number;
  severe: boolean;
  confirmed: boolean;
  onConfirmChange: (checked: boolean) => void;
}): React.ReactElement {
  const pct = (priceImpact * 100).toFixed(2);
  const bg = severe ? "rgba(239, 68, 68, 0.1)" : "rgba(234, 179, 8, 0.1)";
  const border = severe ? "rgba(239, 68, 68, 0.4)" : "rgba(234, 179, 8, 0.4)";
  const color = severe ? "#b91c1c" : "#92400e";

  return (
    <div
      role="alert"
      style={{
        padding: "0.75rem 1rem",
        borderRadius: "12px",
        border: `1px solid ${border}`,
        background: bg,
        color,
        fontSize: "0.85rem",
        lineHeight: 1.5,
      }}
    >
      <strong>
        {severe ? "Very high price impact" : "High price impact"} ({pct}%)
      </strong>
      <p style={{ margin: "0.35rem 0 0" }}>
        {severe
          ? "You will lose a significant portion of your funds due to price impact. Confirm below to proceed."
          : "The quoted rate differs from the market rate. Consider reducing your trade size."}
      </p>
      {severe && (
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            marginTop: "0.5rem",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => onConfirmChange(e.target.checked)}
          />
          I understand the risk and want to proceed
        </label>
      )}
    </div>
  );
}

function formatMinimumReceived(toAmount: string, slippage: number): string {
  const toValue = Number(toAmount);

  if (!Number.isFinite(toValue)) {
    return "—";
  }

  const minimum = toValue * (1 - slippage / 100);
  return minimum.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function LumenSwapWidget({
  fromAsset,
  toAsset,
  fromAmount,
  toAmount,
  slippage,
  marketRate,
  highPriceImpactThreshold = 0.02,
  loading = false,
  disabled = false,
  className,
  onFromAmountChange,
  onToAmountChange,
  onSwap,
}: LumenSwapWidgetProps): React.ReactElement {
  const [severeImpactConfirmed, setSevereImpactConfirmed] = useState(false);

  const priceImpact = useMemo(
    () => computePriceImpact(fromAmount, toAmount, marketRate),
    [fromAmount, toAmount, marketRate],
  );

  const showWarning = priceImpact != null && priceImpact > highPriceImpactThreshold;
  const isSevere = priceImpact != null && priceImpact > SEVERE_IMPACT_THRESHOLD;
  const isDisabled = disabled || loading || (isSevere && !severeImpactConfirmed);

  const estimatedPrice = formatPrice(fromAmount, toAmount);
  const minimumReceived = formatMinimumReceived(toAmount, slippage);

  return (
    <div
      className={["lumen-swap-widget", className].filter(Boolean).join(" ")}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
        width: "100%",
        maxWidth: 420,
        padding: "1.25rem",
        borderRadius: "16px",
        border: "1px solid rgba(15, 23, 42, 0.12)",
        background: "#ffffff",
        boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      }}
      aria-label="Swap assets"
    >
      <div style={{ display: "grid", gap: "0.75rem" }}>
        <div
          style={{
            padding: "0.8rem 1rem",
            borderRadius: "12px",
            border: "1px solid rgba(148, 163, 184, 0.5)",
            background: "#f8fafc",
          }}
        >
          <label
            htmlFor="lumen-swap-from"
            style={{ display: "block", fontSize: "0.75rem", marginBottom: 4 }}
          >
            You pay
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <input
              id="lumen-swap-from"
              aria-label="You pay"
              type="text"
              value={fromAmount}
              onChange={(event) => onFromAmountChange?.(event.target.value)}
              disabled={isDisabled}
              style={{
                flex: 1,
                border: "none",
                background: "transparent",
                outline: "none",
                fontSize: "1.5rem",
                fontWeight: 600,
                color: "#0f172a",
              }}
            />
            <span style={{ fontWeight: 700, color: "#0f172a" }}>{fromAsset}</span>
          </div>
        </div>

        <button
          type="button"
          aria-label="Reverse assets"
          disabled={isDisabled}
          style={{
            width: "2.5rem",
            height: "2.5rem",
            margin: "0 auto",
            borderRadius: "999px",
            border: "1px solid rgba(148, 163, 184, 0.5)",
            background: "#ffffff",
            cursor: isDisabled ? "not-allowed" : "pointer",
            fontSize: "1.2rem",
          }}
        >
          ↕
        </button>

        <div
          style={{
            padding: "0.8rem 1rem",
            borderRadius: "12px",
            border: "1px solid rgba(148, 163, 184, 0.5)",
            background: "#f8fafc",
          }}
        >
          <label
            htmlFor="lumen-swap-to"
            style={{ display: "block", fontSize: "0.75rem", marginBottom: 4 }}
          >
            You receive
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <input
              id="lumen-swap-to"
              aria-label="You receive"
              type="text"
              value={toAmount}
              onChange={(event) => onToAmountChange?.(event.target.value)}
              disabled={isDisabled}
              style={{
                flex: 1,
                border: "none",
                background: "transparent",
                outline: "none",
                fontSize: "1.5rem",
                fontWeight: 600,
                color: "#0f172a",
              }}
            />
            <span style={{ fontWeight: 700, color: "#0f172a" }}>{toAsset}</span>
          </div>
        </div>
      </div>

      <div
        aria-live="polite"
        aria-atomic="true"
        style={{
          display: "grid",
          gap: "0.5rem",
          padding: "0.75rem 0.9rem",
          borderRadius: "12px",
          border: "1px solid rgba(148, 163, 184, 0.2)",
          background: "#f9fafb",
          fontSize: "0.9rem",
          color: "#334155",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Slippage</span>
          <strong>{slippage}%</strong>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Estimated price</span>
          <strong>
            {estimatedPrice === "—" ? "—" : `1 ${fromAsset} = ${estimatedPrice} ${toAsset}`}
          </strong>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Minimum received</span>
          <strong>
            {minimumReceived} {toAsset}
          </strong>
        </div>
      </div>

      {showWarning && priceImpact != null && (
        <HighPriceImpactWarning
          priceImpact={priceImpact}
          severe={isSevere}
          confirmed={severeImpactConfirmed}
          onConfirmChange={setSevereImpactConfirmed}
        />
      )}

      <button
        type="button"
        onClick={() => {
          if (!isDisabled) {
            onSwap?.();
          }
        }}
        disabled={isDisabled}
        style={{
          border: "none",
          borderRadius: "12px",
          padding: "0.9rem 1rem",
          background: isDisabled ? "#cbd5e1" : "#0f172a",
          color: "#ffffff",
          fontWeight: 700,
          cursor: isDisabled ? "not-allowed" : "pointer",
        }}
      >
        {loading ? "Swapping…" : "Swap"}
      </button>
    </div>
  );
}
