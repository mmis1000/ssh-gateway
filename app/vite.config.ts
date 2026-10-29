import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  base: '/app',
  build: {
    rolldownOptions: {
      // the inspector, and the file viewer that folder listings link to
      input: {
        main: 'index.html',
        view: 'view/index.html',
      },
    },
    // Monaco, only loaded by the viewer for text files
    chunkSizeWarningLimit: 3500,
  },
})
