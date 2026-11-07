import { describe, expect, it } from "bun:test"
import { withBuiltinCommands } from "@/kilocode/acp/commands"

describe("acp builtin commands", () => {
  it("offers /compact after the directory's commands", () => {
    expect(withBuiltinCommands([{ name: "review", description: "Review changes" }]).map((c) => c.name)).toEqual([
      "review",
      "compact",
    ])
  })

  it("keeps a directory command that is already called compact", () => {
    const own = { name: "compact", description: "Project compaction" }
    expect(withBuiltinCommands([own])).toEqual([own])
  })
})
