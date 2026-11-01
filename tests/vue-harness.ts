import { createApp, type Component, type Plugin } from "vue";
export function mount(
  component: Component,
  options: { global: { plugins: Plugin[] } },
) {
  const element = document.createElement("div");
  document.body.append(element);
  const app = createApp(component);
  for (const plugin of options.global.plugins) app.use(plugin);
  app.mount(element);
  return {
    unmount() {
      app.unmount();
      element.remove();
    },
  };
}
