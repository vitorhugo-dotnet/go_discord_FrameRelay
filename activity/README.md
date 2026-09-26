# Discord Activity viewer

This HTTPS-hosted web client renders FrameRelay H.264 video and Opus audio inside Discord. Media travels directly between the publisher and the Activity, or through the API's configured TURN servers. The API only authorizes viewers and forwards signaling.

## Build and host

Use Node 22.12+ (or a Vite-supported newer Node). Copy `.env.example` to `.env.local` and set `VITE_DISCORD_APPLICATION_ID` to the same application ID used by the bot and API. These frontend settings are public. Leave `VITE_API_BASE=/relay` when using the URL mapping below. Never include bot tokens, API service bearers, device bearers or Discord client secrets in any `VITE_` variable.

```sh
npm ci
npm run build
```

Serve the generated `dist/` directory from a reachable HTTPS origin. The bot container does not serve this client. For development `npm run dev` starts Vite on loopback; use an HTTPS development tunnel and configure the corresponding URL mappings.

## Discord and API setup

1. In the same Discord application's Developer Portal, enable Activities/Embedded App support and configure the Activity launch URL.
2. Configure URL Mappings: `/` maps to the HTTPS frontend host; `/relay` maps to the HTTPS API host (the mapping removes that prefix before forwarding). The API mapping must cover both `/api/discord/activity/*` and `/ws/signaling`. HTTPS/WSS must work through Discord's proxy. A direct API origin is supported by `VITE_API_BASE`, but requires permitted Discord network mapping/CSP and API CORS for the Activity origin.
3. Configure API `RelayLaunch:DiscordClientId`, `DiscordClientSecret`, `DiscordBotToken`, optional `DiscordRedirectUri` and `ServiceToken`. The OAuth redirect URI, if configured, must match the application's allowed redirect and API exchange configuration. Keep Discord OAuth/client secrets on the API server. Apply the launch-capability/Activity-binding migrations documented by the API before enabling these routes.
4. Invite/register the bot and enable the Activity for the intended users/server in the Developer Portal. Run `/framerelay watch code:<live-code>` in the same voice-channel chat where the Activity opens. API validation binds the invoking user, guild, channel and one live session to the Activity instance. Launching an unrelated Activity without a pending watch intent does not authorize a stream.
5. Other participants join that Activity and authorize individually. An instance already watching a different live share shows an explicit busy state. Stop that share or close the old Activity before launching a different one.

## Authorization and signaling contract

The client calls `DiscordSDK.ready()` then SDK `authorize()` with `identify`. It submits `{code,instanceId}` to `POST /api/discord/activity/authorize`, which returns `{accessToken,userId,instanceId,expiresAt}`. That opaque bearer is FrameRelay-only; it is never passed to SDK `authenticate()` or stored on disk.

With that identity bearer the client calls `POST /api/discord/activity/viewer-grants` (no body), then `POST /api/discord/activity/viewer-grants/redeem {grant}`. Admission returns `{sessionId,participantId,signalingToken,expiresAt,iceServers}`. The WebSocket connects to `/ws/signaling?sessionId=...` using protocols `framerelay` and `token.<signalingToken>`; tokens do not go into the query string. Each reconnect obtains a fresh single-use grant and signaling token. The API validates current Discord membership; client SDK guild/channel IDs are context only.

Signaling envelopes use `{type,messageId,sessionId,to,payload}` and server-authenticated `from`. The client establishes the publisher role only from server roster messages (`session.joined`/`participant.capabilities`/`participant.reconnected` with `{participantId,role:"publisher"}`), never from a routed sender's `publisher.ready` claim. It holds up to 64 early routed messages until the server confirms the sender role and discards viewers' ready/offer/ICE messages. On authorized `publisher.ready`, it sends `viewer.ready`; `webrtc.offer` payload `{type:"offer",sdp}` is answered with `webrtc.answer {type:"answer",sdp}`. ICE payloads are `{candidate,sdpMid,sdpMLineIndex}`. The client also bounds early ICE to 64 entries and serializes SDP/ICE handling. H.264 and Opus capabilities are checked before admission and answer negotiation. No capture/microphone permission is requested.

## Playback and checks

The browser may require the **Play video and audio** button to satisfy autoplay restrictions. Reconnect is explicit after disconnection, session end or credential expiry. A 30-second timeout reports missing decoded video, including an audio-only connection. No tokens, SDP, ICE addresses or media are written to application logs.

The focused Go tests check API body/auth, callback order, invalid/missing intents, timeout fallback (including delayed gateway delivery) and definitive versus ambiguous Discord callback failures. `npm run test:routing` checks publisher-role admission and bounded buffering using Node's TypeScript stripping support (Node 22.15+). `npm run build` type-checks and builds the frontend. Real SDK authorization, Developer Portal launch callback acceptance, joining participants, decoded video/audio, autoplay and TURN transport still require a configured Discord application and live publisher. The web client uses native video-track RTCP feedback; it does not invent a target FPS from observed browser decode FPS for FrameRelay's optional receiver-statistics message.
