import test from 'node:test';
import assert from 'node:assert/strict';
import { systemInfo } from './systemInfo.ts';

test('system info lists version, browser, threads, GPU and isolation facts', async () => {
  const env = {
    navigator: {
      userAgent: 'UA/1', platform: 'Win32', language: 'de-DE', hardwareConcurrency: 8, deviceMemory: 8,
      userAgentData: { brands: [{ brand: 'Not A Brand', version: '99' }, { brand: 'Chromium', version: '150' }], platform: 'Windows' },
      gpu: { requestAdapter: async () => ({ info: { vendor: 'acme', architecture: 'rdna' }, limits: { maxTextureDimension2D: 16384, maxBufferSize: 2 ** 31 } }) },
      storage: { estimate: async () => ({ usage: 2 ** 20, quota: 2 ** 31 }), persisted: async () => true, getDirectory: () => {} },
    },
    screen: { width: 1920, height: 1080 }, devicePixelRatio: 1.5, crossOriginIsolated: true, SharedArrayBuffer,
  };
  const lines = await systemInfo('WebGPU', env as never);
  assert.match(lines[0], /^photobaer /);
  for (const want of ['Browser: Chromium 150', 'Platform: Windows', 'Logical processors: 8', 'Canvas renderer: WebGPU',
    'WebGPU adapter: acme rdna', 'WebGPU max texture size: 16384 px', 'Cross-origin isolated: yes', 'SharedArrayBuffer: yes',
    'Origin private file system: yes', 'File System Access: no', 'WebGL2: not available']) {
    assert.ok(lines.includes(want) || lines.some(l => l.startsWith(want)), `missing ${want}: ${lines.join(' | ')}`);
  }
  assert.ok(lines.some(l => l.startsWith('Storage used: 1 MB of 2 GB; persistent: yes')), lines.join(' | '));
});

test('system info without WebGPU says so', async () => {
  const lines = await systemInfo('WebGL2', { navigator: { userAgent: 'UA', language: 'en', hardwareConcurrency: 2 } } as never);
  assert.ok(lines.includes('WebGPU adapter: not available'));
  assert.ok(lines.includes('Cross-origin isolated: no'));
});
