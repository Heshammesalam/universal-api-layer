import { vi } from "vitest";
import type {
  SocketEvents,
  SocketSendData,
  SocketTransport,
} from "../src/websocket";
type Listener = (event: SocketEvents[keyof SocketEvents]) => void;
export class FakeSocket implements SocketTransport {
  readyState = 0;
  bufferedAmount = 0;
  binaryType: "arraybuffer" | "blob" = "blob";
  listeners = new Map<string, Set<Listener>>();
  send = vi.fn((data: SocketSendData) => {
    void data;
  });
  close = vi.fn((_code?: number, _reason?: string) => {
    void _code;
    void _reason;
    this.readyState = 3;
  });
  addEventListener<K extends keyof SocketEvents>(
    type: K,
    listener: (event: SocketEvents[K]) => void,
  ) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener as Listener);
  }
  removeEventListener<K extends keyof SocketEvents>(
    type: K,
    listener: (event: SocketEvents[K]) => void,
  ) {
    this.listeners.get(type)?.delete(listener as Listener);
  }
  emit<K extends keyof SocketEvents>(
    type: K,
    value: Omit<SocketEvents[K], "type">,
  ) {
    for (const listener of [...(this.listeners.get(type) ?? [])])
      listener({ type, ...value } as SocketEvents[K]);
  }
  open() {
    this.readyState = 1;
    this.emit("open", {});
  }
  message(data: unknown) {
    this.emit("message", { data });
  }
  end(code = 1006, reason = "") {
    this.readyState = 3;
    this.emit("close", { code, reason, wasClean: code === 1000 });
  }
}
export function socketFactory() {
  const sockets: FakeSocket[] = [];
  const factory = vi.fn((_url: string, _protocols: string[]) => {
    void _url;
    void _protocols;
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  return { sockets, factory };
}
