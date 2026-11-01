import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// During development, requests to /api are forwarded to the Express server on port 4000,
// so the browser never needs to know the backend URL (and there are no CORS problems).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.VITE_PORT || 5173),
    strictPort: true,
    proxy: { '/api': process.env.API_TARGET || 'http://localhost:4000' }, // the browser tests point this at the test API
  },
});
