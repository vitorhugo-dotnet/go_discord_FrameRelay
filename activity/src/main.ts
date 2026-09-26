import { DiscordSDK } from '@discord/embedded-app-sdk';
import { PublisherRouting } from './publisher-routing';
import './style.css';

const video = document.querySelector<HTMLVideoElement>('#screen')!;
const status = document.querySelector<HTMLElement>('#status')!;
const connect = document.querySelector<HTMLButtonElement>('#connect')!;
const play = document.querySelector<HTMLButtonElement>('#play')!;
const apiBase = import.meta.env.VITE_API_BASE || '/relay';
const applicationId = import.meta.env.VITE_DISCORD_APPLICATION_ID;
let sdk: DiscordSDK;
let socket: WebSocket | undefined;
let peer: RTCPeerConnection | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let identity: { accessToken: string; expiresAt: string } | undefined;

class UserError extends Error {}
const messages: Record<string, string> = {
 activity_instance_busy: 'This Activity is already watching another live share. Close it or wait for that share to end, then run /framerelay watch again.',
 session_full: 'This share has reached its viewer limit.',
 viewer_limit: 'This share has reached its viewer limit.',
 session_unavailable: 'The share has ended or is unavailable.',
 invalid_code: 'The share code is invalid or has ended.'
};
async function request<T>(path: string, body?: unknown, bearer?: string): Promise<T> {
 const response = await fetch(`${apiBase}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000), cache: 'no-store'
 });
 if (!response.ok) {
  const error = await response.json().catch(() => ({}));
  throw new UserError(messages[error.code] || 'Authorization or session admission failed. Run /framerelay watch again.');
 }
 return response.json();
}
function stop() {
 generation++;
 clearInterval(heartbeat); clearTimeout(timeout);
 if (socket) { socket.onclose = null; socket.onerror = null; socket.onmessage = null; socket.onopen = null; socket.close(); socket = undefined; }
 if (peer) { peer.onconnectionstatechange = null; peer.onicecandidate = null; peer.ontrack = null; peer.close(); peer = undefined; }
 video.onloadeddata = null;
 video.srcObject = null; play.hidden = true;
}
function fail(message: string) { stop(); status.textContent = message; connect.disabled = false; }
function codecs(kind: 'audio' | 'video', mime: string) {
 const supported = RTCRtpReceiver.getCapabilities(kind)?.codecs.filter(c => c.mimeType.toLowerCase() === mime) || [];
 if (!supported.length) throw new UserError(`Discord's browser does not support ${mime === 'video/h264' ? 'H.264 video' : 'Opus audio'}. Use the FrameRelay desktop viewer.`);
 return supported;
}
async function start() {
 stop(); connect.disabled = true;
 const current = generation;
 try {
  codecs('video', 'video/h264'); codecs('audio', 'audio/opus');
  status.textContent = 'Authorizing with Discord…';
  if (!identity || Date.parse(identity.expiresAt) <= Date.now() + 5000) {
   const { code } = await sdk.commands.authorize({ client_id: applicationId, response_type: 'code', state: crypto.randomUUID(), prompt: 'none', scope: ['identify'] });
   identity = await request('/api/discord/activity/authorize', { code, instanceId: sdk.instanceId });
  }
  if (current !== generation) return;
  status.textContent = 'Joining the shared screen…';
  const grant = await request<{ grant: string }>('/api/discord/activity/viewer-grants', undefined, identity!.accessToken);
  const admission = await request<{ sessionId: string; participantId: string; signalingToken: string; expiresAt: string; iceServers: RTCIceServer[] }>('/api/discord/activity/viewer-grants/redeem', { grant: grant.grant }, identity!.accessToken);
  if (current !== generation) return;
  const pc = peer = new RTCPeerConnection({ iceServers: admission.iceServers });
  const routing = new PublisherRouting();
  const candidates: RTCIceCandidateInit[] = [];
  const media = new MediaStream(); video.srcObject = media;
  video.onloadeddata = () => {
   if (current === generation && video.videoWidth > 0) { status.textContent = 'Watching'; clearTimeout(timeout); }
  };
  pc.ontrack = event => { media.addTrack(event.track); video.play().catch(() => { play.hidden = false; }); };
  const url = new URL(`${apiBase}/ws/signaling`, location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('sessionId', admission.sessionId);
  const ws = socket = new WebSocket(url, ['framerelay', `token.${admission.signalingToken}`]);
  const send = (type: string, payload: unknown, to = routing.publisher) => {
   if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, messageId: crypto.randomUUID(), sessionId: admission.sessionId, to, payload }));
  };
  pc.onicecandidate = event => { if (event.candidate && routing.publisher) send('webrtc.ice_candidate', event.candidate.toJSON()); };
  pc.onconnectionstatechange = () => {
   if (pc.connectionState === 'connected' && video.videoWidth === 0) status.textContent = 'Connected; waiting for decoded video…';
   if (pc.connectionState === 'failed') fail('Media connection failed. Check the publisher connection or TURN configuration, then reconnect.');
  };
  let sequence = Promise.resolve();
  ws.onmessage = event => {
   sequence = sequence.then(async () => {
    if (current !== generation) return;
    const incoming = JSON.parse(event.data);
    if (incoming.type === 'session.ended') { fail('The share has ended.'); return; }
    if (incoming.type === 'error') throw new UserError('Signaling admission or routing failed. Run /framerelay watch again.');
    for (const message of routing.accept(incoming)) {
    if (message.type === 'publisher.ready') { send('viewer.ready', {}); continue; }
    if (message.type === 'webrtc.offer') {
     const sdp = message.payload?.sdp;
     if (typeof sdp !== 'string' || !/H264\/90000/i.test(sdp) || !/opus\/48000/i.test(sdp)) throw new UserError('The publisher offer is incompatible with H.264 video and Opus audio.');
     await pc.setRemoteDescription({ type: 'offer', sdp });
     for (const transceiver of pc.getTransceivers()) {
      const kind = transceiver.receiver.track.kind as 'audio' | 'video';
      transceiver.setCodecPreferences(codecs(kind, kind === 'video' ? 'video/h264' : 'audio/opus'));
     }
     for (const candidate of candidates.splice(0)) await pc.addIceCandidate(candidate);
     const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
     send('webrtc.answer', { type: 'answer', sdp: answer.sdp });
    } else if (message.type === 'webrtc.ice_candidate' && typeof message.payload?.candidate === 'string') {
     const candidate = message.payload as RTCIceCandidateInit;
     if (pc.remoteDescription) await pc.addIceCandidate(candidate);
     else if (candidates.length < 64) candidates.push(candidate);
    }
    }
   }).catch(error => { if (current === generation) fail(error instanceof UserError ? error.message : 'WebRTC negotiation failed. Try the FrameRelay desktop viewer.'); });
  };
  ws.onopen = () => { heartbeat = setInterval(() => send('ping', {}), 15000); };
  ws.onerror = () => fail('Cannot connect to signaling. Check the Activity API URL mapping.');
  ws.onclose = () => fail('Disconnected or viewer authorization expired. Reconnect to continue.');
  timeout = setTimeout(() => fail('No playable media arrived. Check the publisher and TURN connection, then reconnect.'), 30000);
 } catch (error) {
  if (current === generation) { identity = undefined; fail(error instanceof UserError ? error.message : 'Discord authorization or connection failed. Run /framerelay watch again.'); }
 }
}
connect.onclick = () => void start();
play.onclick = () => video.play().then(() => { play.hidden = true; }).catch(() => { status.textContent = 'Discord blocked playback. Try the play button again.'; });
window.addEventListener('pagehide', stop);
async function initialize() {
 try {
  if (!applicationId) throw new UserError('Activity application ID is not configured.');
  sdk = new DiscordSDK(applicationId); await sdk.ready();
  // SDK context is submitted only through OAuth/instance authorization. The API
  // independently validates membership, channel and guild with Discord.
  if (!sdk.instanceId || !sdk.channelId || !sdk.guildId) throw new UserError('Launch this Activity from /framerelay watch in a server voice channel.');
  await start();
 } catch (error) { connect.disabled = true; status.textContent = error instanceof UserError ? error.message : 'This viewer must be opened inside Discord.'; }
}
void initialize();
