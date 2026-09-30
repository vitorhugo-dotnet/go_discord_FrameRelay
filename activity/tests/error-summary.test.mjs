import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeErrorSummary } from '../src/error-summary.ts';

test('preserves Discord RPC rejection code and message', () => {
 assert.equal(safeErrorSummary({ code: 4006, message: 'Not authenticated or invalid scope' }), 'Discord error 4006: Not authenticated or invalid scope');
});
test('redacts credentials before displaying a bounded error', () => {
 const result = safeErrorSummary(new Error('access_token=sensitive-access client_secret: "two words" Authorization: Bearer private code=oauth-code https://example.test/?token=hidden'));
 for (const value of ['sensitive-access', 'two words', 'private', 'oauth-code', 'hidden']) assert.ok(!result.includes(value), result);
 assert.ok(result.includes('[redacted]'));
 assert.ok(safeErrorSummary(new Error('x'.repeat(500))).length <= 230);
});
test('handles strings and unknown values without dumping object fields', () => {
 assert.equal(safeErrorSummary('Authorization denied'), 'Error: Authorization denied');
 for (const value of [undefined, null, {}, { access_token: 'private' }, 1]) assert.equal(safeErrorSummary(value), 'Unknown error');
});
