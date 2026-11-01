<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { createSocketClient } from "universal-api-layer/websocket";
import {
  useSocketMessage,
  useSocketState,
} from "universal-api-layer/websocket/vue";
import { client } from "./api";

// Supply a raw WebSocket backend for this development URL; use wss:// in production.
const socket = createSocketClient({
  url: "ws://localhost:3000/chat",
  sessionClient: client,
  requiresAuth: false,
  schema(value: unknown) {
    if (
      !value ||
      typeof value !== "object" ||
      !("text" in value) ||
      typeof value.text !== "string"
    )
      throw Error("Expected a chat message");
    return { text: value.text };
  },
});
const state = useSocketState(socket);
const messages = ref<string[]>([]),
  text = ref(""),
  error = ref("");
useSocketMessage(socket, (message) => {
  messages.value = [...messages.value.slice(-99), message.text];
});
const offSession = client.subscribeSession(() => {
  messages.value = [];
});
onMounted(() => socket.connect());
onBeforeUnmount(() => {
  offSession();
  socket.dispose();
});
function send() {
  if (!text.value.trim()) return;
  try {
    socket.sendJson({ type: "chat.send", text: text.value });
    text.value = "";
    error.value = "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Send failed";
  }
}
</script>
<template>
  <section>
    <p role="status">
      {{ state.status }} (retries: {{ state.reconnectAttempt }})
    </p>
    <button @click="socket.connect()">Connect</button>
    <button @click="socket.disconnect()">Disconnect</button>
    <form @submit.prevent="send">
      <label>Message <input v-model="text" /></label>
      <button :disabled="state.status !== 'open' || !text.trim()">Send</button>
    </form>
    <p v-if="error || state.error" role="alert">
      {{ error || state.error?.message }}
    </p>
    <ul>
      <li v-for="(message, index) in messages" :key="index">{{ message }}</li>
    </ul>
  </section>
</template>
