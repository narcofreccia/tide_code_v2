/** What the scripted agent says and does; shared by `fake-agent.ts` and the spec. */
export const EDIT_TRIGGER = "please edit hello.txt";
export const STREAM_CHUNKS = ["I will update ", "hello.txt for you."];
export const FINAL_TEXT = "Done: hello.txt now greets the e2e world.";
export const OLD_CONTENT = "hello\n";
export const NEW_CONTENT = "hello e2e world\n";
/** A prompt containing this is answered like any other, and reports `COST_PER_TURN` USD of spend. */
export const COST_TRIGGER = "please spend";
export const COST_PER_TURN = 0.5;
