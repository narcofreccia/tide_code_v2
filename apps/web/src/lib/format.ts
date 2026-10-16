/** `1 thread`, `2 threads`; pass `many` for irregular plurals. */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}
