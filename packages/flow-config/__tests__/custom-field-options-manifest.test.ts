import { describe, expect, test } from "vitest"
import {
  flowExportCustomFieldSchema,
  templateCustomFieldManifestEntrySchema,
} from "../src/import-export"

// s201: a select / multiSelect field must travel with its options, or the
// importer would create a field no value can ever be written to.
describe.each([
  ["flow export", flowExportCustomFieldSchema],
  ["template manifest", templateCustomFieldManifestEntrySchema],
])("%s custom-field entry (s201)", (_name, schema) => {
  test("an option type needs options; other types refuse them", () => {
    expect(schema.safeParse({ name: "Tier", type: "select" }).success).toBe(
      false,
    )
    expect(
      schema.safeParse({ name: "Tier", type: "multiSelect", options: [] })
        .success,
    ).toBe(false)
    expect(
      schema.safeParse({ name: "Note", type: "shortText", options: ["A"] })
        .success,
    ).toBe(false)
    expect(
      schema.safeParse({ name: "Tier", type: "select", options: ["A", "B"] })
        .success,
    ).toBe(true)
    expect(schema.safeParse({ name: "Note", type: "shortText" }).success).toBe(
      true,
    )
  })
})
