// Tide runs TypeScript straight through Node's type stripping, which needs Node 22.13+.
// A friendlier failure than node's own "bad option: --experimental-strip-types".
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Tide needs Node 22.13 or newer; this shell runs ${process.versions.node}.`);
  console.error("One-time fix with nvm:  nvm alias default 22   (then open a new terminal)");
  console.error("Or for this shell only:  nvm use 22");
  process.exit(1);
}
