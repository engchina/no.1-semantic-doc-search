import { defineConfig } from 'vite'

export default defineConfig({
  base: '/ai/',  // 本番環境では/aiパスでホストされる
  server: {
    port: 5175,  // no.1-semantic-doc-searchは5175ポートを使用
    proxy: {
      '/ai/api': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ai\/api/, ''),  // /ai/api/config -> /config
      }
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  }
})
