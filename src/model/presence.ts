/**
 * The wire shape for an ephemeral agent-presence signal, broadcast over the same
 * /ws socket as change-sets but on a separate `presence` key (see
 * server/realtime.ts and src/client/realtime.ts). Presence is never persisted —
 * it only tells open tabs which cards to glow.
 *
 * Only 'looking' travels over the wire today: it is emitted by the read_cards
 * route (the one presence signal the server originates). "Doing" glows are
 * derived client-side from the change-sets already broadcast, so they need no
 * message of their own.
 */
export interface PresenceMessage {
  cardIds: string[]
  mode: 'looking'
}
