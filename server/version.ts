// Versão do escritório em uso, para a barra de cima: a release do git (vX.Y.Z, criada a cada merge
// na main), com os commits depois dela e se a pasta tem mudanças; sem git, a do package.json.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface Version {
  /** "v0.19.0", ou "v0.19.0+3" (3 commits depois da release), com "*" se a pasta tem mudanças. */
  version: string;
  commit?: string;
  branch?: string;
}

/** `git describe` → versão curta: "v0.19.0-3-gabc1234-dirty" vira "v0.19.0+3*". */
export function fromDescribe(describe: string): string {
  const m = /^(v\d+\.\d+(?:\.\d+)?)(?:-(\d+)-g[0-9a-f]+)?(-dirty)?$/.exec(describe.trim());
  if (!m) return describe.trim();
  return `${m[1]}${m[2] ? `+${m[2]}` : ''}${m[3] ? '*' : ''}`;
}

let cached: Version | undefined;
export function officeVersion(root = ROOT): Version {
  if (cached && root === ROOT) return cached;
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  let v: Version;
  try {
    v = { version: fromDescribe(git('describe', '--tags', '--match', 'v*', '--dirty')), commit: git('rev-parse', '--short', 'HEAD') };
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    if (branch !== 'HEAD') v.branch = branch;
  } catch {
    let pkg = '?';
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    } catch {}
    v = { version: `v${pkg}` };
  }
  if (root === ROOT) cached = v;
  return v;
}
