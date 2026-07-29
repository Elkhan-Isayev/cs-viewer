import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    host: true,
    port: 5180,
    fs: { allow: ['..'] }
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2048
  },
  worker: {
    format: 'es'
  }
})
