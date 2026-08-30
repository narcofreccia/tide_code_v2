// Branded string ids. Generated server-side (ULID-like, sortable) so the
// event log orders naturally; clients never mint ids.
export type ProjectId = string & { readonly __brand: "ProjectId" };
export type ThreadId = string & { readonly __brand: "ThreadId" };
export type TurnId = string & { readonly __brand: "TurnId" };
export type ActivityId = string & { readonly __brand: "ActivityId" };
export type MessageId = string & { readonly __brand: "MessageId" };

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function encodeTime(t: number): string {
  let s = "";
  for (let i = 0; i < 10; i++) {
    s = ALPHABET[t % 32] + s;
    t = Math.floor(t / 32);
  }
  return s;
}
function randomPart(len: number, rnd: () => number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rnd() * 32)];
  return s;
}
/** ULID-shaped id: 10 time chars + 16 random chars. Injectable clock/rng for tests. */
export function newId(now: () => number = Date.now, rnd: () => number = Math.random): string {
  return encodeTime(now()) + randomPart(16, rnd);
}
