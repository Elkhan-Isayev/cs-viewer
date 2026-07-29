import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    host: true,
    port: 5180,
    // The embedding example imports the built library from /dist-lib.
    fs: { allow: ['..'] }
  },
  publicDir: 'public',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2048
  },
  worker: {
    format: 'es'
  }
})
