/**
 * LumenPolicyEditor — #265
 *
 * Form for viewing and modifying a wallet's spend policy: daily spend limits,
 * destination address whitelist, and contract call permissions. Inputs are
 * validated before the policy is dispatched via `PUT /policy/:walletId`.
 */

import React, { useState } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import type {
  AllowlistRule,
  BlocklistRule,
  ContractAllowlistRule,
  PolicyRule,
  SpendLimit,
} from "@lumen/types";

export interface LumenPolicyEditorProps {
  /** Wallet whose policy is edited. */
  walletId: string;
  /** Existing policy rules used to prefill the form. */
  initialRules?: PolicyRule[];
  /** Base URL of the Lumen server. Defaults to "". */
  baseUrl?: string;
  /** Optional fetch implementation override. */
  fetchImpl?: typeof fetch;
  /** Called with the server response after the policy is saved. */
  onSaved?: (policy: unknown) => void;
  /** Additional CSS class name(s) for the root element. */
  className?: string;
}

interface PolicyFormErrors {
  maxDaily?: string;
  maxPerTx?: string;
  destinations?: string;
  blocklist?: string;
  contracts?: string;
  form?: string;
}

const DECIMAL_PATTERN = /^[0-9]+(?:\.[0-9]+)?$/;

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function validatePositiveAmount(value: string, label: string): string | undefined {
  if (!DECIMAL_PATTERN.test(value) || Number(value) <= 0) {
    return `${label} must be a positive number`;
  }
  return undefined;
}

function invalidAddressMessage(address: string): string {
  return `'${address}' is not a valid Stellar address`;
}

/**
 * Returns the non-empty lines that are not valid Stellar public keys.
 * Empty lines are ignored.
 */
function findInvalidAddresses(value: string): string[] {
  return splitLines(value).filter((address) => !StrKey.isValidEd25519PublicKey(address));
}

/**
 * Builds the policy rules from the form values. Returns the validation
 * errors instead when any input is malformed.
 */
function buildRules(values: {
  asset: string;
  maxDaily: string;
  maxPerTx: string;
  destinations: string;
  blocklist: string;
  contracts: string;
}): { rules: PolicyRule[]; errors: PolicyFormErrors } {
  const errors: PolicyFormErrors = {};
  const rules: PolicyRule[] = [];

  const maxDaily = values.maxDaily.trim();
  const maxPerTx = values.maxPerTx.trim();
  if (maxDaily || maxPerTx) {
    errors.maxDaily = validatePositiveAmount(maxDaily, "Daily limit");
    errors.maxPerTx = maxPerTx ? validatePositiveAmount(maxPerTx, "Per-transaction limit") : undefined;
    if (!errors.maxDaily && !errors.maxPerTx) {
      const rule: SpendLimit = {
        type: "spend_limit",
        asset: values.asset.trim() || "XLM",
        maxPerTx: maxPerTx || maxDaily,
        maxDaily,
      };
      rules.push(rule);
    }
  }

  const destinations = splitLines(values.destinations);
  const invalidDestinations = findInvalidAddresses(values.destinations);
  if (invalidDestinations.length > 0) {
    errors.destinations = invalidAddressMessage(invalidDestinations[0]);
  } else if (destinations.length > 0) {
    const rule: AllowlistRule = { type: "allowlist", destinations };
    rules.push(rule);
  }

  const blocklist = splitLines(values.blocklist);
  const invalidBlocklist = findInvalidAddresses(values.blocklist);
  if (invalidBlocklist.length > 0) {
    errors.blocklist = invalidAddressMessage(invalidBlocklist[0]);
  } else if (blocklist.length > 0) {
    const rule: BlocklistRule = { type: "blocklist", destinations: blocklist };
    rules.push(rule);
  }

  // Each line: CONTRACT_ID or CONTRACT_ID:method1,method2
  const allowedContracts: ContractAllowlistRule["allowedContracts"] = [];
  for (const line of splitLines(values.contracts)) {
    const [contractId = "", methodList = ""] = line.split(":", 2).map((part) => part.trim());
    if (!StrKey.isValidContract(contractId)) {
      errors.contracts = `Invalid contract address: ${contractId}`;
      break;
    }
    const methods = methodList
      .split(",")
      .map((method) => method.trim())
      .filter(Boolean);
    allowedContracts.push(methods.length > 0 ? { contractId, methods } : { contractId });
  }
  if (!errors.contracts && allowedContracts.length > 0) {
    const rule: ContractAllowlistRule = { type: "contract_allowlist", allowedContracts };
    rules.push(rule);
  }

  const hasErrors = Object.values(errors).some(Boolean);
  if (!hasErrors && rules.length === 0) {
    errors.form = "At least one rule is required";
  }

  return { rules, errors };
}

