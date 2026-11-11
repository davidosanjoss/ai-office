#!/usr/bin/env node
// Próxima versão do AI Office, para a release automática (.github/workflows/release.yml).
// A versão vem das tags do git (vX.Y.Z), não do package.json: a main só aceita mudanças por PR, e
// o workflow não pode gravar nela. Os PRs que entraram desde a última tag decidem o salto:
//   rótulo "versão-maior"          → X+1.0.0
//   branch feat/                   → X.Y+1.0
//   qualquer outra (fix/, infra/…) → X.Y.Z+1
// As tags antigas de dois números (v0.1, v0.2) contam como v0.1.0 e v0.2.0.
//
// Uso: node scripts/versao.mjs <última tag> <branch:rótulo1,rótulo2> [mais PRs...]  → imprime vX.Y.Z

/** "v0.2" ou "v0.18.3" → [0, 2, 0]. Tag que não é versão: undefined. */
export function parseTag(tag) {
  const m = /^v(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(tag ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

/** A maior versão entre as tags (as que não são versão ficam de fora). */
export function latestTag(tags) {
  const versions = tags.map((t) => [t, parseTag(t)]).filter(([, v]) => v);
  versions.sort(([, a], [, b]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return versions.at(-1)?.[0];
}

/** O salto que um PR pede, pela branch e pelos rótulos. */
export function bumpOf(pr) {
  if ((pr.labels ?? []).includes('versão-maior')) return 'major';
  if (/^feat\//.test(pr.branch ?? '')) return 'minor';
  return 'patch';
}

/** Próxima versão a partir da última tag e dos PRs que entraram (o maior salto vence). */
export function nextVersion(lastTag, prs) {
  const [x, y, z] = parseTag(lastTag) ?? [0, 0, 0];
  const bumps = prs.map(bumpOf);
  if (bumps.includes('major')) return `v${x + 1}.0.0`;
  if (bumps.includes('minor')) return `v${x}.${y + 1}.0`;
  return `v${x}.${y}.${z + 1}`;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('versao.mjs')) {
  const [last, ...rest] = process.argv.slice(2);
  if (last !== undefined) {
    const prs = rest.map((a) => {
      const [branch, labels = ''] = a.split(':');
      return { branch, labels: labels.split(',').filter(Boolean) };
    });
    process.stdout.write(nextVersion(last, prs.length ? prs : [{ branch: '' }]) + '\n');
  }
}
