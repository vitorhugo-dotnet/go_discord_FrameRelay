import { decodeMediaMessage, encodeMediaMessage, maxMessageSize } from './media-protocol.ts';
import type { MediaMessage } from './media-protocol.ts';
import type { MediaPlayer } from './media-player.ts';
import { safeErrorSummary } from './error-summary.ts';

export interface MediaAdmission { admissionId: string; sessionId: string; participantId: string; grant: string; expiresAt: string; mediaUrl: string; }
export class MediaDisconnectedError extends Error {}
export class MediaClient {
 private release: () => Promise<void>;
 private onFailure: (error: Error) => void;
 private socket: WebSocket | undefined;
 private player: MediaPlayer | undefined;
 private pending: MediaMessage[] = [];
 private bytes = 0;
 private draining = false;
 private closed = false;
 private generation = 1;
 private lastRequest = -Infinity;
 private releaseTask: Promise<void> | undefined;
 private detachAbort: (() => void) | undefined;
 private diagnostic: (level: 'info' | 'warn' | 'error', event: string, detail?: string) => void;
 constructor(release: () => Promise<void>, onFailure = (_error: Error) => {}, diagnostic = (_level: 'info' | 'warn' | 'error', _event: string, _detail = '') => {}) {
  this.release = release; this.onFailure = onFailure; this.diagnostic = diagnostic;
 }
 async connect(admission: MediaAdmission, player: MediaPlayer, signal: AbortSignal, path = '/media/ws/media'): Promise<void> {
  if (signal.aborted || this.closed) { await this.close(); throw new Error('Connection cancelled'); }
  this.player = player;
  // Use Discord URL Mapping instead of the direct desktop upload origin.
  const url = new URL(path, location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = this.socket = new WebSocket(url, 'framerelay-media-v1'); socket.binaryType = 'arraybuffer';
  this.diagnostic('info', 'Connecting to mapped media WebSocket');
  const abort = () => { void this.close(); }; signal.addEventListener('abort', abort, { once: true });
  this.detachAbort = () => signal.removeEventListener('abort', abort);
  socket.onmessage = event => {
   if (this.closed) return;
   try {
    if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > maxMessageSize) throw new Error('Invalid media WebSocket message');
    const message = decodeMediaMessage(new Uint8Array(event.data)); this.generation = Math.max(this.generation, message.generation);
    if (this.pending.length >= 64 || this.bytes + event.data.byteLength > 16 * 1024 * 1024) {
     this.pending = []; this.bytes = 0; player.recover(); this.requestKeyframe(); return;
    }
    this.pending.push(message); this.bytes += event.data.byteLength; void this.drain();
   } catch (error) { this.diagnostic('error', 'Invalid media WebSocket message', safeErrorSummary(error)); this.fail(error as Error); }
  };
  await new Promise<void>((resolve, reject) => {
   const cancelled = () => { clearTimeout(timer); reject(new Error('Connection cancelled')); };
   const timer = setTimeout(() => { signal.removeEventListener('abort', cancelled); reject(new Error('Media connection timed out')); }, 12000);
   signal.addEventListener('abort', cancelled, { once: true });
   socket.onopen = () => {
    clearTimeout(timer); signal.removeEventListener('abort', cancelled);
    if (this.closed) { reject(new Error('Connection cancelled')); return; }
    socket.send(JSON.stringify({ grant: admission.grant })); this.diagnostic('info', 'Media WebSocket connected'); resolve();
   };
   socket.onerror = () => { clearTimeout(timer); signal.removeEventListener('abort', cancelled); const error = new MediaDisconnectedError('Media WebSocket failed. Check the /media URL mapping.'); this.diagnostic('error', 'Media WebSocket error', safeErrorSummary(error)); reject(error); this.fail(error); };
   socket.onclose = () => { clearTimeout(timer); signal.removeEventListener('abort', cancelled); const error = new MediaDisconnectedError('Media disconnected or authorization expired. Reconnecting…'); this.diagnostic('warn', 'Media WebSocket closed', 'The relay or authorization closed the connection.'); reject(error); this.fail(error); };
  }).catch(async error => { await this.close(); throw error; });
 }
 private async drain() {
  if (this.draining) return; this.draining = true;
  try {
   while (!this.closed && this.pending.length) {
    const message = this.pending.shift()!; this.bytes -= message.payload.length + 40; await this.player!.accept(message);
   }
  } catch (error) { this.fail(error as Error); }
  finally { this.draining = false; }
 }
 requestKeyframe() {
  if (this.closed || this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 1024 || performance.now() - this.lastRequest < 1000) return;
  this.lastRequest = performance.now();
  this.socket.send(encodeMediaMessage({ type: 4, flags: 0, generation: this.generation, sequence: 0,
   timestampUs: 0, durationUs: 0, payload: new Uint8Array() }).slice().buffer);
 }
 private fail(error: Error) { if (this.closed) return; this.diagnostic('error', 'Media transport failed', safeErrorSummary(error)); void this.close(); this.onFailure(error); }
 close(): Promise<void> {
  this.closed = true; this.detachAbort?.(); this.detachAbort = undefined;
  if (this.socket) { this.socket.onclose = this.socket.onerror = this.socket.onmessage = this.socket.onopen = null; this.socket.close(); this.socket = undefined; }
  this.pending = []; this.bytes = 0; this.player?.stop();
  return this.releaseTask ??= this.release().catch(() => {});
 }
}
