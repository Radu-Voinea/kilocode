// ACP client that starts the patched CLI as JetBrains Air would and runs one feature scenario,
// printing every update per session (repeated lines collapsed).
// Usage, from the repo root:
//   PATH=$HOME/.local/kilo-dev-bin:$PATH bun plans/acp-air-parity/probe.ts packages/opencode <scratch dir> <scenario> [plain]
// `plain` starts the client without Air's capabilities.
const [pkg, cwd, scenario, flavor] = process.argv.slice(2)
const air = flavor !== "plain"
const AIR_CAPABILITIES = [
  "sessionFailure",
  "recommendedValue",
  "nativeSubagentSessions",
  "asyncTasks",
  "backgroundSubagents",
  "agentFileChangeReport",
  "planFile",
  "diffPatch",
  "rawInputRendering",
  "planContentDelta",
  "modelProviderGroups",
  "loadReplayEnd",
  "sessionIndex",
]
const config = JSON.parse(process.env.PROBE_CONFIG ?? "{}")
const proc = Bun.spawn(["bun", "run", "src/index.ts", "acp"], {
  cwd: pkg,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "ignore",
  env: { ...process.env, KILO_CONFIG_CONTENT: JSON.stringify(config) },
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
// How the scenario answers a form elicitation; unset cancels it.
let answer: ((params: any) => Record<string, unknown>) | undefined
const log: string[] = []
const tag = (sessionId: string) => (!sessionId ? "-" : sessionId === root ? "root" : `ses:${sessionId.slice(-6)}`)
const short = (value: unknown, max = 300) => {
  const text = JSON.stringify(value) ?? "undefined"
  return text.length > max ? text.slice(0, max) + "…" : text
}
;(async () => {
  let buf = ""
  const decoder = new TextDecoder()
  for await (const chunk of proc.stdout) {
    buf += decoder.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const msg = (() => {
        try {
          return JSON.parse(line)
        } catch {
          log.push(`!! non-JSON stdout: ${line.slice(0, 300)}`)
        }
      })()
      if (!msg) continue
      if (msg.id !== undefined && waiting.has(msg.id) && !msg.method) {
        waiting.get(msg.id)!(msg)
        waiting.delete(msg.id)
        continue
      }
      if (msg.method === "session/update") {
        const u = msg.params.update
        const kind = u.sessionUpdate
        const who = tag(msg.params.sessionId)
        if (
          ["agent_message_chunk", "agent_thought_chunk", "usage_update", "available_commands_update"].includes(kind)
        ) {
          log.push(`${who} ${kind}`)
        } else if (kind === "tool_call" || kind === "tool_call_update") {
          log.push(`${who} ${kind} ${u.title ?? ""} ${u.status ?? ""}`.trim())
          if (process.env.PROBE_TOOLS && (u.content || u._meta)) {
            log.push(`${who}   content=${short(u.content, 600)} _meta=${short(u._meta, 600)}`)
          }
        } else {
          const { sessionUpdate: _, ...rest } = u
          log.push(`${who} ${kind} ${short(rest)}`)
        }
        continue
      }
      if (msg.method === "session/request_permission") {
        log.push(`${tag(msg.params.sessionId)} PERMISSION ${msg.params.toolCall?.title ?? ""} -> allow once`)
        send({ id: msg.id, result: { outcome: { outcome: "selected", optionId: "once" } } })
        continue
      }
      if (msg.method === "fs/write_text_file") {
        send({ id: msg.id, result: {} })
        continue
      }
      if (msg.method === "elicitation/create" && answer) {
        const content = answer(msg.params)
        log.push(`${tag(msg.params.sessionId)} elicitation "${msg.params.message}" -> ${short(content)}`)
        send({ id: msg.id, result: { action: "accept", content } })
        continue
      }
      if (msg.id !== undefined && msg.method) {
        log.push(`${tag(msg.params?.sessionId ?? "")} ${msg.method} -> cancel`)
        send({ id: msg.id, result: { action: "cancel" } })
        continue
      }
      if (msg.method) log.push(`notify ${msg.method} ${short(msg.params)}`)
    }
  }
})()

const capabilities = air
  ? { elicitation: { form: {} }, _meta: { jetbrains: { air: { version: 1, capabilities: AIR_CAPABILITIES } } } }
  : {}
const init = await call("initialize", { protocolVersion: 1, clientCapabilities: capabilities })
console.log("agent _meta:", JSON.stringify(init.result?.agentCapabilities?._meta ?? null))

const timer = setTimeout(() => {
  console.log("TIMEOUT after 300s")
  dump()
  proc.kill()
  process.exit(1)
}, 300_000)

const prompt = async (text: string, sessionId = root, meta?: object) => {
  const res = await call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text }],
    ...(meta ? { _meta: meta } : {}),
  })
  log.push(`== prompt done: ${res.result?.stopReason ?? short(res.error)}`)
  return res
}
const newSession = async (extra: object = {}) => {
  const res = await call("session/new", { cwd, mcpServers: [], ...extra })
  if (res.error) console.log("session/new error:", short(res.error))
  return res.result
}

