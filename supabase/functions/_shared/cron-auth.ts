// Who may call a scheduled function. Import-free, so the tests run this file.

/**
 * Whether a scheduled call carries the secret. A function with no secret set
 * refuses everyone, so a missing setting never opens it. Compared in full
 * either way, so the time taken says nothing about how close a guess was.
 */
export function cronAuthorized(sent: string | null, expected: string | undefined): boolean {
  if (!expected || !sent) return false;
  let differ = sent.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) {
    differ |= expected.charCodeAt(i) ^ (sent.charCodeAt(i) || 0);
  }
  return differ === 0;
}
