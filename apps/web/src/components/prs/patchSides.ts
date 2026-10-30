/**
 * Both sides of a file as far as its unified patch shows them: context and removed
 * lines on the left, context and added lines on the right, each hunk introduced by
 * the same `⋯ @@ … @@` line on both sides so Monaco keeps them aligned. A forge diff
 * has no full file contents, so this is what the PR's Files tab feeds `MonacoDiff`.
 */
export function patchSides(patch: string): { original: string; modified: string } {
  const original: string[] = [];
  const modified: string[] = [];
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      const marker = `⋯ ${line}`;
      original.push(marker);
      modified.push(marker);
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    if (line.startsWith("+")) modified.push(line.slice(1));
    else if (line.startsWith("-")) original.push(line.slice(1));
    else {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      original.push(text);
      modified.push(text);
    }
  }
  // a trailing newline in the patch yields one empty context line on both sides; drop it
  if (original.at(-1) === "" && modified.at(-1) === "") {
    original.pop();
    modified.pop();
  }
  return { original: original.join("\n"), modified: modified.join("\n") };
}
