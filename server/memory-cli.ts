// npm run memoria:up | memoria:down | memoria:status — o mesmo que o botão do escritório, pelo terminal.

import type { MemoryStatus } from '../shared/types.ts';
import { windowsSteps } from '../shared/memory.ts';
import { memoryEvents, memoryStatus, startInstall, startUninstall } from './memory.ts';
import { isWindows } from './platform.ts';

const show = (st: MemoryStatus) => {
  const yes = (b: boolean) => (b ? 'sim' : 'não');
  console.log(`ai-memory ${st.version}`);
  console.log(`  servidor no ar (${st.url}): ${yes(st.running)}`);
  console.log(`  ligado ao Claude Code: hooks ${yes(st.hooks)}, MCP ${yes(st.mcp)}`);
  console.log(`  dados: ${st.dataDir}`);
};

async function main(cmd = 'status') {
  if (cmd === 'status') return show(await memoryStatus());
  if (cmd !== 'up' && cmd !== 'down') throw new Error('Use: memoria:up, memoria:down ou memoria:status');
  if (isWindows) {
    console.log('No Windows, rode no PowerShell:\n');
    console.log(windowsSteps());
    return;
  }
  if (cmd === 'up') console.log('Isto liga o ai-memory a TODAS as sessões do Claude Code nesta máquina (hooks e MCP globais).');
  let last = '';
  const done = new Promise<MemoryStatus>((resolve) => {
    memoryEvents.on('status', (st: MemoryStatus) => {
      if (st.job && st.job.step !== last) console.log(`• ${(last = st.job.step)}`);
      if (st.job?.done) resolve(st);
    });
  });
  if (cmd === 'up') startInstall();
  else startUninstall();
  const st = await done;
  if (st.job?.error) {
    console.error(`\n${st.job.error}\n\n${st.job.log.slice(-12).join('\n')}`);
    process.exitCode = 1;
  }
  show(st);
}

main(process.argv[2]).catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
