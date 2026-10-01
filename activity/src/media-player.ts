import { decodeConfiguration } from './media-protocol.ts';
import type { MediaMessage, MediaConfiguration } from './media-protocol.ts';
import { AudioPlayback } from './audio-playback.ts';

export class MediaPlayer {
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
 constructor(canvas: HTMLCanvasElement, requestKey: () => void, onFrame = () => {}, onError = (_error: Error) => {}) {
  this.canvas = canvas; this.requestKey = requestKey; this.onFrame = onFrame; this.onError = onError;
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
 private clearFrames() { for (const item of this.frames) { clearTimeout(item.timer); item.frame.close(); } this.frames = []; }
 private clearDecoders() {
  this.clearFrames();
  if (this.video && this.video.state !== 'closed') this.video.close(); this.video = undefined;
  if (this.audio && this.audio.state !== 'closed') this.audio.close(); this.audio = undefined;
  this.playback?.reset(); this.baseUs = undefined;
 }
 async accept(m: MediaMessage) {
  if (this.stopped || m.generation < this.generation) return;
  if (m.type === 1) {
   const config = decodeConfiguration(m.payload); const epoch = ++this.epoch;
   this.clearDecoders(); this.config = undefined; this.generation = m.generation; this.sequence = m.sequence; this.waitKey = true;
   const videoConfig = { codec: config.video.codec, codedWidth: config.video.width, codedHeight: config.video.height, optimizeForLatency: true };
   if (!(await VideoDecoder.isConfigSupported(videoConfig)).supported) throw new Error('This Discord browser cannot decode the publisher H.264 profile. Use the desktop viewer.');
   const audioConfig = config.audio ? { codec: 'opus', sampleRate: config.audio.sampleRate, numberOfChannels: config.audio.channels } : undefined;
   if (audioConfig && !(await AudioDecoder.isConfigSupported(audioConfig)).supported) throw new Error('This Discord browser cannot decode Opus audio. Use the desktop viewer.');
   if (epoch !== this.epoch || this.stopped) return;
   this.config = config; this.configureDecoders(config, epoch);
   return;
  }
  if (m.generation !== this.generation || !this.config || !this.video) { this.recover(); return; }
  if (m.sequence <= this.sequence) return;
  // Late admission starts from a freshly requested keyframe, whose sequence need not be 1.
  if (m.sequence !== this.sequence + 1 && !this.waitKey) this.recover();
  this.sequence = m.sequence;
  if (m.type === 2) {
   if (this.video.decodeQueueSize >= 8) { this.recover(); return; }
   if (this.waitKey && m.flags !== 1) return;
   if (m.flags === 1) this.waitKey = false;
   if (this.video.state !== 'configured') { this.recover(); return; }
   try { this.video.decode(new EncodedVideoChunk({ type: m.flags === 1 ? 'key' : 'delta', timestamp: m.timestampUs,
    duration: m.durationUs, data: m.payload.slice().buffer })); } catch { this.recover(); }
  } else if (m.type === 3 && !this.waitKey && this.audio) {
   if (this.audio.decodeQueueSize >= 32) { this.playback?.reset(); this.audio.reset();
    if (this.config.audio) this.audio.configure({ codec: 'opus', sampleRate: this.config.audio.sampleRate, numberOfChannels: this.config.audio.channels });
    return;
   }
   try { this.audio.decode(new EncodedAudioChunk({ type: 'key', timestamp: m.timestampUs, duration: m.durationUs, data: m.payload.slice().buffer })); }
   catch { this.recover(); }
  }
 }
 private configureDecoders(config: MediaConfiguration, epoch: number) {
  const videoConfig = { codec: config.video.codec, codedWidth: config.video.width, codedHeight: config.video.height, optimizeForLatency: true };
  const audioConfig = config.audio ? { codec: 'opus', sampleRate: config.audio.sampleRate, numberOfChannels: config.audio.channels } : undefined;
  this.canvas.width = config.video.width; this.canvas.height = config.video.height;
   this.video = new VideoDecoder({ output: frame => {
    if (epoch !== this.epoch || this.stopped) { frame.close(); return; }
    this.display(frame);
   }, error: () => { if (epoch === this.epoch) this.recover(); } });
   this.video.configure(videoConfig);
   if (audioConfig) {
    this.playback ??= new AudioPlayback();
    this.audio = new AudioDecoder({ output: data => {
     if (epoch !== this.epoch || this.stopped) { data.close(); return; }
     try { this.playback!.push(data, this.time(data.timestamp)); } catch (error) { this.onError(error as Error); }
    }, error: () => { if (epoch === this.epoch) this.recover(); } });
    this.audio.configure(audioConfig);
   }
   else { this.playback?.close(); this.playback = undefined; }
 }
 private display(frame: VideoFrame) {
  const when = this.time(frame.timestamp); const delay = when - this.now();
  if (delay < -0.15 || delay > 0.5 || this.frames.length >= 8) { frame.close(); if (delay > 0.5) this.recover(); return; }
  const item = { frame, timer: setTimeout(() => {
   this.frames = this.frames.filter(x => x !== item);
   try { if (!this.stopped && this.time(frame.timestamp) - this.now() >= -0.15) { this.canvas.getContext('2d')!.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height); this.onFrame(); } }
   finally { frame.close(); }
  }, Math.max(0, delay * 1000)) };
  this.frames.push(item);
 }
 recover() {
  if (this.stopped) return;
  this.waitKey = true;
  if (this.config) {
   const epoch = ++this.epoch; this.clearDecoders();
   try { this.configureDecoders(this.config, epoch); } catch (error) { this.onError(error as Error); }
  }
  if (performance.now() - this.lastRequest >= 1000) { this.lastRequest = performance.now(); this.requestKey(); }
 }
 async resumeAudio() { await this.playback?.resume(); this.baseUs = undefined; }
 get audioBlocked() { return !!this.playback && !this.playback.running; }
 stop() { this.stopped = true; this.epoch++; this.clearDecoders(); this.playback?.close(); this.playback = undefined; }
}
