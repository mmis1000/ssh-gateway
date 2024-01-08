import { fileURLToPath } from 'url'
import { createServer as createViteServer } from '../app/node_modules/vite/dist/node/index.js'
import { resolve } from 'path'
import { Server } from 'http'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
export const createServer = (server: Server) => createViteServer({
  // any valid user config options, plus `mode` and `configFile`
  configFile: resolve(__dirname, '../app/vite.config.ts'),
  root: resolve(__dirname, '../app/'),
  server: {
    middlewareMode: true,
    hmr: {
      server
    }
  },
})