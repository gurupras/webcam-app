import { defineConfig } from 'vite'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    sourcemap: true,
    minify: false,
    lib: {
      entry: path.resolve(__dirname, 'index.js'),
      name: 'WebcamApp',
      formats: ['es', 'cjs', 'umd'],
      fileName: 'webcam-app'
    }
  },
  optimizeDeps: {
    exclude: ['vue-demi']
  },
  test: {
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['html', 'text']
    },
    setupFiles: ['./test/testSetup.js']
  }
})
