import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    // Vite's Host-header allowlist (anti DNS-rebinding) rejects requests
    // whose Host doesn't match localhost/configured names by default —
    // returns 403 to anything reached via a Docker Compose service name
    // (e.g. "frontend:5173", how the discovery agent's admin-container
    // route reaches this when it can't use "localhost"). Local-only dev
    // stack, not exposed beyond this machine — disabling the check is fine.
    allowedHosts: true,
  },
})
