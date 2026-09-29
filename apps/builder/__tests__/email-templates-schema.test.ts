import { describe, expect, test } from "vitest"
import {
  emailTemplateData,
  includeArchivedParam,
} from "@/features/email-templates/schema/resource"

describe("email templates request schemas (s220b)", () => {
  test("includeArchived: only true/'true' is true; 'false' is false (not coerced)", () => {
    expect(includeArchivedParam.parse("false")).toBe(false)
    expect(includeArchivedParam.parse("true")).toBe(true)
    expect(includeArchivedParam.parse(true)).toBe(true)
    expect(includeArchivedParam.parse(false)).toBe(false)
    expect(includeArchivedParam.parse(undefined)).toBeUndefined()
    expect(includeArchivedParam.safeParse("yes").success).toBe(false)
    expect(includeArchivedParam.safeParse("1").success).toBe(false)
  })

  test("the body is closed and bounded; the document itself is validated by the service", () => {
    expect(
      emailTemplateData.safeParse({ name: "x", document: {}, extra: 1 })
        .success,
    ).toBe(false)
    expect(
      emailTemplateData.safeParse({ name: "", document: {} }).success,
    ).toBe(false)
    expect(
      emailTemplateData.safeParse({ name: "x", document: [] }).success,
    ).toBe(false)
    expect(
      emailTemplateData.safeParse({ name: "x", document: {} }).success,
    ).toBe(true)
  })
})
