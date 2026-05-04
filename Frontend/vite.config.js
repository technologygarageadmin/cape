import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('lightweight-charts')) return 'vendor-charts'
          if (id.includes('lucide-react'))       return 'vendor-icons'
          if (id.includes('node_modules'))       return 'vendor-react'
        },
      },
    },
  },
})
