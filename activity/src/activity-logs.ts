export type ActivityLogLevel = 'info' | 'warn' | 'error';
export interface ActivityLogEntry { timestamp: string; level: ActivityLogLevel; event: string; detail: string; }

const redact = (value: string) => value
 .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
 .replace(/\b(access_token|refresh_token|client_secret|authorization|token|grant|secret|code|state)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1=[redacted]')
 .replace(/([?&](?:access_token|refresh_token|client_secret|token|grant|code|state)=)[^&#\s]+/gi, '$1[redacted]')
 .replace(/\s+/g, ' ').slice(0, 180);

export class ActivityLogs {
 private items: ActivityLogEntry[] = [];
 private listeners = new Set<() => void>();
 private readonly capacity: number;
 private readonly clock: () => Date;
 constructor(capacity = 150, clock: () => Date = () => new Date()) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('Log capacity must be a positive integer.');
  this.capacity = capacity; this.clock = clock;
 }
 get entries(): readonly ActivityLogEntry[] { return this.items.slice(); }
 write(level: ActivityLogLevel, event: string, detail = '') {
  this.items.push({ timestamp: this.clock().toISOString(), level, event: redact(event), detail: redact(detail) });
  if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  for (const listener of this.listeners) listener();
 }
 clear() { this.items = []; for (const listener of this.listeners) listener(); }
 subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
 format() { return this.items.map(item => `${item.timestamp} [${item.level.toUpperCase()}] ${item.event}${item.detail ? `: ${item.detail}` : ''}`).join('\n'); }
}
