#!/usr/bin/env node
import { runMcpServer } from "./run.ts";

runMcpServer().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
