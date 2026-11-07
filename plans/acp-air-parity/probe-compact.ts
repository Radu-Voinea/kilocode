// Minimal ACP client: new session, one prompt, then /compact. Prints what the client sees.
// Usage: bun client.ts <opencode package dir> <session cwd>
const [pkg, cwd] = process.argv.slice(2)
const proc = Bun.spawn(["bun", "run", "src/index.ts", "acp"], {
  cwd: pkg,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "ignore",
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

let phase = "setup"
const seen: Record<string, string[]> = {}
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
      if (msg.id !== undefined && waiting.has(msg.id)) {
        waiting.get(msg.id)!(msg)
        waiting.delete(msg.id)
      } else if (msg.method === "session/update") {
        const u = msg.params.update
        const text = u.content?.text ?? ""
        const entry =
          u.sessionUpdate === "available_commands_update"
            ? `commands: ${u.availableCommands.map((c: any) => c.name).join(", ")}`
            : `${u.sessionUpdate}${text ? `: ${text.slice(0, 80).replace(/\n/g, " ")}` : ""}`
        ;(seen[phase] ??= []).push(entry)
      } else if (msg.id !== undefined && msg.method) {
        send({ id: msg.id, result: { outcome: { outcome: "cancelled" }, action: "cancel" } })
      }
    }
  }
})()

const init = await call("initialize", { protocolVersion: 1, clientCapabilities: {} })
console.log("agent:", JSON.stringify(init.result?.agentInfo))
const session = await call("session/new", { cwd, mcpServers: [] })
const sessionId = session.result?.sessionId
if (!sessionId) throw new Error("session/new failed: " + JSON.stringify(session.error))
await Bun.sleep(1500)

phase = "prompt"
const first = await call("session/prompt", {
  sessionId,
  prompt: [{ type: "text", text: "Reply with exactly: hello" }],
})
console.log("prompt stop:", first.result?.stopReason ?? JSON.stringify(first.error))

phase = "compact"
const compact = await call("session/prompt", { sessionId, prompt: [{ type: "text", text: "/compact" }] })
console.log("compact stop:", compact.result?.stopReason ?? JSON.stringify(compact.error))
await Bun.sleep(1000)

for (const [name, entries] of Object.entries(seen)) {
  const counts = new Map<string, number>()
  for (const e of entries) counts.set(e, (counts.get(e) ?? 0) + 1)
  console.log(`--- ${name}: ${entries.length} updates`)
  for (const [e, n] of [...counts].slice(0, 12)) console.log(`  ${n}x ${e}`)
}
proc.kill()
process.exit(0)
