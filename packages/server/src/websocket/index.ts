import { WebSocketServer, type WebSocket } from "ws";

export interface WalletSocketEventPayload extends Record<string, unknown> {
  walletAddress: string;
  event: string;
  timestamp: string;
}

export interface WalletWebSocketServer {
  server: WebSocketServer;
  broadcast: (walletAddress: string, event: string, payload?: Record<string, unknown>) => void;
}

export function createWalletWebSocketServer(): WalletWebSocketServer {
  const server = new WebSocketServer({ noServer: true });
  const subscriptions = new Map<string, Set<WebSocket>>();

  const removeSocket = (socket: WebSocket): void => {
    for (const [walletAddress, peers] of subscriptions.entries()) {
      if (peers.has(socket)) {
        peers.delete(socket);
        if (peers.size === 0) {
          subscriptions.delete(walletAddress);
        }
      }
    }
  };

  const subscribe = (walletAddress: string, socket: WebSocket): void => {
    const peers = subscriptions.get(walletAddress) ?? new Set<WebSocket>();
    peers.add(socket);
    subscriptions.set(walletAddress, peers);
  };

  const broadcast = (walletAddress: string, event: string, payload: Record<string, unknown> = {}): void => {
    const message = JSON.stringify({
      ...payload,
      type: "wallet_event",
      event,
      walletAddress,
      timestamp: new Date().toISOString(),
    });

    for (const socket of subscriptions.get(walletAddress) ?? []) {
      if (socket.readyState === socket.OPEN) {
        socket.send(message);
      }
    }
  };

  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw) => {
      const data = typeof raw === "string" ? raw : raw.toString();
      const value = data.trim();
      if (!value) return;

      if (value.startsWith("subscribe:wallet:")) {
        const walletAddress = value.slice("subscribe:wallet:".length).trim();
        if (walletAddress) {
          subscribe(walletAddress, socket);
        }
        return;
      }

      try {
        const json = JSON.parse(value) as {
          type?: string;
          channel?: string;
          walletAddress?: string;
        };
        if (json.type === "subscribe" && json.channel === "wallet" && json.walletAddress) {
          subscribe(json.walletAddress, socket);
        }
      } catch {
        // Ignore non-JSON or malformed subscription frames.
      }
    });

    socket.on("close", () => removeSocket(socket));
    socket.on("error", () => removeSocket(socket));
  });

  return { server, broadcast };
}
