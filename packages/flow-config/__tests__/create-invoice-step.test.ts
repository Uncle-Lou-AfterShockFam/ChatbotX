import { describe, expect, test } from "vitest"
import { actionSteps, stepTypes } from "../src"
import {
  CREATE_INVOICE_MAX_LINES,
  createInvoiceStepDefaultFn,
  createInvoiceStepSchema,
} from "../src/steps/create-invoice"

describe("createInvoice step (s205b)", () => {
  test("is registered in stepTypes and actionSteps", () => {
    expect(stepTypes.options).toContain("createInvoice")
    const value = createInvoiceStepDefaultFn()
    expect(actionSteps.some((schema) => schema.safeParse(value).success)).toBe(
      true,
    )
  })

  test("defaults: one empty line, USD, due in 7 days, success + error states", () => {
    const step = createInvoiceStepDefaultFn()
    expect(step).toMatchObject({
      lines: [{ description: "", quantity: 1, unitAmount: "" }],
      currency: "USD",
      dueInDays: 7,
      memo: "",
    })
    expect(step.states).toHaveLength(2)
  })

  test("a saved step missing optional keys parses with defaults", () => {
    const {
      lines: _l,
      currency: _c,
      dueInDays: _d,
      memo: _m,
      ...legacy
    } = createInvoiceStepDefaultFn()
    expect(createInvoiceStepSchema.parse(legacy)).toMatchObject({
      lines: [],
      currency: "USD",
      dueInDays: 7,
      memo: "",
    })
  })

  test.each([
    [{ currency: "EURO" }, "4-letter currency"],
    [{ dueInDays: 366 }, "due too far"],
    [{ dueInDays: -1 }, "negative due"],
    [{ dueInDays: 1.5 }, "fractional due"],
    [
      { lines: [{ description: "x", quantity: 0, unitAmount: "1" }] },
      "zero quantity",
    ],
    [
      {
        lines: Array.from({ length: CREATE_INVOICE_MAX_LINES + 1 }, () => ({
          description: "x",
          quantity: 1,
          unitAmount: "1",
        })),
      },
      "too many lines",
    ],
    [{ lines: "nope" }, "lines not an array"],
    [{ states: [] }, "missing states"],
  ])("rejects %j (%s)", (patch) => {
    expect(
      createInvoiceStepSchema.safeParse({
        ...createInvoiceStepDefaultFn(),
        ...patch,
      }).success,
    ).toBe(false)
  })
})
