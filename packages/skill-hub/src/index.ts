import { loadConfig } from './config.js';
import {
  parseArgs,
  cmdList,
  cmdSearch,
  cmdGet,
  cmdPublish,
  cmdInstall,
  cmdRemove,
  cmdHealth,
  printHelp,
} from './commands.js';

export async function main(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    printHelp();
    return;
  }
  const args = parseArgs(argv.slice(1));
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(`mh: ${(err as Error).message}\n`);
    process.exit(2);
  }
  try {
    switch (sub) {
      case 'list':
      case 'ls':
        await cmdList(cfg);
        break;
      case 'search':
      case 's':
        await cmdSearch(cfg, args);
        break;
      case 'get':
      case 'g':
        await cmdGet(cfg, args);
        break;
      case 'publish':
      case 'pub':
        await cmdPublish(cfg, args);
        break;
      case 'install':
      case 'i':
        await cmdInstall(cfg, args);
        break;
      case 'remove':
      case 'rm':
        await cmdRemove(cfg, args);
        break;
      case 'health':
        await cmdHealth(cfg);
        break;
      default:
        process.stderr.write(`mh: unknown command '${sub}'\n`);
        printHelp();
        process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`mh: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
