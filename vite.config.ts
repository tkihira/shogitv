import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// HTTPS is required for SharedArrayBuffer outside of localhost (Safari especially is strict
// about secure contexts). basicSsl provides a self-signed cert; LAN clients have to accept
// the security warning once.
//
// `base` matches the GitHub Pages subpath (https://tkihira.github.io/shogitv/). Vite
// rewrites bundled URLs accordingly and exposes the value as `import.meta.env.BASE_URL`
// so runtime code can build same-origin worker / wasm URLs.
export default defineConfig({
  base: process.env.GH_PAGES ? "/shogitv/" : "/",
  plugins: [react(), basicSsl()],
  server: { host: true, headers: isolation },
  preview: { host: true, headers: isolation },
});
