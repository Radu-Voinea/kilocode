import type { ClientCapabilities } from "@agentclientprotocol/sdk"

// `kilo acp` runs the Kilo server in the same process as its one ACP connection, so server code
// can ask what that client supports. Empty outside `kilo acp`.
const state = { forms: false }

export function setClient(capabilities: ClientCapabilities | undefined) {
  state.forms = !!capabilities?.elicitation?.form
}

/** Whether the ACP client answers question tool prompts as forms. */
export function clientForms() {
  return state.forms
}
