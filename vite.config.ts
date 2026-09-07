import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split the heavy third-party code out of the app bundle so a code
        // change does not invalidate the vendor chunks in the operator's cache.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('write-excel-file') || id.includes('@expo/')) return 'xlsx'
          if (id.includes('@supabase')) return 'supabase'
          if (id.includes('papaparse')) return 'csv'
          if (id.includes('react') || id.includes('scheduler')) return 'vendor'
          return undefined
        },
      },
    },
  },
})
