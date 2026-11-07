// ACP client that makes the agent start a subagent which needs a bash permission.
// Usage: bun subagent-client.ts <opencode package dir> <session cwd> <native|plain>
const [pkg, cwd, mode] = process.argv.slice(2)
const native = mode === "native"
const proc = Bun.spawn(["bun", "run", "src/index.ts", "acp"], {
  cwd: pkg,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "ignore",
  env: { ...process.env, KILO_CONFIG_CONTENT: JSON.stringify({ permission: { bash: "ask" } }) },
})

let id = 0
const waiting = new Map<number, (v: any) => void>()
const send = (msg: object) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n")
const call = (method: string, params: object) =>
  new Promise<any>((resolve) => {
    const n = ++id
    waiting.set(n, resolve)
    send({ id: n, method, params })
  })

let root = ""
const log: string[] = []
const tag = (sessionId: string) => (sessionId === root ? "root" : `child:${sessionId.slice(-6)}`)
;(async () => {
  let buf = ""
  for await (const chunk of proc.stdout) {
    buf += new TextDecoder().decode(chunk)
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      if (msg.id !== undefined && waiting.has(msg.id) && !msg.method) {
        waiting.get(msg.id)!(msg)
        waiting.delete(msg.id)
      } else if (msg.method === "session/update") {
        const u = msg.params.update
        const kind = u.sessionUpdate
        if (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "usage_update") {
          log.push(`${tag(msg.params.sessionId)} ${kind}`)
        } else if (kind === "subagent_spawned") {
          log.push(`${tag(msg.params.sessionId)} subagent_spawned ${tag(u.subagentSessionId)} name="${u.name}"`)
        } else if (kind === "subagent_state_update") {
          log.push(`${tag(msg.params.sessionId)} subagent_state_update ${tag(u.subagentSessionId)} ${u.state}`)
        } else if (kind === "tool_call" || kind === "tool_call_update") {
          log.push(`${tag(msg.params.sessionId)} ${kind} ${u.title ?? ""} ${u.status ?? ""}`.trim())
        } else if (kind !== "available_commands_update") {
          log.push(`${tag(msg.params.sessionId)} ${kind}`)
        }
      } else if (msg.method === "session/request_permission") {
        log.push(`${tag(msg.params.sessionId)} PERMISSION ${msg.params.toolCall?.title ?? ""} -> allow once`)
        send({ id: msg.id, result: { outcome: { outcome: "selected", optionId: "once" } } })
      } else if (msg.id !== undefined && msg.method) {
        log.push(`${tag(msg.params?.sessionId ?? "")} ${msg.method} -> cancel`)
        send({ id: msg.id, result: { action: "cancel" } })
      }
    }
  }
})()

const capabilities = native
  ? {
      elicitation: { form: {} },
      _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } } },
    }
  : {}
const init = await call("initialize", { protocolVersion: 1, clientCapabilities: capabilities })
console.log("agent capabilities _meta:", JSON.stringify(init.result?.agentCapabilities?._meta ?? null))
const session = await call("session/new", { cwd, mcpServers: [] })
root = session.result?.sessionId
await Bun.sleep(1500)

const timer = setTimeout(() => {
  console.log("TIMEOUT: prompt did not finish in 180s (hang?)")
  for (const l of collapse(log)) console.log("  " + l)
  proc.kill()
  process.exit(1)
}, 180_000)
const res = await call("session/prompt", {
  sessionId: root,
  prompt: [
    {
      type: "text",
      text: 'Use the task tool exactly once with subagent_type "general" and description "Echo check". The subagent must run the bash command `echo subagent-ok` and report its output. Then reply with one word: done.',
    },
  ],
})
clearTimeout(timer)
console.log("stop:", res.result?.stopReason ?? JSON.stringify(res.error))
await Bun.sleep(1000)
for (const l of collapse(log)) console.log("  " + l)
proc.kill()
process.exit(0)

function collapse(lines: string[]) {
  const out: string[] = []
  for (const l of lines) {
    const last = out.at(-1)
    const m = last?.match(/^(.*) x(\d+)$/)
    if (last === l) out[out.length - 1] = `${l} x2`
    else if (m && m[1] === l) out[out.length - 1] = `${l} x${Number(m[2]) + 1}`
    else out.push(l)
  }
  return out
}
