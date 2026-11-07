import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import * as Log from "@opencode-ai/core/util/log"
import { makeRuntime } from "../../../src/effect/run-service"
import { Session } from "../../../src/session/session"
import { provideTestInstance, tmpdir } from "../../fixture/fixture"

Log.init({ print: false })

const runtime = makeRuntime(Session.Service, LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node])))

describe("session archive", () => {
  // Air's _session/unarchive clears the archive time; the stored row must follow.
  test("clearing the archive time unarchives the stored session", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const created = await runtime.runPromise((svc) => svc.create({}))
        await runtime.runPromise((svc) => svc.setArchived({ sessionID: created.id, time: 123 }))
        expect((await runtime.runPromise((svc) => svc.get(created.id))).time.archived).toBe(123)
        await runtime.runPromise((svc) => svc.setArchived({ sessionID: created.id }))
        expect((await runtime.runPromise((svc) => svc.get(created.id))).time.archived).toBeUndefined()
      },
    })
  })
})
