/** What the scripted agent says and does; shared by `fake-agent.ts` and the spec. */
export const EDIT_TRIGGER = "please edit hello.txt";
export const STREAM_CHUNKS = ["I will update ", "hello.txt for you."];
export const FINAL_TEXT = "Done: hello.txt now greets the e2e world.";
export const OLD_CONTENT = "hello\n";
export const NEW_CONTENT = "hello e2e world\n";
/** A prompt containing this is answered like any other, and reports `COST_PER_TURN` USD of spend. */
export const COST_TRIGGER = "please spend";
export const COST_PER_TURN = 0.5;
/**
 * A prompt containing this streams a long turn at a steady pace: STREAM_THOUGHTS lines of reasoning
 * (the live reasoning body, a nested scroller), then a reply with a wide code block followed by
 * STREAM_PARAGRAPHS paragraphs, one chunk every STREAM_STEP_MS.
 */
export const LONG_TRIGGER = "please stream long";
export const STREAM_THOUGHTS = 40;
export const STREAM_PARAGRAPHS = 90;
export const STREAM_STEP_MS = 80;
export const THOUGHT_LINE = "thinking about the stream, step";
export const WIDE_CODE = `const wide = "${"x".repeat(400)}";`;
export const PARAGRAPH = "Streaming paragraph";
