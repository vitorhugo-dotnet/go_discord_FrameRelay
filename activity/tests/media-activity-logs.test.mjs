import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ActivityLogs } from '../src/activity-logs.ts';

test('keeps a bounded timestamped diagnostic history', () => {
 let now = 0; const logs = new ActivityLogs(2, () => new Date(1_800_000_000_000 + now++));
 logs.write('info', 'Activity ready'); logs.write('warn', 'media reconnecting'); logs.write('error', 'H.264 failed', 'EncodingError');
 assert.equal(logs.entries.length, 2); assert.match(logs.format(), /ERROR.*H.264 failed: EncodingError/);
 assert.match(logs.entries[0].timestamp, /^2027-/);
});

test('redacts bearer and credential fields from displayed diagnostics', () => {
 const logs = new ActivityLogs();
 logs.write('error', 'request failed', 'Bearer secret-value grant=abc123 access_token="oauth-secret" https://relay.invalid/ws?code=oauth-code');
 const formatted = logs.format();
 for (const secret of ['secret-value', 'abc123', 'oauth-secret', 'oauth-code']) assert.ok(!formatted.includes(secret));
 assert.match(formatted, /\[redacted\]/);
});

test('Activity provides an accessible in-app log panel and actions', async () => {
 const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
 assert.match(html, /id="view-logs"/); assert.match(html, /Ver logs/);
 assert.match(html, /<dialog[^>]+id="logs-dialog"/);
 assert.match(html, /id="logs-output"[^>]+aria-live="polite"/);
 assert.match(html, /id="copy-logs"/); assert.match(html, /id="clear-logs"/);
});
