import { defineConfig } from 'vite'

/**
 * Library build: a single self-contained ES module that any site can import.
 *
 * The demo-decoding worker is inlined (`?worker&inline`) so the bundle works
 * when served from a different origin than the host page — a classic worker
 * URL would be blocked cross-origin.
 */
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist-lib',
    emptyOutDir: true,
    lib: {
      entry: 'src/embed/index.ts',
      name: 'CsViewer',
      formats: ['es', 'umd'],
      fileName: (format) => (format === 'es' ? 'cs-viewer.js' : 'cs-viewer.umd.cjs')
    },
    rollupOptions: {
      // three is bundled in: an embed should be one file to drop onto a page.
      output: { inlineDynamicImports: true }
    }
  }
})
