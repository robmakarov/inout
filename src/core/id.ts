const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  let s = ''
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length]
  return `${prefix}_${s}`
}
