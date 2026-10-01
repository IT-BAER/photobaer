import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// On Windows the agent often stops only an npx/cmd wrapper, so the server must exit when its stdin closes.
test('the server exits when the agent closes stdin, even with the pairing listener open', async () => {
  const p = spawn(process.execPath, [fileURLToPath(new URL('./cli.ts', import.meta.url)), '--no-open'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const send = (m: object) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  let out = '';
  const seen = (id: number) => new Promise<void>(r => p.stdout.on('data', d => { out += d; if (out.includes(`"id":${id}`)) r(); }));
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await seen(1);
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/call', params: { name: 'connect', arguments: {} } });
  await seen(2);
  assert.match(out, /#agent=\d+\./);
  const exited = new Promise<number | null>(r => p.on('exit', r));
  p.stdin.end();
  const code = await Promise.race([exited, new Promise(r => setTimeout(() => r('timeout'), 3000))]);
  if (code === 'timeout') p.kill();
  assert.equal(code, 0);
});
