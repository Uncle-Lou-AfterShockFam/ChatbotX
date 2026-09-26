// @vitest-environment node

import { formFieldTypes } from "@chatbotx.io/database/partials"
import { describe, expect, test } from "vitest"
import { customFieldValueChanged } from "@/features/conditions/schema/custom-field-value-changed"
import {
  getConditionOptions,
  getFieldConfigs,
} from "@/features/contact-filter/components/contact-filter-config"
import {
  customFieldOperatorRequiresArrayValue,
  getCustomFieldConditionOptions,
  getCustomFieldValueInputConfig,
  optionOperatorLabelKey,
  relabelOptionOperators,
} from "@/features/contact-filter/components/custom-field-filter-config"
import {
  convertCustomFieldTypeToConditionType,
  customFieldConditionSchema,
  mappingConditions,
} from "@/features/contact-filter/schema"

const t = (key: string) => key

const configs = getFieldConfigs({
  t,
  tagOptions: [],
  inboxOptions: [],
  flowVersionOptions: [],
  customFields: [
    {
      id: "cf-tier",
      name: "Tier",
      type: "select",
      options: ["Gold", "Silver"],
    },
    {
      id: "cf-int",
      name: "Interests",
      type: "multiSelect",
      options: ["Golf", "Red, White"],
    },
  ],
})
const tier = configs.find((c) => c.name === "customField:cf-tier")
const interests = configs.find((c) => c.name === "customField:cf-int")

const condition = (overrides: Record<string, unknown>) => ({
  field: "customField",
  customFieldId: "cf-1",
  ...overrides,
})

describe("option-field filter config (s203)", () => {
  test("multiSelect is offered (the s201 hide is gone), with its options", () => {
    expect(interests).toMatchObject({
      formField: formFieldTypes.enum.multiSelect,
      options: [
        { label: "Golf", value: "Golf" },
        { label: "Red, White", value: "Red, White" },
      ],
    })
    expect(tier?.formField).toBe(formFieldTypes.enum.select)
    expect(convertCustomFieldTypeToConditionType("select")).toBe("select")
    expect(convertCustomFieldTypeToConditionType("multiSelect")).toBe(
      "multiSelect",
    )
  })

  test("operators are exactly the option table, none disabled", () => {
    const ops = (config: typeof tier) =>
      getCustomFieldConditionOptions(
        config as NonNullable<typeof tier>,
        getConditionOptions(t),
      )
    expect(ops(interests).map((o) => o.value)).toEqual([
      "in",
      "contains",
      "notIn",
      "eq",
      "ne",
      "isEmpty",
      "isNotEmpty",
    ])
    expect(ops(tier).map((o) => o.value)).toEqual([
      "eq",
      "ne",
      "in",
      "notIn",
      "isEmpty",
      "isNotEmpty",
    ])
    expect(ops(tier).some((o) => o.disabled)).toBe(false)
    expect(mappingConditions.multiSelect).toContain("contains")
  })

  test("value inputs follow the operator's shape", () => {
    expect(getCustomFieldValueInputConfig(tier, "eq")).toEqual({
      kind: "select",
      defaultValue: "",
    })
    expect(getCustomFieldValueInputConfig(tier, "in")).toEqual({
      kind: "multiSelect",
      defaultValue: [],
    })
    expect(getCustomFieldValueInputConfig(interests, "eq")?.kind).toBe(
      "multiSelect",
    )
    expect(getCustomFieldValueInputConfig(interests, "isEmpty")?.kind).toBe(
      "none",
    )
    expect(customFieldOperatorRequiresArrayValue("notIn", tier)).toBe(true)
    expect(customFieldOperatorRequiresArrayValue("ne", tier)).toBe(false)
    expect(customFieldOperatorRequiresArrayValue("isBetween")).toBe(true)
  })

  test("multiSelect list operators read in their own words", () => {
    expect(optionOperatorLabelKey("multiSelect", "in")).toBe(
      "fields.operator.hasAnyOf",
    )
    expect(optionOperatorLabelKey("select", "in")).toBe(
      "fields.operator.isAnyOf",
    )
    expect(optionOperatorLabelKey("select", "eq")).toBeUndefined()
    expect(optionOperatorLabelKey("shortText", "in")).toBeUndefined()
    expect(
      relabelOptionOperators(
        [{ value: "contains", label: "Contains" }],
        "multiSelect",
        t,
      ),
    ).toEqual([{ value: "contains", label: "fields.operator.hasAllOf" }])
  })
})

describe("customFieldConditionSchema on option fields (s203)", () => {
  const ok = (overrides: Record<string, unknown>) =>
    customFieldConditionSchema.safeParse(condition(overrides)).success

  test("accepts the option table with the right value shape", () => {
    const ms = { customFieldType: "multiSelect", valueType: "multiSelect" }
    const sel = { customFieldType: "select", valueType: "select" }
    expect(ok({ ...ms, operator: "in", value: ["Golf", "Red, White"] })).toBe(
      true,
    )
    expect(ok({ ...ms, operator: "contains", value: ["Golf"] })).toBe(true)
    expect(ok({ ...ms, operator: "isEmpty" })).toBe(true)
    expect(ok({ ...sel, operator: "eq", value: "Gold" })).toBe(true)
    expect(ok({ ...sel, operator: "notIn", value: ["Gold", "Silver"] })).toBe(
      true,
    )
  })

  test("refuses text operators, wrong shapes and mismatched types (closed)", () => {
    const ms = { customFieldType: "multiSelect", valueType: "multiSelect" }
    const sel = { customFieldType: "select", valueType: "select" }
    expect(ok({ ...ms, operator: "startsWith", value: "Go" })).toBe(false)
    expect(ok({ ...ms, operator: "in", value: "Golf" })).toBe(false)
    expect(ok({ ...ms, operator: "in", value: [] })).toBe(false)
    expect(ok({ ...sel, operator: "eq", value: ["Gold"] })).toBe(false)
    expect(ok({ ...sel, operator: "contains", value: "Go" })).toBe(false)
    // a pre-s203 select condition (valueType text) is refused on its next save
    expect(
      ok({
        customFieldType: "select",
        valueType: "text",
        operator: "eq",
        value: "Gold",
      }),
    ).toBe(false)
    // an option valueType without the option field type
    expect(
      ok({ valueType: "multiSelect", operator: "in", value: ["Golf"] }),
    ).toBe(false)
    // in / notIn stay refused on a text field, and a list value too
    expect(
      ok({
        customFieldType: "shortText",
        valueType: "text",
        operator: "in",
        value: ["a"],
      }),
    ).toBe(false)
    expect(
      ok({
        customFieldType: "shortText",
        valueType: "text",
        operator: "eq",
        value: ["a"],
      }),
    ).toBe(false)
  })
})

describe("customFieldValueChanged value (s203)", () => {
  const parse = (value: unknown) =>
    customFieldValueChanged.safeParse({
      type: "customFieldValueChanged",
      sourceId: "cf-1",
      operator: "in",
      value,
    }).success

  test("an option list must be non-empty text", () => {
    expect(parse({ options: ["Golf"] })).toBe(true)
    expect(parse({ options: [] })).toBe(false)
    expect(parse({ options: [" "] })).toBe(false)
    expect(parse({ options: "Golf" })).toBe(false)
    expect(parse({ text: "Golf" })).toBe(true)
    expect(parse("")).toBe(true)
  })
})
