import { createApp } from "vue";
import { createApiPlugin } from "universal-api-layer/vue";
import { client } from "./api";
import Example from "./ApiExample.vue";
createApp(Example).use(createApiPlugin({ client })).mount("#app");
