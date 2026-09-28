import { describe, expect, test } from "vitest"
import { splitFullName } from "../src/contact/full-name"

describe("splitFullName (s219)", () => {
  test.each([
    ["Ada", { firstName: "Ada", lastName: null }],
    ["  Ada   King Lovelace ", { firstName: "Ada", lastName: "King Lovelace" }],
    ["Ada\tKing\nLovelace", { firstName: "Ada", lastName: "King Lovelace" }],
    ["", { firstName: null, lastName: null }],
    ["   ", { firstName: null, lastName: null }],
  ])("%j", (value, expected) => {
    expect(splitFullName(value)).toEqual(expected)
  })
})
