import { defineConfig } from 'vite';

export default defineConfig({
  // 相对资源路径便于将 dist 部署到任意静态站点子目录。
  base: './',
  // 运行时从 public/vendor/ 加载 WASM，避免 bundle 再嵌入一份重复二进制。
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm'] },
  worker: { format: 'es' },
  server: { host: '127.0.0.1', port: 8765 },
  preview: { host: '127.0.0.1', port: 8765 },
});
