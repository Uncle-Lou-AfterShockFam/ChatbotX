import { describe, expect, test } from "vitest"
import { applyMove } from "@/features/deals/board-helpers"
import type { BoardColumnResource } from "@/features/deals/schema/resource"

const deal = (id: string, stageId: string, position: number) =>
  ({
    id,
    stageId,
    position,
    title: id,
    status: "open",
    priority: "medium",
    value: null,
    currency: "USD",
    contactId: null,
    companyId: null,
    ownerId: null,
    fields: {},
  }) as unknown as BoardColumnResource["deals"][number]

const stage = (id: string) =>
  ({ id, name: id }) as unknown as BoardColumnResource["stage"]

const board = (): BoardColumnResource[] => [
  {
    stage: stage("new"),
    deals: [deal("a", "new", 1000), deal("b", "new", 2000)],
  },
  { stage: stage("won"), deals: [deal("c", "won", 1000)] },
]

describe("applyMove", () => {
  test("a moved card keeps its task / comment counts (s198)", () => {
    const columns = board()
    Object.assign(columns[0].deals[0], {
      openTaskCount: 3,
      overdueTaskCount: 1,
      commentCount: 2,
    })
    const next = applyMove(columns, {
      cardId: "a",
      toColumnId: "won",
      index: 0,
    })
    expect(next?.columns[1].deals[0]).toMatchObject({
      id: "a",
      stageId: "won",
      openTaskCount: 3,
      overdueTaskCount: 1,
      commentCount: 2,
    })
  })

  test("moves a card to another column at the end with position after the last card", () => {
    const next = applyMove(board(), {
      cardId: "a",
      toColumnId: "won",
      index: 1,
    })
    expect(next?.position).toBe(2000)
    expect(next?.columns[0].deals.map((d) => d.id)).toEqual(["b"])
    expect(next?.columns[1].deals.map((d) => d.id)).toEqual(["c", "a"])
    expect(next?.columns[1].deals[1].stageId).toBe("won")
  })

  test("drops into an empty position before the first card", () => {
    const next = applyMove(board(), {
      cardId: "a",
      toColumnId: "won",
      index: 0,
    })
    expect(next?.position).toBe(0)
    expect(next?.columns[1].deals.map((d) => d.id)).toEqual(["a", "c"])
  })

  test("reorders inside the same column with a midpoint position", () => {
    const next = applyMove(board(), {
      cardId: "a",
      toColumnId: "new",
      index: 1,
    })
    expect(next?.columns[0].deals.map((d) => d.id)).toEqual(["b", "a"])
    expect(next?.position).toBe(3000)
  })

  test("clamps an out-of-range index instead of throwing", () => {
    const next = applyMove(board(), {
      cardId: "c",
      toColumnId: "new",
      index: 99,
    })
    expect(next?.columns[0].deals.map((d) => d.id)).toEqual(["a", "b", "c"])
  })

  test.each([
    [{ cardId: "zzz", toColumnId: "won", index: 0 }, "unknown card"],
    [{ cardId: "a", toColumnId: "nope", index: 0 }, "unknown column"],
  ])("returns null for %j (%s)", (move) => {
    expect(applyMove(board(), move)).toBeNull()
  })

  test("never mutates the input", () => {
    const input = board()
    const snapshot = JSON.stringify(input)
    applyMove(input, { cardId: "a", toColumnId: "won", index: 0 })
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})
