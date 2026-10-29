import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [
        react()
    ],
    server: {
        port: 5173,
        proxy: {
            '/api': 'http://127.0.0.1:3000',
        }
    },
    build: {
        outDir: 'dist',
        // Phaser alone is ~1.2 MB; keep it in its own long-lived chunk.
        chunkSizeWarningLimit: 1300,
        rollupOptions: {
            output: {
                manualChunks: { phaser: ['phaser'], colyseus: ['colyseus.js'] }
            }
        }
    }
});
