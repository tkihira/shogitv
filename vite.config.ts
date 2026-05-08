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
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: { host: true, headers: isolation },
  preview: { host: true, headers: isolation },
});
