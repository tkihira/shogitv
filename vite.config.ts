import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

// credentialless (not require-corp) so cross-origin fetches/EventSource to lishogi.org
// work without lishogi setting Cross-Origin-Resource-Policy on its responses.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

// HTTPS is required for SharedArrayBuffer outside of localhost (Safari especially is strict
// about secure contexts). basicSsl provides a self-signed cert; LAN clients have to accept
// the security warning once.
//
// Production is served from a single root (Vercel default subdomain), so base = "/". The
// runtime still uses `import.meta.env.BASE_URL` for worker / wasm URLs to stay portable.
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: { host: true, headers: isolation },
  preview: { host: true, headers: isolation },
});
