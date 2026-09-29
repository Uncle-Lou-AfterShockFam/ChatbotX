import { expect, test } from "vitest"
import {
  PREVIEW_SAMPLE_VALUES,
  previewSampleVars,
} from "@/features/email-templates/lib/preview-samples"

const doc = (text: string, preheader?: string) =>
  ({
    version: 1,
    settings: preheader ? { preheader } : {},
    blocks: [{ id: "1", type: "text", text }],
  }) as const

test("s223b: only system-field tokens get a sample; custom, bot-field and coupon tokens stay unresolved", () => {
  expect(
    previewSampleVars(
      doc(
        "<p>{{ first_name }} {{last_name|x}} {{plan}} {{bot_field:1}} {{coupon:SUMMER}}</p>",
        "{{full_name}}",
      ) as never,
    ),
  ).toEqual({
    first_name: "Alex",
    last_name: "Rivera",
    full_name: "Alex Rivera",
  })
})

test("prototype keys are never samples", () => {
  expect(
    previewSampleVars(
      doc("<p>{{constructor}} {{__proto__}} {{toString}}</p>") as never,
    ),
  ).toEqual({})
})

test("an unreadable draft yields no samples instead of throwing", () => {
  expect(previewSampleVars({ version: 1, settings: {} } as never)).toEqual({})
  expect(previewSampleVars(null as never)).toEqual({})
})

test("samples fit the preview input caps (<= 50 vars, <= 1000 chars)", () => {
  const values = Object.values(PREVIEW_SAMPLE_VALUES)
  expect(values.length).toBeLessThanOrEqual(50)
  for (const v of values) {
    expect(v.length).toBeLessThanOrEqual(1000)
  }
})
