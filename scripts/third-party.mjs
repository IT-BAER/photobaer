// Third-party license notices for everything shipped in the app: production npm packages, the Rust
// crates compiled into the wasm engine, and the bundled fonts.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const LICENSE_FILE = /^(licen[cs]e|copying|notice|ofl)/i;

function licenseTexts(dir) {
  return readdirSync(dir).filter(f => LICENSE_FILE.test(f)).sort()
    .map(f => readFileSync(join(dir, f), 'utf8').trim());
}

// pnpm keeps a package's dependencies as siblings of it, so walking up the tree finds them.
function resolveDir(name, from) {
  for (let d = from; d !== dirname(d); d = dirname(d)) {
    const c = join(d, 'node_modules', name);
    if (existsSync(join(c, 'package.json'))) return realpathSync(c);
  }
  throw new Error(`third-party: cannot resolve ${name} from ${from}`);
}

function npmPackages(root) {
  const seen = new Map();
  const walk = (name, from) => {
    const dir = resolveDir(name, from);
    if (seen.has(dir)) return;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    seen.set(dir, { name: pkg.name, version: pkg.version, license: pkg.license ?? 'see text', dir });
    for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dep, dir);
  };
  for (const dep of Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies ?? {})) walk(dep, root);
  return [...seen.values()];
}

function crates(root) {
  const out = execFileSync('cargo', ['metadata', '--format-version', '1', '--filter-platform', 'wasm32-unknown-unknown',
    '--manifest-path', join(root, 'engine/Cargo.toml')], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const meta = JSON.parse(out);
  const nodes = new Map(meta.resolve.nodes.map(n => [n.id, n]));
  const pkgs = new Map(meta.packages.map(p => [p.id, p]));
  const ids = new Set();
  // Normal dependencies only: build scripts and proc macros run at compile time and are not shipped.
  const walk = id => {
    if (ids.has(id) || pkgs.get(id).targets.some(t => t.kind.includes('proc-macro'))) return;
    ids.add(id);
    for (const d of nodes.get(id).deps) if (d.dep_kinds.some(k => k.kind === null)) walk(d.pkg);
  };
  walk(meta.resolve.root);
  return meta.packages.filter(p => ids.has(p.id) && p.id !== meta.resolve.root)
    .map(p => ({ name: p.name, version: p.version, license: p.license ?? 'see text', dir: dirname(p.manifest_path) }));
}

export function thirdPartyNotices(root) {
  const fonts = [
    { name: 'Noto Sans, Noto Sans Mono, Noto Serif', version: '', license: 'OFL-1.1', dir: join(root, 'app/public/fonts') },
    { name: 'Comfortaa', version: '', license: 'OFL-1.1', dir: join(root, 'app/src/assets/comfortaa') },
  ];
  const all = [...npmPackages(root), ...crates(root), ...fonts].sort((a, b) => a.name.localeCompare(b.name));
  const parts = all.map(p => {
    const texts = licenseTexts(p.dir);
    const head = `${p.name}${p.version ? ` ${p.version}` : ''} (${p.license})`;
    return `${head}\n${'-'.repeat(head.length)}\n\n${texts.length ? texts.join('\n\n') : `Licensed under ${p.license}.`}\n`;
  });
  return `photobaer third-party notices\n\nphotobaer includes the following third-party software and fonts. Each is listed with its license.\n\n${parts.join('\n\n')}`;
}
