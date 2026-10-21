import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LumenProvider, useLumen } from "./context.js";
import { useBalance } from "./use-balance.js";
import type { LumenClient } from "@lumen/web-sdk";

describe("LumenProvider", () => {
  it("provides the Lumen client through useLumen", () => {
    const client = {} as LumenClient;

    const { result } = renderHook(() => useLumen(), {
      wrapper: ({ children }) => (
        <LumenProvider client={client}>{children}</LumenProvider>
      ),
    });

    expect(result.current.client).toBe(client);
  });

  it("provides isMounted=true after the provider mounts (SSR-safe)", () => {
    const client = {} as LumenClient;

    const { result } = renderHook(() => useLumen(), {
      wrapper: ({ children }) => (
        <LumenProvider client={client}>{children}</LumenProvider>
      ),
    });

    expect(result.current.isMounted).toBe(true);
  });

  it("throws when useLumen is used outside the provider", () => {
    expect(() => renderHook(() => useLumen())).toThrow(
      "useLumen must be used within a LumenProvider"
    );
  });
});

describe("LumenProvider network switching", () => {
  it("exposes the initial network and supported networks", () => {
    const client = {} as LumenClient;

    const { result } = renderHook(() => useLumen(), {
      wrapper: ({ children }) => (
        <LumenProvider client={client} network="mainnet">{children}</LumenProvider>
      ),
    });

    expect(result.current.currentNetwork).toBe("mainnet");
    expect(result.current.supportedNetworks).toEqual(["mainnet"]);
  });

  it("switches to a client created for the selected network", () => {
    const testnetClient = {} as LumenClient;
    const futurenetClient = {} as LumenClient;
    const createClient = vi.fn(() => futurenetClient);

    const { result } = renderHook(() => useLumen(), {
      wrapper: ({ children }) => (
        <LumenProvider client={testnetClient} createClient={createClient}>
          {children}
        </LumenProvider>
      ),
    });

    act(() => result.current.switchNetwork("futurenet"));

    expect(createClient).toHaveBeenCalledWith("futurenet");
    expect(result.current.currentNetwork).toBe("futurenet");
    expect(result.current.client).toBe(futurenetClient);

    act(() => result.current.switchNetwork("testnet"));

    expect(result.current.client).toBe(testnetClient);
  });

  it("throws when switching to an unsupported network", () => {
    const client = {} as LumenClient;

    const { result } = renderHook(() => useLumen(), {
      wrapper: ({ children }) => (
        <LumenProvider client={client}>{children}</LumenProvider>
      ),
    });

    expect(() => result.current.switchNetwork("mainnet")).toThrow(
      'Network "mainnet" is not supported'
    );
  });

  it("refetches useBalance against the newly selected network", async () => {
    const testnetClient = {
      getBalance: vi.fn().mockResolvedValue("10"),
    } as unknown as LumenClient;
    const mainnetClient = {
      getBalance: vi.fn().mockResolvedValue("99"),
    } as unknown as LumenClient;

    const { result } = renderHook(
      () => ({ lumen: useLumen(), balance: useBalance("GABC", undefined, 0) }),
      {
        wrapper: ({ children }) => (
          <LumenProvider client={testnetClient} createClient={() => mainnetClient}>
            {children}
          </LumenProvider>
        ),
      }
    );

    await waitFor(() => expect(result.current.balance.balance).toBe("10"));

    act(() => result.current.lumen.switchNetwork("mainnet"));

    await waitFor(() => expect(result.current.balance.balance).toBe("99"));
    expect(mainnetClient.getBalance).toHaveBeenCalledWith("GABC", undefined);
  });
});
