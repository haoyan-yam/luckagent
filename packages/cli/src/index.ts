/**
 * `luckagent` — unified entry point. Sole CLI binary; legacy `mm` / `mh` / `mb`
 * bins have all been removed. The implementations still live in
 * `@luckagent/metamemory` and `@luckagent/skill-hub` as workspace
 * libraries — `luckagent memory` and `luckagent skills` import their `main(argv)`
 * exports directly.
 *
 *   luckagent memory <…>   → @luckagent/metamemory  (former `mm`)
 *   luckagent skills <…>   → @luckagent/skill-hub   (former `mh`)
 *   luckagent agents <…>   → in-tree (./agents.js)
 *   luckagent inbox <…>    → in-tree (./inbox.js); wraps /api/inbox/*
 *   luckagent teams <…>    → in-tree (./teams.js); wraps local bridge /api/agent-teams/*
 *   luckagent help         → top-level help (also: bare invocation, --help, -h)
 */

export async function main(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    const { print } = await import('./help.js');
    print();
    return;
  }

  switch (sub) {
    case 'memory': {
      const m = await import('@luckagent/metamemory');
      await m.main(rest);
      return;
    }
    case 'skills':
    case 'skill': {
      const m = await import('@luckagent/skill-hub');
      await m.main(rest);
      return;
    }
    case 'agents': {
      const m = await import('./agents.js');
      await m.run(rest);
      return;
    }
    case 'inbox': {
      const m = await import('./inbox.js');
      await m.run(rest);
      return;
    }
    case 'teams': {
      const m = await import('./teams.js');
      await m.run(rest);
      return;
    }
    default: {
      process.stderr.write(`luckagent: unknown subcommand '${sub}'\n\n`);
      const { print } = await import('./help.js');
      print();
      process.exit(2);
    }
  }
}
