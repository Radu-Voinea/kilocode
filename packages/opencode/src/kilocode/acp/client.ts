import type { ClientCapabilities } from "@agentclientprotocol/sdk"
import { supports } from "./air"

// `kilo acp` runs the Kilo server in the same process as its one ACP connection, so server code
// can ask what that client supports. Empty outside `kilo acp`.
const state = { forms: false, tasks: false }

export function setClient(capabilities: ClientCapabilities | undefined) {
  state.forms = !!capabilities?.elicitation?.form
  state.tasks = supports(capabilities, "asyncTasks")
}

/** Whether the ACP client shows background work as Air async tasks it can stop. */
export function clientTasks() {
  return state.tasks
}

/** Whether the ACP client answers question tool prompts as forms. */
export function clientForms() {
  return state.forms
}
