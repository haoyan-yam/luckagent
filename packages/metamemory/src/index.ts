import { loadConfig } from './config.js';
import {
  parseArgs,
  cmdSearch,
  cmdGet,
  cmdPath,
  cmdList,
  cmdFolders,
  cmdCreate,
  cmdUpdate,
  cmdMkdir,
  cmdDelete,
  cmdShare,
  cmdHealth,
  cmdVisibility,
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
    process.stderr.write(`mm: ${(err as Error).message}\n`);
    process.exit(2);
  }
  try {
    switch (sub) {
      case 'search':
      case 's':
        await cmdSearch(cfg, args);
        break;
      case 'get':
      case 'g':
        await cmdGet(cfg, args);
        break;
      case 'path':
      case 'p':
        await cmdPath(cfg, args);
        break;
      case 'list':
      case 'ls':
        await cmdList(cfg, args);
        break;
      case 'folders':
      case 'f':
        await cmdFolders(cfg);
        break;
      case 'create':
      case 'c':
        await cmdCreate(cfg, args);
        break;
      case 'update':
      case 'u':
        await cmdUpdate(cfg, args);
        break;
      case 'mkdir':
      case 'md':
        await cmdMkdir(cfg, args);
        break;
      case 'delete':
      case 'rm':
        await cmdDelete(cfg, args);
        break;
      case 'share':
        await cmdShare(cfg, args);
        break;
      case 'health':
        await cmdHealth(cfg);
        break;
      case 'visibility':
      case 'vis':
        await cmdVisibility(cfg, args);
        break;
      default:
        process.stderr.write(`mm: unknown command '${sub}'\n`);
        printHelp();
        process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`mm: ${(err as Error).message}\n`);
    const exitCode = (err as { exitCode?: number }).exitCode;
    process.exit(typeof exitCode === 'number' ? exitCode : 1);
  }
}
