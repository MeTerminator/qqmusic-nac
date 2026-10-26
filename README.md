# NAC Web Player

纯浏览器 NAC 1.0 音乐播放器，使用 **TypeScript + Vite + ONNX Runtime WASM**。支持选择或拖入文件后自动播放、流式解码、后台全曲缓存、拖动优先解码、播放/暂停、音量调整与 WAV 导出。

音乐通过浏览器 File API 读取，模型在 Web Worker 中本地推理，文件不会上传。项目仅保留 Web 实现，不包含 Swift 应用或 Core ML 运行依赖。

## 启动

需要 Node.js 22.18 或更高版本（用于直接执行项目内的 TypeScript 工具脚本）。在项目根目录运行：

```sh
npm ci
npm run dev
```

打开 <http://127.0.0.1:8765>，选择 `.nac` 文件。通过 HTTP/HTTPS 访问页面，不能直接以 `file://` 打开 `index.html`。页面会预加载模型；首个音频片段解码后就自动开始播放，后台同时尽快完成整首歌。

## 构建和部署

```sh
npm run build
npm run preview
```

构建生成 `dist/`，包含页面、编译后的脚本、ONNX 模型和完整 WASM 运行时。可将整个目录部署到静态服务器，运行时不需要 Node.js、QQ 音乐或远程推理服务。

资源使用相对路径，支持子目录部署。静态服务器应将 `.wasm` 作为 `application/wasm` 提供，并保留 `vendor/` 中的文件名。当前使用单线程 WASM，不要求 SharedArrayBuffer、跨源隔离头或 WebGPU。音频通过 Web Audio / AudioWorklet 播放，需要浏览器支持 AudioWorklet；HTTPS 和 localhost 均可使用。

## 开发检查

```sh
npm run typecheck       # 严格 TypeScript 检查
npm run format          # 用 Prettier 格式化项目
npm run format:check    # 只检查格式，不改文件
npm test                # 单元测试与真实 WASM 回归测试
npm run check           # 格式、类型、测试和生产构建
```

Prettier 配置在 `.prettierrc.json`。项目自有代码使用 TypeScript，并开启 `strict`、未使用变量/参数检查与 switch 分支检查。第三方运行时保持原样，不参与格式化。依赖版本由 `package-lock.json` 锁定。

## 目录

```text
src/
  app.ts                界面、文件选择和资源生命周期
  worker.ts             模型预加载、后台任务和分块传输
  decode-queue.ts       跳转优先级、完成块去重和空洞补齐
  audio-worklet.ts      声卡线程的渲染入口
  pcm-playback.ts       PCM 缓存、随机访问与连续采样
  stream-player.ts      Web Audio 与界面之间的桥接
  inference.ts          ONNX/WASM 初始化、逐块推理和状态回传
  nac.ts                容器校验、索引解包、逆 FFT、合成与 WAV 编码
  types.ts              文件、PCM、Worker 消息等共享类型
  style.css             页面样式
public/
  models/nac.onnx        已转换的 ONNX 解码模型
  vendor/               同版本的 ORT JS/WASM 和第三方许可证
scripts/
  prepare-assets.ts     从锁定依赖同步浏览器运行时
tests/
  nac.test.ts           容器、CRC、索引排列、合成与 WAV 测试
  inference.test.ts     实际运行 WASM，与迁移前参考音频比较
  streaming.test.ts     分块提前输出、远距离跳转和取消恢复
  playback.test.ts      缓存空洞、暂停、连续重采样和消息隔离
  fixtures/             确定性合成 NAC 和对应参考 WAV
index.html              页面入口
vite.config.ts          Vite 开发和构建配置
FORMAT.md               NAC 1.0 格式分析
```

开发和构建前会自动运行 `prepare-assets.ts`，确保 ORT 胶水代码和 WASM 来自同一 npm 版本。模型保存在 `public/models/nac.onnx`；不是浏览器启动后从本机 QQ 音乐安装中提取的。

## 解码流程

