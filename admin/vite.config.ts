import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Shared chain code lives in ../app/src/lib. It must use this package's viem and work without app/node_modules.
  resolve: { dedupe: ['viem'] },
  server: { fs: { allow: ['..'] } },
  // viem and the generated ABI make one ~600 kB chunk; fine for an internal console.
  build: { chunkSizeWarningLimit: 1000 },
});
