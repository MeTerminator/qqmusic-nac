import './style.css';
import { blockForSample, encodeWAV } from './nac';
import { StreamPlayer } from './stream-player';
import { errorMessage } from './types';
import type { AudioInfo, DecodeRequest, DecodeResponse, PCMChunk, StereoChannels } from './types';

function element<T extends HTMLElement>(id: string, constructor: { new (): T }): T {
  const node = document.getElementById(id);
  if (!(node instanceof constructor)) throw Error(`页面缺少 ${id}`);
  return node;
}
const input = element('file', HTMLInputElement);
const zone = element('dropzone', HTMLDivElement);
const decoding = element('decoding', HTMLDivElement);
const progress = element('progress', HTMLProgressElement);
const download = element('download', HTMLButtonElement);
const cancel = element('cancel', HTMLButtonElement);
const choose = element('choose', HTMLButtonElement);
const play = element('play', HTMLButtonElement);
const seek = element('seek', HTMLInputElement);
const volume = element('volume', HTMLInputElement);
const text = (id: string, value: string): void => {
  element(id, HTMLElement).textContent = value;
};
const clock = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0')}`;

const player = new StreamPlayer();
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const send = (message: DecodeRequest, transfer: Transferable[] = []): void =>
  worker.postMessage(message, transfer);
// 模型预热与用户选文件并行，文件选择后只需等待第一个 PCM 块。
send({ type: 'prepare' });

let currentId = 0;
let currentName = '';
let currentURL: string | null = null;
let info: AudioInfo | null = null;
const chunks = new Map<number, PCMChunk>();
let finished = false;
let playing = false;
let waiting = false;
let scrubbing = false;
let lastRequestedBlock: number | null = null;
let fraction = 0;
let failed = false;
let autoplayBlocked = false;

function showStatus(message: string): void {
  decoding.hidden = false;
  text('status', message);
}
function refreshStatus(): void {
  if (failed || !info) return;
  if (autoplayBlocked) {
    showStatus('请点击播放以启用声音');
    return;
  }
  if (waiting) showStatus('正在缓冲所选位置…');
  else if (!finished) showStatus(playing ? '播放中，正在后台解码…' : '正在后台解码…');
  else decoding.hidden = true;
}

function prioritize(sample: number): void {
  if (!info || finished) return;
  const block = blockForSample(info, sample);
  if (!chunks.has(block) && lastRequestedBlock !== block) {
    lastRequestedBlock = block;
    send({ type: 'seek', fileId: currentId, sample });
  }
}

player.onError = (error) => {
  showStatus(`无法初始化音频播放器：${errorMessage(error)}`);
};

player.onState = (state) => {
  if (!info || state.fileId !== currentId) return;
  playing = state.playing;
  waiting = state.waiting;
  play.textContent = playing ? '暂停' : '播放';
  if (!scrubbing) seek.value = String(state.position / info.rate);
  text('time', `${clock(Number(seek.value))} / ${clock(info.duration)}`);
  // 线性插值可能正在等下一个块的第一个样本，因此优先检查 position + 1。
  if (waiting) prioritize(Math.min(info.samples - 1, state.position + 1));
  refreshStatus();
};

function fail(message: string): void {
  failed = true;
  player.clear(currentId);
  play.disabled = true;
  seek.disabled = true;
  download.disabled = true;
  showStatus(message);
  progress.hidden = true;
  text('percent', '');
  cancel.hidden = true;
  send({ type: 'cancel', fileId: currentId });
}

async function load(file?: File): Promise<void> {
  if (!file) return;
  send({ type: 'cancel', fileId: currentId });
  player.pause();
  const id = ++currentId;
  player.clear(id);
  currentName = file.name.replace(/\.nac$/i, '');
  if (currentURL) URL.revokeObjectURL(currentURL);
  currentURL = null;
  info = null;
  chunks.clear();
  finished = false;
  failed = false;
  autoplayBlocked = false;
  playing = false;
  waiting = false;
  fraction = 0;
  lastRequestedBlock = null;
  download.disabled = true;
  play.disabled = true;
  seek.disabled = true;
  seek.value = '0';
  text('track', currentName);
  text('detail', `${(file.size / 1024 / 1024).toFixed(2)} MB · 本地文件`);
  text('time', '0:00 / 0:00');
  showStatus('正在读取文件…');
  progress.value = 0;
  progress.hidden = false;
  text('percent', '');
  cancel.hidden = false;
  // resume 在用户手势内启动，不能等文件读取和模型推理完成后再解锁音频。
  void player.unlock().catch(() => {
    if (id === currentId) {
      autoplayBlocked = true;
      player.pause();
      play.textContent = '播放';
      showStatus('请点击播放以启用声音');
    }
  });
  try {
    const buffer = await file.arrayBuffer();
    if (id === currentId) send({ type: 'open', fileId: id, buffer }, [buffer]);
  } catch (error) {
    if (id === currentId) fail(errorMessage(error));
  }
}