1. 读取大端二进制文件头，验证版本、声道、模型参数与块长度。
2. 每块验证 CRC-32，再把低位优先的 10 位索引转为 `[channel, quantizer, time]` 张量。
3. WASM 模型逐块推理，同时回传六组卷积/残差状态。
4. 对频谱补 Nyquist 和共轭对称部分，做逆 FFT、Hann 加窗及重叠合成。
5. 去掉启动延迟，按二进制头声明的有效采样帧数裁剪，再交错编码为 float32 WAV。

这些步骤中的排列、状态和边界处理都在源码中附有注释。模型约 2.1 MB，WASM 核心约 11 MB；计算图和权重由 `.onnx` 保存，计算由 `.wasm` 执行。

## 流式播放和拖动

- 页面加载时预热 ONNX/WASM；选择或拖入文件时，在用户手势内解锁音频。
- 每个编码块完成后立即把 PCM 交给 AudioWorklet，不等待全曲 WAV。第一块约对应 0.14 秒有效音频，后续常规块约 0.19 秒（44.1 kHz）。
- 后台队列没有播放时钟限制，即使暂停，也会继续尽快解码剩余全部内容。完成率按唯一完成块计算。
- 拖到已缓存的位置直接播放；未缓存的位置提升为队列最高优先级，并从目标位置向后解码。之后继续补齐其他空洞。
- 当前模型有有限的卷积历史。随机跳转会先推理目标前的两个块，丢弃预热音频，用来恢复六组模型状态及合成重叠尾部。无需从歌曲开头一直解码到目标。
- AudioWorklet 遇到未缓存片段会保持采样位置并短暂等待，数据到达后继续。快速连续拖动用位置版本号屏蔽过期回报。
- 切换文件或取消任务时，在块边界结束旧推理，隔离旧消息并清空音频缓存；模型会话保留，供后续文件复用。
- 下载按钮在全部数据块校验和解码完成后启用，按采样偏移组装完整 WAV。

“立即播放”仍受首次模型加载、首块推理和音频设备启动时间影响；如果浏览器阻止自动播放，会提示点击播放。当前缓存全曲 PCM，主线程和音频线程各保留一份，长曲目仍会占用较多内存。

## 测试依据与限制

TypeScript 迁移使用三个块的确定性合成 NAC，参考 WAV 由迁移前的 JS + WASM 实现产生。当前 19 项测试已通过，并完成生产构建的浏览器解码验证。测试真实运行当前 ONNX/WASM 模型，比对全部 PCM 采样，并验证第二次解码不会继承上次的模型状态。测试数据的生成规则及模型 SHA-256 见 `tests/fixtures/README.md`。该基准用于检查迁移是否改变行为，不代表官方 QQ 音乐输出。

流式新增测试真实运行 24 块 WASM 推理：首块先送出，再请求第 22 块，输出顺序为 `0 → 22 → 23 → 1 …`，最后所有块完成且跳转 PCM 与顺序解码的最大误差低于 `1e-5`。还覆盖取消后会话复用、缓存不足时位置不前进、跨块恢复和旧 seek 版本隔离。

浏览器使用 1,024 块的合成样本验证：播放已推进且解码完成约 47% 时，跳到 2:32 可以优先恢复目标位置，随后后台补齐全曲并启用下载。最终构建另外验证了在 0:05 暂停时，后台从约 52% 继续解码到完成，播放位置保持不变。

此前提供的歌曲样本曾完成 44,100 Hz 双声道、186.944 秒全曲验证，浏览器解码约 13 秒。当前目录中已没有原始歌曲 NAC，因此这次迁移用合成基准复现测试，不把历史全曲验证算作本次重新运行的结果。

支持范围为当前模型对应的 NAC 1.0：双声道、22 级码本、10 位索引、每块 32 帧、FFT 512、hop 256。不支持 QMC 外层加密和未知 NAC 版本。手机及其他采样率尚未全面验证；NAC 是有损编码，导出 WAV 不代表恢复了压缩前的无损原音。

## 第三方材料

模型源自此前从用户提供的 QQ 音乐客户端中转换的解码权重，权利归原权利人。项目没有为这些权重重新授予许可。ONNX Runtime 使用其自身许可证，原文位于 `public/vendor/ONNX-RUNTIME-LICENSE.txt`。第三方文件不应被视为本项目自行编写的 TypeScript 代码。
