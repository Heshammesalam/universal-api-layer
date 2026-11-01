<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { client } from "./api";

// Backend contract: SSE data is { delta: string }, followed by data: [DONE].
const prompt = ref("");
const answer = ref("");
const error = ref("");
const streaming = ref(false);
let active: AbortController | undefined;
function stop() {
  active?.abort();
}
onBeforeUnmount(() => {
  stop();
  active = undefined;
});
async function send() {
  if (!prompt.value.trim()) return;
  stop();
  const controller = new AbortController();
  active = controller;
  answer.value = "";
  error.value = "";
  streaming.value = true;
  try {
    for await (const event of client.stream("/chat", {
      method: "POST",
      body: { message: prompt.value },
      format: "sse",
      signal: controller.signal,
      timeoutMs: 120_000,
    })) {
      if (active !== controller || controller.signal.aborted) break;
      if (event.data === "[DONE]") break;
      if (event.event === "error")
        throw new Error("The chat server reported an error.");
      const payload: unknown = JSON.parse(event.data);
      if (
        !payload ||
        typeof payload !== "object" ||
        !("delta" in payload) ||
        typeof payload.delta !== "string"
      )
        throw new Error("Invalid chat event.");
      answer.value += payload.delta;
    }
  } catch (cause) {
    if (active === controller && !controller.signal.aborted)
      error.value = cause instanceof Error ? cause.message : "Chat failed.";
  } finally {
    if (active === controller) {
      active = undefined;
      streaming.value = false;
    }
  }
}
</script>

<template>
  <form @submit.prevent="send">
    <label>Message <input v-model="prompt" :disabled="streaming" /></label>
    <button :disabled="streaming || !prompt.trim()">Send</button>
    <button type="button" :disabled="!streaming" @click="stop">Stop</button>
    <p role="status">{{ streaming ? "Receiving…" : "Ready" }}</p>
    <pre style="white-space: pre-wrap">{{ answer }}</pre>
    <p v-if="error" role="alert">{{ error }}</p>
  </form>
</template>
