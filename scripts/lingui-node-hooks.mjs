import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const MACRO = /from\s+['"]@lingui\/(core|react)\/macro['"]/;
let transform;

// Files that import a Lingui macro come out as plain JS (types stripped, macros replaced); others load as usual.
export async function load(url, context, nextLoad) {
  if (!/^file:.*\.tsx?$/.test(url)) return nextLoad(url, context);
  const source = await readFile(fileURLToPath(url), 'utf8');
  if (!MACRO.test(source)) return nextLoad(url, context);
  transform ??= (await import('@lingui/native-tools')).transform;
  const { code } = await transform(source, basename(fileURLToPath(url)), { macro: { descriptorFields: 'all' } });
  return { format: 'module', source: code, shortCircuit: true };
}
