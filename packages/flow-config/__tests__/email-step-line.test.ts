import { describe, expect, test } from "vitest"
import { REFERENCE_FIELD_ENTITY_KIND } from "../src/import-export/reference-fields"
import { emailStepDefaultFn, emailStepSchema } from "../src/steps/email"

/**
 * s222b (B2 phase 4): the email step's optional bulktext email line. Saved
 * versions without it re-parse unchanged; a set value is an id, never text.
 */
describe("emailStepSchema.lineInboxId", () => {
  test("absent is fine (every saved version before s222b)", () => {
    const parsed = emailStepSchema.parse(emailStepDefaultFn())
    expect(parsed.lineInboxId).toBeUndefined()
  })

  test("an inbox id is kept as a string", () => {
    const parsed = emailStepSchema.parse(
      emailStepDefaultFn({ lineInboxId: "11702759713308672" }),
    )
    expect(parsed.lineInboxId).toBe("11702759713308672")
  })

  test("a non-id value is refused", () => {
    for (const lineInboxId of ["line-1", "1; drop", 12]) {
      expect(
        emailStepSchema.safeParse(emailStepDefaultFn({ lineInboxId } as never))
          .success,
      ).toBe(false)
    }
  })

  test("flow export / template install treats it as an inbox reference", () => {
    expect(REFERENCE_FIELD_ENTITY_KIND.lineInboxId).toBe("inbox")
  })
})

describe("emailStepSchema.format (s225b outreach B-1)", () => {
  test("absent is fine (every saved version before s225b) and means html", () => {
    expect(emailStepSchema.parse(emailStepDefaultFn()).format).toBeUndefined()
  })

  test("html and text are kept", () => {
    for (const format of ["html", "text"] as const) {
      expect(emailStepSchema.parse(emailStepDefaultFn({ format })).format).toBe(
        format,
      )
    }
  })

  test("anything else is refused", () => {
    for (const format of ["TEXT", "markdown", "", 1, null]) {
      expect(
        emailStepSchema.safeParse(emailStepDefaultFn({ format } as never))
          .success,
      ).toBe(false)
    }
  })
})
