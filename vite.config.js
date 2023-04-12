import { defineConfig } from 'vite'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    sourcemap: true,
    lib: {
      entry: path.resolve(__dirname, 'index.js'),
      name: 'WebcamApp',
      formats: ['es', 'cjs', 'umd'],
      fileName: 'webcam-app'
    },
    rollupOptions: {
      external: ['vue'],
      output: {
        globals: {
          vue: 'Vue'
        }
      }
    }
  },
  test: {
    environment: 'jsdom',
    coverage: {
      provider: 'c8',
      reporter: 'html'
    },
    setupFiles: ['./test/testSetup.js']
  }
})
