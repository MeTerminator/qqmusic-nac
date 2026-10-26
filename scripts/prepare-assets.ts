import { access, copyFile, mkdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const vendor = new URL('public/vendor/', root);
await mkdir(vendor, { recursive: true });

// JS 胶水代码与 WASM 必须来自同一个锁定版本，否则会出现 ABI 不兼容。
for (const name of [
  'ort.wasm.min.mjs',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
]) {
  await copyFile(new URL(`node_modules/onnxruntime-web/dist/${name}`, root), new URL(name, vendor));
}
// 模型和许可证保留在 public/ 中，构建工具会原样复制到 dist/。
await access(new URL('public/models/nac.onnx', root));
await access(new URL('public/vendor/ONNX-RUNTIME-LICENSE.txt', root));
console.log('Local ONNX model and WASM runtime are ready.');