worker.onerror = (event) => fail(event.message || '无法启动解码器，请通过 HTTP 服务打开页面');
worker.onmessage = ({ data }: MessageEvent<DecodeResponse>) => {
  if (data.type === 'ready') return;
  if (data.fileId !== currentId) return;
  try {
    switch (data.type) {
      case 'info':
        info = data.info;
        text('detail', `${info.rate.toLocaleString()} Hz · 双声道 · ${clock(info.duration)}`);
        seek.max = String(info.duration);
        seek.disabled = false;
        play.disabled = false;
        text('time', `0:00 / ${clock(info.duration)}`);
        player.configure(currentId, info, !autoplayBlocked);
        break;
      case 'status':
        showStatus(data.message);
        break;
      case 'chunk':
        chunks.set(data.chunk.block, data.chunk);
        player.addChunk(currentId, data.chunk);
        if (lastRequestedBlock === data.chunk.block) lastRequestedBlock = null;
        break;
      case 'progress':
        fraction = data.progress;
        progress.value = fraction;
        text('percent', `${Math.round(fraction * 100)}%`);
        refreshStatus();
        break;
      case 'complete':
        finished = true;
        cancel.hidden = true;
        download.disabled = false;
        refreshStatus();
        break;
      case 'error':
        fail(data.message);
        break;
    }
  } catch (error) {
    fail(errorMessage(error));
  }
};

choose.onclick = () => {
  // 文件对话框打开前先解锁，可避免异步 change 事件丢失浏览器的用户激活状态。
  void player.unlock().catch(() => {});
  input.click();
};
input.addEventListener('change', () => {
  void load(input.files?.[0]);
  input.value = '';
});
for (const name of ['dragenter', 'dragover'])
  zone.addEventListener(name, (event) => {
    event.preventDefault();
    zone.classList.add('drag');
  });
for (const name of ['dragleave', 'drop'])
  zone.addEventListener(name, (event) => {
    event.preventDefault();
    zone.classList.remove('drag');
  });
zone.addEventListener('drop', (event) => {
  void load(event.dataTransfer?.files[0]);
});

play.onclick = () => {
  if (playing) player.pause();
  else
    void player
      .play()
      .then(() => {
        autoplayBlocked = false;
        refreshStatus();
      })
      .catch((error) => showStatus(errorMessage(error)));
};
seek.addEventListener('pointerdown', () => {
  scrubbing = true;
});
window.addEventListener('pointerup', () => {
  scrubbing = false;
});
seek.addEventListener('input', () => {
  if (!info) return;
  const sample = Math.min(info.samples, Math.floor(Number(seek.value) * info.rate));
  player.seek(sample);
  prioritize(sample);
  text('time', `${clock(Number(seek.value))} / ${clock(info.duration)}`);
});
volume.addEventListener('input', () => player.setVolume(Number(volume.value)));
cancel.onclick = () => {
  send({ type: 'cancel', fileId: currentId });
  player.pause();
  currentId++;
  player.clear(currentId);
  info = null;
  chunks.clear();
  playing = false;
  waiting = false;
  play.disabled = true;
  seek.disabled = true;
  play.textContent = '播放';
  download.disabled = true;
  cancel.hidden = true;
  progress.hidden = true;
  text('percent', '');
  showStatus('解码已取消，请重新选择音乐');
};
download.onclick = () => {
  if (!info || !finished) return;
  try {
    // 下载只在全部块完成后生成；顺序由采样 offset 决定，不依赖消息到达顺序。
    const channels: StereoChannels = [
      new Float32Array(info.samples),
      new Float32Array(info.samples),
    ];
    for (const chunk of chunks.values())
      for (let ch = 0; ch < 2; ch++) channels[ch].set(chunk.channels[ch], chunk.offset);
    if (currentURL) URL.revokeObjectURL(currentURL);
    currentURL = URL.createObjectURL(
      new Blob([encodeWAV(channels, info.rate)], { type: 'audio/wav' }),
    );
    const anchor = document.createElement('a');
    anchor.href = currentURL;
    anchor.download = `${currentName}.wav`;
    anchor.click();
  } catch (error) {
    showStatus(errorMessage(error));
  }
};
window.addEventListener('beforeunload', () => {
  worker.terminate();
  player.dispose();
  if (currentURL) URL.revokeObjectURL(currentURL);
});
