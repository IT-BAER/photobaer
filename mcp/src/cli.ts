#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, DEFAULT_URL, launch } from './server.ts';

const { values } = parseArgs({ options: { url: { type: 'string', default: DEFAULT_URL }, 'no-open': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } } });
if (values.help) {
  console.log(`Usage: photobaer-mcp [--url <url>] [--no-open]

MCP server over stdio that lets an agent edit images in a photobaer browser tab.

  --url <url>   photobaer page to pair with (default ${DEFAULT_URL})
  --no-open     do not open a browser; connect returns the pairing URL to open by hand
  -h, --help    show this help`);
  process.exit(0);
}
// --no-open leaves the browser closed; connect then reports the pairing URL to open by hand.
await createServer({ url: values.url, open: values['no-open'] ? null : launch }).connect(new StdioServerTransport());
// Agents on Windows often stop only the npx/cmd wrapper; a closed stdin means the agent is gone.
process.stdin.on('close', () => process.exit(0));
