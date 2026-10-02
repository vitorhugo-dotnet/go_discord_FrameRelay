import { DiscordSDK } from '@discord/embedded-app-sdk';
import { safeErrorSummary } from './error-summary';
import { ActivityLogs } from './activity-logs';
import type { ActivityLogLevel } from './activity-logs';
import { MediaPlayer } from './media-player';
import { MediaClient, MediaDisconnectedError } from './media-client';
import type { MediaAdmission } from './media-client';
import './style.css';

const canvas = document.querySelector<HTMLCanvasElement>('#screen')!;
const status = document.querySelector<HTMLElement>('#status')!;
const connect = document.querySelector<HTMLButtonElement>('#connect')!;
const play = document.querySelector<HTMLButtonElement>('#play')!;
const controls = document.querySelector<HTMLElement>('#controls')!;
const hideControls = document.querySelector<HTMLButtonElement>('#hide-controls')!;
const showControls = document.querySelector<HTMLButtonElement>('#show-controls')!;
const mute = document.querySelector<HTMLButtonElement>('#mute')!;
const volume = document.querySelector<HTMLInputElement>('#volume')!;
const viewLogs = document.querySelector<HTMLButtonElement>('#view-logs')!;
const logsDialog = document.querySelector<HTMLDialogElement>('#logs-dialog')!;
const logsOutput = document.querySelector<HTMLElement>('#logs-output')!;
const logsCopyStatus = document.querySelector<HTMLElement>('#logs-copy-status')!;
const activityLogs = new ActivityLogs();
const writeLog = (level: ActivityLogLevel, event: string, detail = '') => activityLogs.write(level, event, detail);
const renderLogs = () => { logsOutput.textContent = activityLogs.format() || 'Ainda não há eventos. Conecte a Activity para iniciar o diagnóstico.'; logsOutput.scrollTop = logsOutput.scrollHeight; };
activityLogs.subscribe(() => { if (logsDialog.open) renderLogs(); });
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
let volumeLevel = 1;
let muted = false;
window.addEventListener('error', event => writeLog('error', 'Uncaught Activity error', safeErrorSummary(event.error ?? event.message)));
window.addEventListener('unhandledrejection', event => writeLog('error', 'Unhandled Activity rejection', safeErrorSummary(event.reason)));
viewLogs.addEventListener('click', () => { renderLogs(); logsDialog.showModal(); viewLogs.setAttribute('aria-expanded', 'true'); });
logsDialog.addEventListener('close', () => viewLogs.setAttribute('aria-expanded', 'false'));
document.querySelector<HTMLButtonElement>('#close-logs')!.addEventListener('click', () => logsDialog.close());
document.querySelector<HTMLButtonElement>('#clear-logs')!.addEventListener('click', () => { activityLogs.clear(); writeLog('info', 'Diagnostic history cleared'); });
document.querySelector<HTMLButtonElement>('#copy-logs')!.addEventListener('click', () => {
 if (!navigator.clipboard?.writeText) { logsCopyStatus.textContent = 'Cópia indisponível; selecione o texto dos logs.'; return; }
 void navigator.clipboard.writeText(activityLogs.format()).then(() => { logsCopyStatus.textContent = 'Logs copiados.'; })
  .catch(() => { logsCopyStatus.textContent = 'Não foi possível copiar; selecione o texto dos logs.'; });
});
hideControls.addEventListener('click', () => { controls.hidden = true; showControls.hidden = false; });
showControls.addEventListener('click', () => { controls.hidden = false; showControls.hidden = true; });
mute.addEventListener('click', () => {
 muted = !muted;
 if (!muted && volumeLevel === 0) { volumeLevel = 0.5; volume.value = String(volumeLevel); }
 player?.setVolume(muted ? 0 : volumeLevel);
 mute.textContent = muted ? '🔇' : '🔊';
 mute.setAttribute('aria-label', muted ? 'Unmute audio' : 'Mute audio');
});
volume.addEventListener('input', () => {
 volumeLevel = Number(volume.value);
 muted = volumeLevel === 0;
 player?.setVolume(muted ? 0 : volumeLevel);
 mute.textContent = muted ? '🔇' : '🔊';
 mute.setAttribute('aria-label', muted ? 'Unmute audio' : 'Mute audio');
});
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
  writeLog('error', 'RelayControl request failed', `${path} returned HTTP ${response.status}`);
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
function fail(message: string) { writeLog('error', 'Activity playback failed', safeErrorSummary(message)); void stop(); status.textContent = message; connect.disabled = false; }
async function start() {
 await stop(); connect.disabled = true; const current = generation;
 const controller = cancel = new AbortController(); let stage = 'WebCodecs capability check';
 writeLog('info', 'Watch attempt started');
 try {
  MediaPlayer.checkAPIs(); status.textContent = 'Authorizing with Discord…';
  if (!identity || Date.parse(identity.expiresAt) <= Date.now() + 5000) {
   stage = 'Discord authorization'; writeLog('info', 'Requesting Discord Activity authorization');
   const { code } = await sdk.commands.authorize({ client_id: applicationId, response_type: 'code', state: crypto.randomUUID(), prompt: 'none', scope: ['identify'] });
   if (current !== generation) return;
   stage = 'RelayControl identity exchange'; writeLog('info', 'Exchanging Discord authorization with RelayControl');
   identity = await request('/api/discord/activity/authorize', { code, instanceId: sdk.instanceId }, undefined, controller.signal);
  }
  if (current !== generation) return;
  const bearer = identity!.accessToken; stage = 'viewer grant'; status.textContent = 'Joining the shared screen…'; writeLog('info', 'Requesting viewer grant');
  const grant = await request<{ grant: string }>('/api/discord/activity/viewer-grants', undefined, bearer, controller.signal);
  stage = 'WebSocket media admission'; writeLog('info', 'Requesting WebSocket media admission');
  const admission = await request<MediaAdmission>('/api/discord/activity/viewer-grants/redeem', { grant: grant.grant, transport: 'websocket' }, bearer, controller.signal);
  const release = async () => { await request(`/api/discord/activity/media-admissions/${admission.admissionId}/release`, undefined, bearer); };
  if (current !== generation) { await release().catch(() => {}); return; }
  let media: MediaClient;
  const view = player = new MediaPlayer(canvas, () => media?.requestKeyframe(), () => {
   if (current !== generation) return;
   if (status.textContent !== 'Watching') writeLog('info', 'First video frame presented');
   status.textContent = 'Watching'; clearTimeout(timeout); retryDelay = 1000; play.hidden = !view.audioBlocked;
  }, error => { if (current === generation) fail(safeErrorSummary(error)); },
  (level, event, detail) => writeLog(level, event, detail));
  view.setVolume(muted ? 0 : volumeLevel);
 media = client = new MediaClient(release, error => {
   if (current !== generation) return;
   fail(error.message);
   if (error instanceof MediaDisconnectedError) {
    retry = setTimeout(() => void start(), retryDelay); retryDelay = Math.min(30000, retryDelay * 2);
   }
  }, (level, event, detail) => writeLog(level, event, detail));
  stage = 'media WebSocket';
  await media.connect(admission, view, controller.signal);
  if (current !== generation) return;
  timeout = setTimeout(() => fail(view.startupFailure()), 30000);
 } catch (error) {
  if (current === generation) { identity = undefined; writeLog('error', 'Activity stage failed', `${stage}: ${safeErrorSummary(error)}`); fail(error instanceof UserError ? error.message : `Failed during ${stage} (${safeErrorSummary(error)}). Run /framerelay watch again.`); }
 }
}
connect.onclick = () => void start();
play.onclick = () => { void player?.resumeAudio().then(() => { play.hidden = true; }).catch(() => { status.textContent = 'Discord blocked audio. Try the play button again.'; }); };
window.addEventListener('pagehide', () => void stop());
async function initialize() {
 try {
  writeLog('info', 'Activity initialized');
  if (!applicationId) throw new UserError('Activity application ID is not configured.');
  sdk = new DiscordSDK(applicationId); await sdk.ready(); writeLog('info', 'Discord Embedded App SDK ready');
  if (!sdk.instanceId || !sdk.channelId || !sdk.guildId) throw new UserError('Launch this Activity from /framerelay watch in a server voice channel.');
  await start();
 } catch (error) { connect.disabled = true; status.textContent = error instanceof UserError ? error.message : 'This viewer must be opened inside Discord.'; }
}
void initialize();
