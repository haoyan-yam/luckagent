export function print(): void {
  process.stdout.write(
    `luckagent — unified CLI for the luckagent-core ecosystem.

Usage: luckagent <subcommand> [args]

Subcommands:
  memory <cmd> [args]   shared knowledge / notes
                        e.g. luckagent memory search "auth" | luckagent memory health
  skills <cmd> [args]   skill registry (alias: skill)
                        e.g. luckagent skills list | luckagent skills install <name>
  agents <cmd> [args]   agent registry (address book for peer bots)
                        e.g. luckagent agents list | luckagent agents talk <peer>/<bot> <chatId> "<msg>"
  inbox <cmd> [args]    central inbox for CLI agents (no resident bridge needed)
                        e.g. luckagent inbox register | luckagent inbox poll --loop
  teams <cmd> [args]    Luckagent Agent Teams (local bridge)
                        e.g. luckagent teams dispatch demo worker "review PR" | luckagent teams next demo worker
  help                  this message (also --help, -h, or bare invocation)

Each subcommand has its own help; pass --help through to see it:
  luckagent memory --help
  luckagent skills --help
  luckagent agents --help
  luckagent inbox --help
  luckagent teams --help

Env:
  LUCKAGENT_CORE_URL              default http://localhost:9200
  LUCKAGENT_CORE_TOKEN            bearer token (or write to ~/.luckagent-core/token)
  LUCKAGENT_CORE_AGENT_BUS_URL    optional override of the agent-registry base URL (falls back to LUCKAGENT_CORE_URL)
`,
  );
}
