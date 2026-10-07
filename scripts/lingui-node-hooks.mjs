import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const MACRO = /from\s+['"]@lingui\/(core|react)\/macro['"]/;
let transform, oxc;

// Files that import a Lingui macro come out as plain JS (types stripped, macros replaced); .tsx also gets its JSX
// compiled (React automatic runtime); other .ts files load through Node's own type stripping.
export async function load(url, context, nextLoad) {
  if (!/^file:.*\.tsx?$/.test(url)) return nextLoad(url, context);
  const file = fileURLToPath(url), tsx = file.endsWith('.tsx');
  let code = await readFile(file, 'utf8');
  const macro = MACRO.test(code);
  if (!macro && !tsx) return nextLoad(url, context);
  if (macro) {
    transform ??= (await import('@lingui/native-tools')).transform;
    ({ code } = await transform(code, basename(file), { macro: { descriptorFields: 'all' } }));
  }
  if (tsx) {
    oxc ??= (await import('vite')).transformWithOxc;
    ({ code } = await oxc(code, file, { lang: macro ? 'jsx' : 'tsx', jsx: { runtime: 'automatic' } }));
  }
  return { format: 'module', source: code, shortCircuit: true };
}
