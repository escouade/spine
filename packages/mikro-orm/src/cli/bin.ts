#!/usr/bin/env node
import { runCli } from "./bin-main";

// The thin entry: run the CLI and map its result to the process exit code — the ONLY place a migration
// outcome becomes an exit code (AD-5). `runCli` owns all logic and never throws (it catches and returns
// 1). We set `process.exitCode` rather than calling `process.exit(code)` so a piped stderr (CI) fully
// drains the actionable error before the process ends — `process.exit` can truncate it. The event loop
// is already empty here (the app graph was stopped and the connection closed), so the process exits
// naturally with this code.
void runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
