#!/usr/bin/env node
// GitHub CLI falso para os testes: anota a chamada e responde como o `gh pr create` real.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.AI_OFFICE_TMP, 'gh-calls.jsonl'), JSON.stringify({ args, cwd: process.cwd() }) + '\n');
const title = args[args.indexOf('--title') + 1] ?? '';
if (title.includes('JA-EXISTE')) {
  process.stderr.write('a pull request for branch "x" into branch "main" already exists:\nhttps://github.com/teste/repo/pull/3\n');
  process.exit(1);
}
if (title.includes('SEM-LOGIN')) {
  process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\n');
  process.exit(4);
}
process.stdout.write('https://github.com/teste/repo/pull/7\n');
