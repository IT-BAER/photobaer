#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, DEFAULT_URL, launch } from './server.ts';

const { values } = parseArgs({ options: { url: { type: 'string', default: DEFAULT_URL }, 'no-open': { type: 'boolean', default: false } } });
// --no-open leaves the browser closed; connect then reports the pairing URL to open by hand.
await createServer({ url: values.url, open: values['no-open'] ? null : launch }).connect(new StdioServerTransport());
// Agents on Windows often stop only the npx/cmd wrapper; a closed stdin means the agent is gone.
process.stdin.on('close', () => process.exit(0));
