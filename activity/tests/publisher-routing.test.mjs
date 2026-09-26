import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublisherRouting } from '../src/publisher-routing.ts';

const roster = (id, role, type = 'participant.capabilities') => ({ type, from: id, payload: { participantId: id, role } });
const routed = (id, type) => ({ type, from: id, payload: { sdp: 'untrusted', candidate: 'untrusted' } });

test('viewer ready, offer and ICE never establish publisher identity or reach negotiation', () => {
 const gate = new PublisherRouting();
 for (const type of ['publisher.ready', 'webrtc.offer', 'webrtc.ice_candidate']) assert.deepEqual(gate.accept(routed('viewer', type)), []);
 assert.equal(gate.publisher, undefined);
 assert.deepEqual(gate.accept(roster('viewer', 'viewer')), []);
 assert.deepEqual(gate.accept(roster('host', 'publisher')), []);
 for (const type of ['publisher.ready', 'webrtc.offer', 'webrtc.ice_candidate']) assert.deepEqual(gate.accept(routed('viewer', type)), []);
 assert.equal(gate.publisher, 'host');
});
test('early host messages wait for server role, then preserve order', () => {
 const gate = new PublisherRouting();
 const messages = ['publisher.ready', 'webrtc.ice_candidate', 'webrtc.offer'].map(type => routed('host', type));
 for (const message of messages) assert.deepEqual(gate.accept(message), []);
 assert.deepEqual(gate.accept(roster('host', 'publisher', 'session.joined')), messages);
 assert.deepEqual(gate.accept(routed('host', 'webrtc.offer')), [routed('host', 'webrtc.offer')]);
});
test('known viewer cannot claim authority in routed payload', () => {
 const gate = new PublisherRouting();
 gate.accept(roster('viewer', 'viewer'));
 assert.deepEqual(gate.accept({ ...routed('viewer', 'publisher.ready'), payload: { participantId:'viewer', role:'publisher' } }), []);
 assert.equal(gate.publisher, undefined);
});
test('mismatched roster sender is ignored and early-message buffering is bounded', () => {
 const gate = new PublisherRouting();
 assert.deepEqual(gate.accept({ ...roster('host','publisher'), from:'viewer' }), []);
 assert.equal(gate.publisher, undefined);
 for (let i=0;i<100;i++) gate.accept(routed('host','webrtc.ice_candidate'));
 assert.equal(gate.accept(roster('host','publisher')).length,64);
});