const scenarios: Record<string, () => Promise<void>> = {
  async plan() {
    root = (await newSession()).sessionId
    await prompt(
      "Use the todowrite tool to create a 3-item todo list (items: alpha, beta, gamma). Then mark alpha in_progress, then completed, using todowrite each time. Do nothing else. Reply: done.",
    )
    log.push("== load session")
    await call("session/load", { sessionId: root, cwd, mcpServers: [] })
  },
}

scenarios.title = async () => {
  root = (await newSession()).sessionId
  await prompt(
    "I am planning a weekend trip to Paris with my family and want to visit museums. We like art, history and science, and the kids are eight and eleven years old, so the visit should not be too long or too quiet for them. In one short sentence: which museum in Paris is the most famous one, and why?",
  )
  await Bun.sleep(8000)
  const list = await call("session/list", { cwd })
  log.push(`== list: ${short(list.result?.sessions?.find((s: any) => s.sessionId === root))}`)
}

scenarios.mode = async () => {
  const created = await newSession()
  root = created.sessionId
  const modes = created.configOptions.find((o: any) => o.id === "mode")
  log.push(`== modes: ${modes.options.map((o: any) => o.value).join(",")} current=${modes.currentValue}`)
  await call("session/set_config_option", { sessionId: root, configId: "mode", value: "plan" })
  // Accept the first option of each question: the plan follow-up's first answer implements the plan.
  answer = (params) =>
    Object.fromEntries(
      Object.entries(params.requestedSchema.properties)
        .filter(([, field]: [string, any]) => field.oneOf)
        .map(([key, field]: [string, any]) => {
          log.push(`   options: ${field.oneOf.map((o: any) => o.const).join(" | ")}`)
          return [key, field.oneOf[0].const]
        }),
    )
  await prompt(
    "Plan a one-line change: create a file hello.txt containing the word hi. Keep the plan to two short lines, write it, and call plan_exit right away without asking me anything.",
  )
}

scenarios.compact = async () => {
  root = (await newSession()).sessionId
  await prompt("Say hello in five words.")
  await prompt("/compact")
  log.push("== load session")
  await call("session/load", { sessionId: root, cwd, mcpServers: [] })
}

// Run with PROBE_CONFIG set to a provider with a bad key, e.g.
// PROBE_CONFIG='{"model":"openai/gpt-4o-mini","provider":{"openai":{"options":{"apiKey":"sk-bad"}}}}'
scenarios.failure = async () => {
  root = (await newSession()).sessionId
  const res = await prompt("Say hi.")
  log.push(`== response: ${short(res.result ?? res.error, 800)}`)
}

scenarios.diff = async () => {
  await Bun.write(`${cwd}/notes.txt`, "alpha\nbeta\ngamma\n")
  root = (await newSession()).sessionId
  await prompt(
    "In notes.txt replace the line beta with BETA using the edit tool, then create new.txt containing the single line hello using the write tool. Do nothing else.",
  )
}

scenarios.report = async () => {
  await Bun.write(`${cwd}/one.txt`, "one\n")
  await Bun.write(`${cwd}/two.txt`, "two\n")
  root = (await newSession()).sessionId
  await prompt(
    "Append the line edited to one.txt with the edit tool, and run the shell command `echo edited >> two.txt`. Do nothing else.",
    root,
    { jetbrains: { air: { agentFileChangeReportRequest: { version: 1, requestId: "probe-report-1" } } } },
  )
}

const run = scenarios[scenario]
if (!run) {
  console.log(`unknown scenario ${scenario}; known: ${Object.keys(scenarios).join(", ")}`)
  process.exit(2)
}
await run()
clearTimeout(timer)
await Bun.sleep(1500)
dump()
proc.kill()
process.exit(0)

function dump() {
  const out: string[] = []
  for (const l of log) {
    const last = out.at(-1)
    const m = last?.match(/^(.*) x(\d+)$/)
    if (last === l) out[out.length - 1] = `${l} x2`
    else if (m && m[1] === l) out[out.length - 1] = `${l} x${Number(m[2]) + 1}`
    else out.push(l)
  }
  for (const l of out) console.log("  " + l)
}
