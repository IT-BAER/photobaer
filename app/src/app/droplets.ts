// File > Automate > Create Droplet: a .pbdroplet file holds an action (with the rest of its set, for conditional
// steps) and Batch options; opening one runs the batch on the images given with it or picked then.
import { t } from '@lingui/core/macro';
import '../i18n/index.ts'; // activates English before `t` runs outside the app (node tests)
import { fromJson, toJson, type Action, type ActionSet } from '../actions.ts';
import { cleanSet } from './actionsStore.ts';

export interface DropletOptions { dest: 'none' | 'folder' | 'download'; format: 'psd' | 'png' | 'jpeg'; errors: 'stop' | 'log' }
export const DROPLET_EXT = '.pbdroplet';
const TAG = 'photobaerDroplet';

export function dropletText(set: ActionSet, actionId: string, options: DropletOptions): string {
  const action = set.actions.find(a => a.id === actionId);
  if (!action) throw new Error(t`Select an action for the droplet.`);
  return toJson({ [TAG]: 1, action: action.name, set, options });
}

// The droplet's set gets new ids; options a droplet does not know fall back to Downloads, PNG, Stop for Errors.
export function readDroplet(text: string): { set: ActionSet; action: Action; options: DropletOptions } {
  const bad = () => new Error(t`This is not a photobaer droplet.`);
  let v: { [TAG]?: number; action?: string; set?: ActionSet; options?: Partial<DropletOptions> };
  try { v = fromJson(text); } catch { throw bad(); }
  const set = v?.[TAG] === 1 ? cleanSet(v.set) : null;
  const action = set?.actions.find(a => a.name === v.action);
  if (!set || !action) throw bad();
  const o = v.options ?? {};
  return {
    set, action,
    options: {
      dest: o.dest === 'none' || o.dest === 'folder' ? o.dest : 'download',
      format: o.format === 'psd' || o.format === 'jpeg' ? o.format : 'png',
      errors: o.errors === 'log' ? 'log' : 'stop',
    },
  };
}
