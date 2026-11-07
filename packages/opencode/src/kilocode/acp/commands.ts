import type { AvailableCommand } from "@agentclientprotocol/sdk"

// The ACP prompt handler runs /compact itself (session summarize), but it is not a command in
// the directory's command list, so clients never offered it in their slash-command menu.
const builtins: AvailableCommand[] = [
  { name: "compact", description: "Summarize the conversation so far to free up context" },
]

export function withBuiltinCommands(commands: readonly AvailableCommand[]): AvailableCommand[] {
  return [...commands, ...builtins.filter((builtin) => !commands.some((command) => command.name === builtin.name))]
}
