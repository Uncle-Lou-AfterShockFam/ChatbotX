import { describe, expect, test } from "vitest"
import {
  COMPANY_STOPPED_TAG_NAME,
  DEFAULT_COMPANY_STOP_TAG_NAME,
  extractEmailDomain,
  isFreeMailDomain,
  normalizeCompanyDomains,
} from "../src/partials/company"

describe("company partials", () => {
  test("tag names are distinct and lower-case", () => {
    expect(DEFAULT_COMPANY_STOP_TAG_NAME).toBe("company-stop")
    expect(COMPANY_STOPPED_TAG_NAME).toBe("company-stopped")
    expect(DEFAULT_COMPANY_STOP_TAG_NAME).not.toBe(COMPANY_STOPPED_TAG_NAME)
  })

  test("extractEmailDomain lower-cases and takes the part after the last @", () => {
    expect(extractEmailDomain("Lou@AfterShockFam.org")).toBe(
      "aftershockfam.org",
    )
    expect(extractEmailDomain('  "a@b"@Example.com ')).toBe("example.com")
  })

  test.each([
    [null, "null"],
    [undefined, "undefined"],
    [42, "number"],
    ["", "empty"],
    ["no-at-sign", "no @"],
    ["@example.com", "empty local part"],
    ["lou@", "empty domain"],
    ["lou@localhost", "no dot"],
    ["lou@exa mple.com", "whitespace in domain"],
  ])("extractEmailDomain(%j) is null (%s)", (value) => {
    expect(extractEmailDomain(value)).toBeNull()
  })

  test("isFreeMailDomain matches the consumer list case-insensitively", () => {
    expect(isFreeMailDomain("gmail.com")).toBe(true)
    expect(isFreeMailDomain(" GMAIL.COM ")).toBe(true)
    expect(isFreeMailDomain("aftershockfam.org")).toBe(false)
  })

  test("normalizeCompanyDomains strips scheme/@/www/path, lower-cases, dedupes, drops junk", () => {
    expect(
      normalizeCompanyDomains([
        "https://www.AfterShockFam.org/about",
        "@aftershockfam.org",
        "AFTERSHOCKFAM.ORG",
        "",
        "nodot",
        "bad domain.com",
        "gmail.com",
      ]),
    ).toEqual(["aftershockfam.org", "gmail.com"])
    expect(normalizeCompanyDomains([])).toEqual([])
    expect(normalizeCompanyDomains([1 as unknown as string])).toEqual([])
  })
})

describe("company activity types (s195)", () => {
  test("the change-log enum is closed and stable", async () => {
    const { companyActivityTypes } = await import("../src/partials/company")
    expect(companyActivityTypes.options).toEqual([
      "created",
      "updated",
      "stopped",
      "noteAdded",
      "noteDeleted",
      "contactLinked",
      "contactUnlinked",
      "dealCreated",
      "dealMoved",
      "dealStatusChanged",
    ])
    expect(companyActivityTypes.safeParse("bogus").success).toBe(false)
  })
})
