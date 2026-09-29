import { describe, expect, test, vi } from "vitest"

vi.mock("@/lib/orpc/orpc", () => ({ client: {} }))
vi.mock("@/lib/orpc/query", () => ({ orpc: {} }))

const { instantToLocalInput, localInputToInstant } = await import(
  "@/features/forms/components/form-settings-panel"
)

/**
 * s220c A2-4: the availability window is typed in a `datetime-local` input
 * (no zone) and stored as an instant. Both halves read the viewer's zone, so
 * the builder's UTC server render and an operator in New York agree.
 */
describe("availability window <-> datetime-local", () => {
  test("round-trips in the viewer's zone, across a DST change", () => {
    const zone = "America/New_York"
    // EDT (-04:00) and EST (-05:00)
    expect(localInputToInstant("2026-10-01T09:00", zone)).toBe(
      "2026-10-01T13:00:00.000Z",
    )
    expect(localInputToInstant("2026-12-01T09:00", zone)).toBe(
      "2026-12-01T14:00:00.000Z",
    )
    expect(instantToLocalInput("2026-10-01T13:00:00.000Z", zone)).toBe(
      "2026-10-01T09:00",
    )
    expect(instantToLocalInput("2026-12-01T14:00:00.000Z", zone)).toBe(
      "2026-12-01T09:00",
    )
  })

  test("the same instant shows as each viewer's own wall clock", () => {
    const iso = "2026-10-01T13:00:00.000Z"
    expect(instantToLocalInput(iso, "UTC")).toBe("2026-10-01T13:00")
    expect(instantToLocalInput(iso, "Asia/Tokyo")).toBe("2026-10-01T22:00")
  })

  test("empty / unparseable -> null / empty, never throws", () => {
    expect(localInputToInstant("", "UTC")).toBeNull()
    expect(localInputToInstant("not a date", "UTC")).toBeNull()
    expect(instantToLocalInput(null, "UTC")).toBe("")
    expect(instantToLocalInput("garbage", "UTC")).toBe("")
  })
})
