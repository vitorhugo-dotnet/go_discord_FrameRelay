import { DiscordSDK } from '@discord/embedded-app-sdk';
import { safeErrorSummary } from './error-summary';
import { MediaPlayer } from './media-player';
import { MediaClient, MediaDisconnectedError } from './media-client';
import type { MediaAdmission } from './media-client';
import './style.css';

const canvas = document.querySelector<HTMLCanvasElement>('#screen')!;
const status = document.querySelector<HTMLElement>('#status')!;
const connect = document.querySelector<HTMLButtonElement>('#connect')!;
const play = document.querySelector<HTMLButtonElement>('#play')!;
const apiBase = import.meta.env.VITE_API_BASE || '/relay';
const applicationId = import.meta.env.VITE_DISCORD_APPLICATION_ID;
let sdk: DiscordSDK;
let client: MediaClient | undefined;
let player: MediaPlayer | undefined;
let cancel: AbortController | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 1000;
let generation = 0;
let identity: { accessToken: string; expiresAt: string } | undefined;
class UserError extends Error {}
const messages: Record<string, string> = {
 activity_instance_busy: 'This Activity is already watching another live share. Close it or wait for that share to end, then run /framerelay watch again.',
 viewer_limit: 'This share has reached its viewer limit.', session_full: 'This share has reached its viewer limit.',
 session_unavailable: 'The share has ended or is unavailable.', feature_disabled: 'Discord media playback is disabled by the server.'
};
async function request<T>(path: string, body?: unknown, bearer?: string, signal?: AbortSignal): Promise<T> {
 const response = await fetch(`${apiBase}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json',
  ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000), cache: 'no-store' });
 if (!response.ok) {
  const error = await response.json().catch(() => ({}));
  if (messages[error.code]) throw new UserError(messages[error.code]);
  if (response.status === 404 && path.endsWith('/redeem')) throw new UserError('WebSocket playback is disabled by RelayControl. Use the desktop viewer.');
  if (response.status === 401) throw new UserError('The share ended or viewer authorization expired. Run /framerelay watch again.');
  throw new Error(`HTTP ${response.status}`);
 }
 return response.status === 204 ? undefined as T : response.json();
}
async function stop() {
 generation++; clearTimeout(timeout); clearTimeout(retry); cancel?.abort(); cancel = undefined;
 const old = client; client = undefined; player?.stop(); player = undefined; play.hidden = true;
 await old?.close();
}
function fail(message: string) { void stop(); status.textContent = message; connect.disabled = false; }
async function start() {
 await stop(); connect.disabled = true; const current = generation;
 const controller = cancel = new AbortController(); let stage = 'WebCodecs capability check';
 try {
  MediaPlayer.checkAPIs(); status.textContent = 'Authorizing with Discord…';
  if (!identity || Date.parse(identity.expiresAt) <= Date.now() + 5000) {
   stage = 'Discord authorization';
   const { code } = await sdk.commands.authorize({ client_id: applicationId, response_type: 'code', state: crypto.randomUUID(), prompt: 'none', scope: ['identify'] });
   if (current !== generation) return;
   stage = 'RelayControl identity exchange';
   identity = await request('/api/discord/activity/authorize', { code, instanceId: sdk.instanceId }, undefined, controller.signal);
  }
  if (current !== generation) return;
  const bearer = identity!.accessToken; stage = 'viewer grant'; status.textContent = 'Joining the shared screen…';
  const grant = await request<{ grant: string }>('/api/discord/activity/viewer-grants', undefined, bearer, controller.signal);
  stage = 'WebSocket media admission';
  const admission = await request<MediaAdmission>('/api/discord/activity/viewer-grants/redeem', { grant: grant.grant, transport: 'websocket' }, bearer, controller.signal);
  const release = async () => { await request(`/api/discord/activity/media-admissions/${admission.admissionId}/release`, undefined, bearer); };
  if (current !== generation) { await release().catch(() => {}); return; }
  let media: MediaClient;
  const view = player = new MediaPlayer(canvas, () => media?.requestKeyframe(), () => {
   if (current !== generation) return;
   status.textContent = 'Watching'; clearTimeout(timeout); retryDelay = 1000; play.hidden = !view.audioBlocked;
  }, error => { if (current === generation) fail(safeErrorSummary(error)); });
  media = client = new MediaClient(release, error => {
   if (current !== generation) return;
   fail(error.message);
   if (error instanceof MediaDisconnectedError) {
    retry = setTimeout(() => void start(), retryDelay); retryDelay = Math.min(30000, retryDelay * 2);
   }
  });
  stage = 'media WebSocket';
  await media.connect(admission, view, controller.signal);
  if (current !== generation) return;
  timeout = setTimeout(() => fail(view.startupFailure()), 30000);
 } catch (error) {
  if (current === generation) { identity = undefined; fail(error instanceof UserError ? error.message : `Failed during ${stage} (${safeErrorSummary(error)}). Run /framerelay watch again.`); }
 }
}
connect.onclick = () => void start();
play.onclick = () => { void player?.resumeAudio().then(() => { play.hidden = true; }).catch(() => { status.textContent = 'Discord blocked audio. Try the play button again.'; }); };
window.addEventListener('pagehide', () => void stop());
async function initialize() {
 try {
  if (!applicationId) throw new UserError('Activity application ID is not configured.');
  sdk = new DiscordSDK(applicationId); await sdk.ready();
  if (!sdk.instanceId || !sdk.channelId || !sdk.guildId) throw new UserError('Launch this Activity from /framerelay watch in a server voice channel.');
  await start();
 } catch (error) { connect.disabled = true; status.textContent = error instanceof UserError ? error.message : 'This viewer must be opened inside Discord.'; }
}
void initialize();
