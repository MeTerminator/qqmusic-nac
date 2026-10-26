import workletURL from './audio-worklet.ts?worker&url';
import type { AudioInfo, PCMChunk, PlaybackCommand, PlaybackState } from './types';

/** UI 侧 Web Audio 桥接；缓存和采样位置由音频线程维护。 */
export class StreamPlayer {
  private context: AudioContext | null = null;
  private ready: Promise<AudioWorkletNode> | null = null;
  private node: AudioWorkletNode | null = null;
  private fileId = 0;
  private revision = 0;
  private volume = 1;
  onState: (state: PlaybackState) => void = () => {};
  onError: (error: unknown) => void = () => {};

  /** 必须在选择文件、拖放或播放按钮的用户手势内调用 resume。 */
  unlock(): Promise<void> {
    // 已验证的 NAC 模型使用 44.1 kHz，交由浏览器音频后端适配声卡，
    // 避免常见的 48 kHz 设备让每个样本都经过额外的线性插值。
    this.context ??= new AudioContext({ sampleRate: 44100 });
    const resumed = this.context.resume();
    if (!this.ready) {
      const context = this.context;
      this.ready = context.audioWorklet.addModule(workletURL).then(() => {
        const node = new AudioWorkletNode(context, 'nac-audio', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        node.port.onmessage = ({ data }: MessageEvent<PlaybackState>) => {
          if (data.fileId === this.fileId && data.revision >= this.revision) this.onState(data);
        };
        node.connect(context.destination);
        this.node = node;
        node.port.postMessage({ type: 'volume', value: this.volume } satisfies PlaybackCommand);
        return node;
      });
    }
    return Promise.all([resumed, this.ready]).then(() => {});
  }

  private async send(message: PlaybackCommand, transfer: Transferable[] = []): Promise<void> {
    if (!this.ready) return;
    try {
      const node = await this.ready;
      if ('fileId' in message && message.fileId !== this.fileId) return;
      node.port.postMessage(message, transfer);
    } catch (error) {
      this.onError(error);
    }
  }

  clear(fileId: number): void {
    this.fileId = fileId;
    this.revision = 0;
    void this.send({ type: 'clear', fileId });
  }

  configure(fileId: number, info: AudioInfo, autoplay = true): void {
    this.fileId = fileId;
    this.revision = 0;
    void this.send({ type: 'configure', fileId, info });
    if (autoplay) void this.send({ type: 'play', fileId });
  }

  addChunk(fileId: number, chunk: PCMChunk): void {
    // 主线程保留一份缓存供最终下载，音频线程使用独立缓冲区。
    const copy: PCMChunk = {
      ...chunk,
      channels: [chunk.channels[0].slice(), chunk.channels[1].slice()],
    };
    void this.send(
      { type: 'chunk', fileId, chunk: copy },
      copy.channels.map((channel) => channel.buffer),
    );
  }

  async play(): Promise<void> {
    await this.unlock();
    await this.send({ type: 'play', fileId: this.fileId });
  }
  pause(): void {
    void this.send({ type: 'pause', fileId: this.fileId });
  }
  seek(sample: number): void {
    void this.send({ type: 'seek', fileId: this.fileId, sample, revision: ++this.revision });
  }
  setVolume(value: number): void {
    this.volume = value;
    void this.send({ type: 'volume', value });
  }
  dispose(): void {
    this.node?.disconnect();
    void this.context?.close();
  }
}
