#!/usr/bin/env node
import { main } from "./main.js";

// Never call process.exit(): it cuts off buffered stdout on pipes (>64KB hook output) and kills the
// long-lived `mcp` stdio proxy. Set the exit code and let the event loop drain instead.
process.exitCode = await main(process.argv);
