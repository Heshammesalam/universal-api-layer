// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createApp, defineComponent, effectScope, h, nextTick } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import { createSocketClient } from "../src/websocket";
import {
  useSocketMessage as useReactMessage,
  useSocketState as useReactState,
} from "../src/websocket/react";
import {
  useSocketMessage as useVueMessage,
  useSocketState as useVueState,
} from "../src/websocket/vue";
import { socketFactory } from "./socket-fixture";
afterEach(cleanup);
it("React subscribes to state/messages and cleans subscriptions without closing a shared socket", async () => {
  const { factory, sockets } = socketFactory();
  const socket = createSocketClient({
    url: "wss://chat.test",
    webSocketFactory: factory,
  });
  const first = vi.fn(),
    second = vi.fn();
  function View({ listener }: { listener: (message: unknown) => void }) {
    const state = useReactState(socket);
    useReactMessage(socket, listener);
    return <p>{state.status}</p>;
  }
  const view = render(
    <StrictMode>
      <View listener={first} />
    </StrictMode>,
  );
  expect(screen.getByText("idle")).toBeTruthy();
  act(() => {
    socket.connect();
    sockets[0].open();
  });
  expect(screen.getByText("open")).toBeTruthy();
  view.rerender(
    <StrictMode>
      <View listener={second} />
    </StrictMode>,
  );
  await act(async () => {
    sockets[0].message("1");
  });
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledExactlyOnceWith(1);
  view.unmount();
  sockets[0].message("2");
  await Promise.resolve();
  expect(second).toHaveBeenCalledTimes(1);
  expect(socket.getSnapshot().status).toBe("open");
  socket.dispose();
});
it("Vue subscribes to state/messages and removes them on scope disposal", async () => {
  const { factory, sockets } = socketFactory();
  const socket = createSocketClient({
    url: "wss://chat.test",
    webSocketFactory: factory,
  });
  const listener = vi.fn();
  const container = document.createElement("div");
  const app = createApp(
    defineComponent({
      setup() {
        const state = useVueState(socket);
        useVueMessage(socket, listener);
        return () => h("p", state.value.status);
      },
    }),
  );
  app.mount(container);
  socket.connect();
  sockets[0].open();
  await nextTick();
  expect(container.textContent).toBe("open");
  sockets[0].message("1");
  await vi.waitFor(() => expect(listener).toHaveBeenCalledExactlyOnceWith(1));
  app.unmount();
  sockets[0].message("2");
  await Promise.resolve();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(socket.getSnapshot().status).toBe("open");
  socket.dispose();
});
it("Vue composables require an active effect scope", () => {
  const socket = createSocketClient({ url: "wss://chat.test" });
  expect(() => useVueState(socket)).toThrow(/effect scope/);
  expect(() => useVueMessage(socket, () => {})).toThrow(/effect scope/);
  const scope = effectScope();
  scope.run(() => {
    useVueState(socket);
  });
  scope.stop();
  socket.dispose();
});
