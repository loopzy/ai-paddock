import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PADDOCK_DASHBOARD_PORT ?? 3200),
    proxy: {
      '/api': process.env.PADDOCK_CONTROL_PLANE_URL ?? 'http://localhost:3100',
      '/ws': {
        target: (process.env.PADDOCK_CONTROL_PLANE_URL ?? 'http://localhost:3100').replace(/^http/i, 'ws'),
        ws: true,
      },
    },
  },
});