function getInitialValues(initialRules: PolicyRule[] = []) {
  const spendLimit = initialRules.find((rule): rule is SpendLimit => rule.type === "spend_limit");
  const allowlist = initialRules.find((rule): rule is AllowlistRule => rule.type === "allowlist");
  const contractAllowlist = initialRules.find(
    (rule): rule is ContractAllowlistRule => rule.type === "contract_allowlist",
  );

  const blocklist = initialRules.find((rule): rule is BlocklistRule => rule.type === "blocklist");

  return {
    asset: spendLimit?.asset ?? "XLM",
    maxDaily: spendLimit?.maxDaily ?? "",
    maxPerTx: spendLimit?.maxPerTx ?? "",
    destinations: allowlist?.destinations.join("\n") ?? "",
    blocklist: blocklist?.destinations.join("\n") ?? "",
    contracts:
      contractAllowlist?.allowedContracts
        .map(({ contractId, methods }) =>
          methods && methods.length > 0 ? `${contractId}:${methods.join(",")}` : contractId,
        )
        .join("\n") ?? "",
  };
}

const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
};

const errorStyle: React.CSSProperties = {
  color: "#c0392b",
  fontSize: "0.85rem",
};

export function LumenPolicyEditor({
  walletId,
  initialRules,
  baseUrl = "",
  fetchImpl,
  onSaved,
  className,
}: LumenPolicyEditorProps): React.ReactElement {
  const [values, setValues] = useState(() => getInitialValues(initialRules));
  const [errors, setErrors] = useState<PolicyFormErrors>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const invalidDestinations = findInvalidAddresses(values.destinations);
  const invalidBlocklist = findInvalidAddresses(values.blocklist);
  const hasInvalidAddresses = invalidDestinations.length > 0 || invalidBlocklist.length > 0;

  const update = (field: keyof typeof values) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setValues((prev) => ({ ...prev, [field]: event.target.value }));
      setSaved(false);
    };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaved(false);

    const { rules, errors: nextErrors } = buildRules(values);
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;

    setSaving(true);
    try {
      const doFetch = fetchImpl ?? fetch;
      const response = await doFetch(`${baseUrl}/policy/${encodeURIComponent(walletId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletId, rules }),
      });
      if (!response.ok) {
        throw new Error(`Failed to update policy for wallet ${walletId}: ${response.status}`);
      }
      const policy: unknown = await response.json();
      setSaved(true);
      onSaved?.(policy);
    } catch (err) {
      setErrors({ form: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className={["lumen-policy-editor", className].filter(Boolean).join(" ")}
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      noValidate
      style={{ display: "flex", flexDirection: "column", gap: "1rem" }}
    >
      <fieldset className="lumen-policy-editor__spend-limit" style={{ ...fieldStyle, gap: "0.5rem" }}>
        <legend>Spend limit</legend>
        <label style={fieldStyle}>
          Asset
          <input type="text" value={values.asset} onChange={update("asset")} />
        </label>
        <label style={fieldStyle}>
          Daily limit
          <input
            type="text"
            inputMode="decimal"
            value={values.maxDaily}
            onChange={update("maxDaily")}
            aria-invalid={Boolean(errors.maxDaily)}
          />
          {errors.maxDaily && <span role="alert" style={errorStyle}>{errors.maxDaily}</span>}
        </label>
        <label style={fieldStyle}>
          Per-transaction limit
          <input
            type="text"
            inputMode="decimal"
            value={values.maxPerTx}
            onChange={update("maxPerTx")}
            aria-invalid={Boolean(errors.maxPerTx)}
          />
          {errors.maxPerTx && <span role="alert" style={errorStyle}>{errors.maxPerTx}</span>}
        </label>
      </fieldset>

      <label className="lumen-policy-editor__destinations" style={fieldStyle}>
        Destination whitelist (one address per line)
        <textarea
          rows={4}
          value={values.destinations}
          onChange={update("destinations")}
          aria-invalid={Boolean(errors.destinations) || invalidDestinations.length > 0}
        />
        {invalidDestinations.map((address) => (
          <span key={address} role="alert" style={errorStyle}>
            {invalidAddressMessage(address)}
          </span>
        ))}
        {invalidDestinations.length === 0 && errors.destinations && (
          <span role="alert" style={errorStyle}>{errors.destinations}</span>
        )}
      </label>

      <label className="lumen-policy-editor__blocklist" style={fieldStyle}>
        Destination blocklist (one address per line)
        <textarea
          rows={4}
          value={values.blocklist}
          onChange={update("blocklist")}
          aria-invalid={Boolean(errors.blocklist) || invalidBlocklist.length > 0}
        />
        {invalidBlocklist.map((address) => (
          <span key={address} role="alert" style={errorStyle}>
            {invalidAddressMessage(address)}
          </span>
        ))}
        {invalidBlocklist.length === 0 && errors.blocklist && (
          <span role="alert" style={errorStyle}>{errors.blocklist}</span>
        )}
      </label>

      <label className="lumen-policy-editor__contracts" style={fieldStyle}>
        Contract call permissions (one per line, CONTRACT_ID or CONTRACT_ID:method1,method2)
        <textarea
          rows={4}
          value={values.contracts}
          onChange={update("contracts")}
          aria-invalid={Boolean(errors.contracts)}
        />
        {errors.contracts && <span role="alert" style={errorStyle}>{errors.contracts}</span>}
      </label>

      {errors.form && <p role="alert" style={errorStyle}>{errors.form}</p>}
      {saved && <p role="status" style={{ color: "#4caf50" }}>Policy saved</p>}

      <button type="submit" disabled={saving || hasInvalidAddresses} aria-busy={saving}>
        {saving ? "Saving…" : "Save policy"}
      </button>
    </form>
  );
}
