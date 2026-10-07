// node --import hook: compiles Lingui macros in .ts/.tsx files for node --test, as the Vite plugin does in the app.
import { register } from 'node:module';

register('./lingui-node-hooks.mjs', import.meta.url);
