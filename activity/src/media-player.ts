import { decodeConfiguration } from './media-protocol.ts';
import type { MediaMessage, MediaConfiguration } from './media-protocol.ts';
import { AudioPlayback } from './audio-playback.ts';

export class MediaPlayer {
 private configurations = 0;
 private videoPackets = 0;
 private audioPackets = 0;
 private decodedFrames = 0;
 private discardedFrames = 0;
 private decoderErrors = 0;
 private lastDecoderError = '';
 private canvas: HTMLCanvasElement;
 private requestKey: () => void;
 private onFrame: () => void;
 private onError: (error: Error) => void;
 video: VideoDecoder | undefined;
 private audio: AudioDecoder | undefined;
 private playback: AudioPlayback | undefined;
 private config: MediaConfiguration | undefined;
 private generation = 0;
 private sequence = 0;
 private epoch = 0;
 private waitKey = true;
 private stopped = false;
 private baseUs: number | undefined;
 private baseSeconds = 0;
 private audioClock = false;
 private lastRequest = -Infinity;
 private frames: { frame: VideoFrame; timer: ReturnType<typeof setTimeout> }[] = [];
 private firstVideoLogged = false;
 private firstDecodedLogged = false;
 private onDiagnostic: (level: 'info' | 'warn' | 'error', event: string, detail?: string) => void;
 constructor(canvas: HTMLCanvasElement, requestKey: () => void, onFrame = () => {}, onError = (_error: Error) => {},
  onDiagnostic: (level: 'info' | 'warn' | 'error', event: string, detail?: string) => void = () => {}) {
  this.canvas = canvas; this.requestKey = requestKey; this.onFrame = onFrame; this.onError = onError; this.onDiagnostic = onDiagnostic;
 }
 static checkAPIs() {
  if (typeof VideoDecoder !== 'function' || typeof AudioDecoder !== 'function' || typeof EncodedVideoChunk !== 'function'
   || typeof EncodedAudioChunk !== 'function' || typeof AudioContext !== 'function')
   throw new Error('Discord does not expose the required WebCodecs APIs. Use the FrameRelay desktop viewer.');
 }
 private now() { return this.playback?.running ? this.playback.context.currentTime : performance.now() / 1000; }
 private time(timestamp: number) {
  const audioClock = this.playback?.running ?? false;
  if (this.baseUs === undefined || audioClock !== this.audioClock) {
   this.baseUs = timestamp; this.baseSeconds = this.now() + 0.1; this.audioClock = audioClock;
  }
  return this.baseSeconds + (timestamp - this.baseUs) / 1000000;
 }
 private clearFrames(countAsDiscarded = false) {
  if (countAsDiscarded) this.discardedFrames += this.frames.length;
  for (const item of this.frames) { clearTimeout(item.timer); item.frame.close(); } this.frames = [];
 }
 private clearDecoders(countFramesAsDiscarded = false) {
  this.clearFrames(countFramesAsDiscarded);
  if (this.video && this.video.state !== 'closed') this.video.close(); this.video = undefined;
  if (this.audio && this.audio.state !== 'closed') this.audio.close(); this.audio = undefined;
  this.playback?.reset(); this.baseUs = undefined;
 }
 async accept(m: MediaMessage) {
  if (this.stopped || m.generation < this.generation) return;
  if (m.type === 1) this.configurations++;
  else if (m.type === 2) this.videoPackets++;
  else if (m.type === 3) this.audioPackets++;
  if (m.type === 1) {
   const config = decodeConfiguration(m.payload); const epoch = ++this.epoch;
   this.clearDecoders(); this.config = undefined; this.generation = m.generation; this.sequence = m.sequence; this.waitKey = true;
   const videoConfig = { codec: config.video.codec, codedWidth: config.video.width, codedHeight: config.video.height, optimizeForLatency: true };
   if (!(await VideoDecoder.isConfigSupported(videoConfig)).supported) throw new Error('This Discord browser cannot decode the publisher H.264 profile. Use the desktop viewer.');
   const audioConfig = config.audio ? { codec: 'opus', sampleRate: config.audio.sampleRate, numberOfChannels: config.audio.channels } : undefined;
   if (audioConfig && !(await AudioDecoder.isConfigSupported(audioConfig)).supported) throw new Error('This Discord browser cannot decode Opus audio. Use the desktop viewer.');
   if (epoch !== this.epoch || this.stopped) return;
   this.config = config; this.configureDecoders(config, epoch);
   this.onDiagnostic('info', 'Media configured', `${config.video.codec} ${config.video.width}x${config.video.height}; audio ${config.audio ? 'enabled' : 'disabled'}`);
   return;
  }
  if (m.generation !== this.generation || !this.config || !this.video) { this.recover(); return; }
  if (m.sequence <= this.sequence) return;
  // Late admission starts from a freshly requested keyframe, whose sequence need not be 1.
  if (m.sequence !== this.sequence + 1 && !this.waitKey) this.recover();
  this.sequence = m.sequence;
  if (m.type === 2) {
   if (!this.firstVideoLogged) { this.firstVideoLogged = true; this.onDiagnostic('info', 'First video packet received', `keyframe ${m.flags === 1 ? 'yes' : 'no'}`); }
   if (this.video.decodeQueueSize >= 8) { this.recover(); return; }
   if (this.waitKey && m.flags !== 1) return;
   if (m.flags === 1) this.waitKey = false;
   if (this.video.state !== 'configured') { this.recover(); return; }
   try { this.video.decode(new EncodedVideoChunk({ type: m.flags === 1 ? 'key' : 'delta', timestamp: m.timestampUs,
    duration: m.durationUs, data: m.payload.slice().buffer })); } catch (error) { this.recordDecoderError(error, "H.264"); this.recover(); }
  } else if (m.type === 3 && !this.waitKey && this.audio) {
   if (this.audio.decodeQueueSize >= 32) { this.playback?.reset(); this.audio.reset();
    if (this.config.audio) this.audio.configure({ codec: 'opus', sampleRate: this.config.audio.sampleRate, numberOfChannels: this.config.audio.channels });
    return;
   }
   try { this.audio.decode(new EncodedAudioChunk({ type: 'key', timestamp: m.timestampUs, duration: m.durationUs, data: m.payload.slice().buffer })); }
   catch (error) { this.recordDecoderError(error, "Opus"); this.recover(); }
  }
 }
 private configureDecoders(config: MediaConfiguration, epoch: number) {
  const videoConfig = { codec: config.video.codec, codedWidth: config.video.width, codedHeight: config.video.height, optimizeForLatency: true };
  const audioConfig = config.audio ? { codec: 'opus', sampleRate: config.audio.sampleRate, numberOfChannels: config.audio.channels } : undefined;
  this.canvas.width = config.video.width; this.canvas.height = config.video.height;
   this.video = new VideoDecoder({ output: frame => {
    if (epoch !== this.epoch || this.stopped) { frame.close(); return; }
    this.decodedFrames++; this.display(frame);
    if (!this.firstDecodedLogged) { this.firstDecodedLogged = true; this.onDiagnostic('info', 'First H.264 frame decoded'); }
   }, error: error => { if (epoch === this.epoch) { this.recordDecoderError(error, "H.264"); this.recover(); } } });
   this.video.configure(videoConfig);
   if (audioConfig) {
    this.playback ??= new AudioPlayback();
    this.audio = new AudioDecoder({ output: data => {
     if (epoch !== this.epoch || this.stopped) { data.close(); return; }
     try { this.playback!.push(data, this.time(data.timestamp)); } catch (error) { this.onError(error as Error); }
    }, error: error => { if (epoch === this.epoch) { this.recordDecoderError(error, "Opus"); this.recover(); } } });
    this.audio.configure(audioConfig);
   }
   else { this.playback?.close(); this.playback = undefined; }
 }
 private display(frame: VideoFrame) {
  const when = this.time(frame.timestamp); const delay = when - this.now();
  if (delay < -0.15 || delay > 0.5 || this.frames.length >= 8) {
   this.discardedFrames++; frame.close();
   if (this.discardedFrames === 1) this.onDiagnostic('warn', 'Decoded frame discarded', delay < -0.15 ? 'late' : delay > 0.5 ? 'too early' : 'playback queue full');
   if (delay > 0.5) this.recover(); return;
  }
  const item = { frame, timer: setTimeout(() => {
   this.frames = this.frames.filter(x => x !== item);
   try { if (!this.stopped && this.time(frame.timestamp) - this.now() >= -0.15) { this.canvas.getContext('2d')!.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height); this.onFrame(); } else this.discardedFrames++; }
   finally { frame.close(); }
  }, Math.max(0, delay * 1000)) };
  this.frames.push(item);
 }
 recover() {
  if (this.stopped) return;
  this.waitKey = true;
  if (this.config) {
   const epoch = ++this.epoch; this.clearDecoders(true);
   try { this.configureDecoders(this.config, epoch); } catch (error) { this.onError(error as Error); }
  }
  if (performance.now() - this.lastRequest >= 1000) { this.lastRequest = performance.now(); this.requestKey(); }
 }
 private recordDecoderError(error: unknown, codec: string) {
  this.decoderErrors++;
  const name = (error as { name?: unknown })?.name;
  const safeName = ['EncodingError', 'NotSupportedError', 'InvalidStateError', 'OperationError', 'DataError'].includes(String(name)) ? String(name) : 'DecoderError';
  this.lastDecoderError = `${codec} ${safeName}`;
  this.onDiagnostic('error', `${codec} decoder error`, safeName);
 }
 startupFailure(): string {
  if (!this.configurations) return 'No media configuration received. Check the publisher WebSocket output and relay.';
  if (!this.videoPackets) return `No video packets received after media configuration (${this.audioPackets} audio packets). Check publisher keyframe output.`;
  const failure = this.decoderErrors ? ` Decoder errors: ${this.decoderErrors}; last: ${this.lastDecoderError}.` : '';
  if (!this.decodedFrames) return `Media received ${this.videoPackets} video packets and ${this.audioPackets} audio packets, but H.264 decoding produced no frames.${failure}`;
  return `Media decoded ${this.decodedFrames} frames but playback did not render them (discarded ${this.discardedFrames}).${failure}`;
 }
 async resumeAudio() { await this.playback?.resume(); this.baseUs = undefined; }
 get audioBlocked() { return !!this.playback && !this.playback.running; }
 stop() { this.stopped = true; this.epoch++; this.clearDecoders(); this.playback?.close(); this.playback = undefined; }
}
