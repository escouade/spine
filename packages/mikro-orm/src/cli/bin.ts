#!/usr/bin/env node
import { runCli } from "./bin-main";

// The thin entry: run the CLI and map its exit code to the process. `runCli` owns all logic and never
// throws (it catches and returns 1), so this is the ONLY place `process.exit` is called (AD-5).
void runCli(process.argv.slice(2)).then((code) => process.exit(code));
