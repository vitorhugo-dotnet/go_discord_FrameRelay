export interface Envelope {
 type: string;
 from?: string | null;
 payload?: Record<string, unknown>;
}

// Routed messages authenticate the sender ID only. The server's roster authenticates
// its role; no ready/offer/candidate can establish publisher authority itself.
export class PublisherRouting {
 publisher: string | undefined;
 private roles = new Map<string, string>();
 private pending: Envelope[] = [];

 accept(message: Envelope): Envelope[] {
  if (['session.joined', 'participant.capabilities', 'participant.reconnected'].includes(message.type)) {
   const id = message.payload?.participantId;
   const role = message.payload?.role;
   if (typeof id !== 'string' || typeof role !== 'string' || (message.from && message.from !== id)) return [];
   if (this.roles.size >= 256 && !this.roles.has(id)) return [];
   this.roles.set(id, role);
   if (role === 'publisher') {
    if (this.publisher && this.publisher !== id) throw new Error('Publisher changed');
    this.publisher = id;
   } else if (this.publisher === id) throw new Error('Publisher role revoked');
   const admitted = this.pending.filter(item => item.from === this.publisher);
   this.pending = this.pending.filter(item => !!item.from && !this.roles.has(item.from));
   return admitted;
  }
  if (!['publisher.ready', 'webrtc.offer', 'webrtc.ice_candidate'].includes(message.type) || !message.from) return [];
  if (message.from === this.publisher && this.roles.get(message.from) === 'publisher') return [message];
  if (!this.roles.has(message.from) && this.pending.length < 64) this.pending.push(message);
  return [];
 }
}
