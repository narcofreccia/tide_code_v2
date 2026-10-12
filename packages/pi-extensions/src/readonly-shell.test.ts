import { describe, expect, it } from "vitest";
import { classifyTool } from "./protocol.ts";
import { isReadOnlyShell, tokenize } from "./readonly-shell.ts";

const allowed = (command: string): void => {
  expect(isReadOnlyShell(command), command).toBe(true);
};
const denied = (command: string): void => {
  expect(isReadOnlyShell(command), command).toBe(false);
};

describe("plan-mode shell gate: research still runs", () => {
  it.each([
    "ls -la && cat package.json",
    "rg TODO src | head -20",
    "grep -rn '>' src", // a quoted > is a pattern, not a redirection
    'grep -n "a > b" notes.md',
    "find . -name '*.ts' -type f",
    "sed -n '1,40p' src/a.ts",
    "sed 's/foo/bar/g' a.txt",
    "awk '{ print $1 }' a.txt",
    "awk '$3 > 100 { n++ } END { print n }' data.csv",
    "git status",
    "git log --oneline -20",
    "git diff HEAD~1 -- src",
    "git branch",
    "git branch -a",
    "git branch --list 'feat/*'",
    "git branch --show-current",
    "git config --get user.name",
    "git config user.email",
    "git config --list --show-origin",
    "git remote -v",
    "git remote show origin",
    "git remote get-url origin",
    "env",
    "env LC_ALL=C sort a.txt",
    "ls 2>/dev/null",
    "cat a.txt 2>&1 | head",
    "wc -l < input.txt",
    "ls \\\n  -la",
  ])("%s", allowed);
});

describe("plan-mode shell gate: the holes are closed", () => {
  it.each([
    // sed in place, or writing / executing from the script
    "sed -i 's/a/b/' a.txt",
    "sed -i.bak 's/a/b/' a.txt",
    "sed -ni 's/a/b/p' a.txt",
    "sed --in-place 's/a/b/' a.txt",
    "sed 's/a/b/w out.txt' a.txt",
    "sed -n '/x/w out.txt' a.txt",
    "sed '1e rm -rf /' a.txt",
    "sed -f script.sed a.txt",
    // find that deletes or runs things
    "find . -name '*.log' -delete",
    "find . -exec rm {} \\;",
    "find . -execdir touch x \\;",
    "find . -ok rm {} \\;",
    "find . -fprint out.txt",
    // awk that shells out or writes
    "awk 'BEGIN { system(\"rm -rf build\") }'",
    "awk '{ print > \"out.txt\" }' a.txt",
    "awk '{ print | \"sh\" }' a.txt",
    "awk '{ \"date\" | getline d }' a.txt",
    "gawk -i inplace '{ print }' a.txt",
    "awk -f prog.awk a.txt",
    // env running a command
    "env rm -rf build",
    "env FOO=1 touch x",
    "env -S 'rm -rf build'",
    // git with mutating arguments
    "git branch new-feature",
    "git branch -D main",
    "git branch -m old new",
    "git branch --set-upstream-to=origin/main",
    "git config user.name 'Mallory'",
    "git config --unset user.name",
    "git config set user.name x",
    "git remote add evil https://x",
    "git remote set-url origin https://x",
    "git remote remove origin",
    "git log --output=out.txt",
    "git -c core.pager='rm -rf /' log",
    "git push",
    // tee and redirections
    "cat a.txt | tee b.txt",
    "echo hi > out.txt",
    "echo hi >> out.txt",
    "ls >| out.txt",
    "ls &> out.txt",
    "ls 2> errors.txt",
    "cat <<EOF\nx\nEOF",
    // substitutions and unknown programs
    "echo $(rm -rf /)",
    "echo `rm -rf /`",
    'echo "$(touch x)"',
    "cat <(rm x)",
    "sudo ls",
    "ls && npm publish",
    "ls; rm -rf build",
    "ls & rm -rf build",
    "FOO=1 ls",
    "sort -o out.txt a.txt",
    "uniq a.txt b.txt",
    "rg --pre ./evil.sh foo",
    "fd -x rm",
    "tail -f log.txt",
    "",
    "'unterminated",
  ])("%s", denied);
});

describe("tokenizer", () => {
  it("keeps quoted operators inside words and splits real ones", () => {
    expect(tokenize("grep '|' a | wc -l")).toEqual([
      { kind: "word", value: "grep" },
      { kind: "word", value: "|" },
      { kind: "word", value: "a" },
      { kind: "op", value: "|" },
      { kind: "word", value: "wc" },
      { kind: "word", value: "-l" },
    ]);
    expect(tokenize("ls 2>&1")).toEqual([
      { kind: "word", value: "ls" },
      { kind: "op", value: "2>&" },
      { kind: "word", value: "1" },
    ]);
  });
});

describe("tool classes for pi 1.x names", () => {
  it("accepts builtin:-prefixed names and the MCP resource tools", () => {
    expect(classifyTool("builtin:read")).toBe("read");
    expect(classifyTool("builtin:bash")).toBe("command");
    expect(classifyTool("read_mcp_resource")).toBe("read");
    expect(classifyTool("mcp__tide__board_post")).toBe("unknown");
  });
});
