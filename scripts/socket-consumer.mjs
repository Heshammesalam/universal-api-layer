export async function verifyPackedSocket(socketModule, coreModule) {
  const { createSocketClient } = await import(socketModule);
  const { createApiClient } = await import(coreModule);
  class Transport extends EventTarget {
    readyState = 0;
    bufferedAmount = 0;
    binaryType = "arraybuffer";
    sent = [];
    send(value) {
      this.sent.push(value);
    }
    close() {
      this.readyState = 3;
    }
  }
  const transport = new Transport();
  const session = createApiClient({
    session: { userId: "a", token: "synthetic-private-token" },
  });
  const client = createSocketClient({
    url: "wss://socket.test",
    sessionClient: session,
    webSocketFactory: () => transport,
    schema(value) {
      if (!value || typeof value.text !== "string")
        throw Error("Invalid message");
      return value;
    },
  });
  let timer;
  try {
    const received = new Promise((resolve, reject) => {
      client.onMessage(resolve);
      client.onError(reject);
      timer = setTimeout(
        () => reject(Error("Packed socket message timed out")),
        2000,
      );
    });
    client.connect();
    transport.readyState = 1;
    transport.dispatchEvent(new Event("open"));
    client.sendJson({ text: "outgoing" });
    transport.dispatchEvent(
      Object.assign(new Event("message"), { data: '{"text":"packed socket"}' }),
    );
    if (
      (await received).text !== "packed socket" ||
      transport.sent[0] !== '{"text":"outgoing"}'
    )
      throw Error("Packed socket messages failed");
    session.logout();
    if (client.getSnapshot().status !== "closed" || transport.readyState !== 3)
      throw Error("Packed socket session cleanup failed");
  } finally {
    clearTimeout(timer);
    client.dispose();
  }
}
