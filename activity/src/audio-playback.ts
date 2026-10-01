export class AudioPlayback {
 readonly context: AudioContext;
 private sources = new Set<AudioBufferSourceNode>();
 private lastEndUs: number | undefined;
 constructor() { this.context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' }); }
 get running() { return this.context.state === 'running'; }
 async resume() { await this.context.resume(); }
 push(data: AudioData, when: number) {
  try {
   if (!this.running || when < this.context.currentTime - 0.15) return;
   if (when > this.context.currentTime + 0.5 || this.sources.size >= 64) { this.reset(); return; }
   if (data.numberOfChannels < 1 || data.numberOfChannels > 2 || data.numberOfFrames > 5760 || data.sampleRate !== 48000)
    throw new Error('Invalid decoded audio');
   if (this.lastEndUs !== undefined && Math.abs(data.timestamp - this.lastEndUs) > 80000) this.reset();
   const buffer = this.context.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
   for (let planeIndex = 0; planeIndex < data.numberOfChannels; planeIndex++) {
    const samples = new Float32Array(data.numberOfFrames); data.copyTo(samples, { planeIndex, format: 'f32-planar' });
    buffer.copyToChannel(samples, planeIndex);
   }
   this.lastEndUs = data.timestamp + data.numberOfFrames / data.sampleRate * 1000000;
   const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
   this.sources.add(source); source.onended = () => { this.sources.delete(source); source.disconnect(); };
   source.start(Math.max(when, this.context.currentTime));
  } finally { data.close(); }
 }
 reset() {
  for (const source of this.sources) { source.onended = null; try { source.stop(); } catch { } source.disconnect(); }
  this.sources.clear(); this.lastEndUs = undefined;
 }
 close() { this.reset(); void this.context.close().catch(() => {}); }
}
