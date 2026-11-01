<script setup lang="ts">
import { useApiQuery, useApiMutation } from "universal-api-layer/vue";
const { data, isPending, error } = useApiQuery<
  { data: { id: number; name: string }[] },
  { id: number; name: string }[]
>({
  key: ["users"],
  url: "/users",
  select: (response) => response?.data ?? [],
});
const { mutate, error: mutationError } = useApiMutation({
  url: "/users",
  invalidateKeys: [["users"]],
});
</script>
<template>
  <section>
    <button @click="mutate({ name: 'Bahaa' })">Add user</button>
    <p v-if="isPending">Loading...</p>
    <p v-else-if="error">{{ error.message }}</p>
    <pre v-else>{{ data }}</pre>
    <pre v-if="mutationError">{{ mutationError.fieldErrors }}</pre>
  </section>
</template>
