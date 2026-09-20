import { channelTypes } from "@chatbotx.io/utils/channel"
import { describe, expect, test } from "vitest"
import { resolveStepValidator } from "../src/channel-rules/channel-validator"
import { channelAwareStepValidators } from "../src/channel-rules/validators"
import {
  sendMessageNodeDefaultFn,
  sendMessageNodeSchema,
} from "../src/nodes/send-message"
import {
  bulktextSendOptions,
  bulktextSendStepDefaultFn,
  bulktextSendStepSchema,
} from "../src/steps/bulktext-send"
import { chooseChannelStepDefaultFn } from "../src/steps/choose-channel"
import { stepTypes } from "../src/steps/step-action"

const valid = () =>
  bulktextSendStepDefaultFn({
    text: "Hi {{first_name}}",
    ref: "camp:{{user_id}}",
  })

describe("bulktextSend step schema", () => {
  test("defaults: dry, nothing scheduled, empty options", () => {
    const step = bulktextSendStepDefaultFn()
    expect(step.stepType).toBe("bulktextSend")
    expect(step.dryRun).toBe(true)
    expect(step.spreadOverMinutes).toBe(0)
    expect(step.scheduleAt).toBe("")
    expect(bulktextSendStepSchema.safeParse(step).success).toBe(false) // nothing to send
    expect(bulktextSendStepSchema.safeParse(valid()).success).toBe(true)
  })

  test("photo-only is a send; a non-https photo is not", () => {
    expect(
      bulktextSendStepSchema.safeParse(
        bulktextSendStepDefaultFn({ photoUrl: "https://example.com/a.jpg" }),
      ).success,
    ).toBe(true)
    expect(
      bulktextSendStepSchema.safeParse(
        bulktextSendStepDefaultFn({ photoUrl: "http://example.com/a.jpg" }),
      ).success,
    ).toBe(false)
    expect(
      bulktextSendStepSchema.safeParse(
        bulktextSendStepDefaultFn({ photoUrl: "{{photo_url}}" }),
      ).success,
    ).toBe(true)
  })

  test("scheduleAt and spreadOverMinutes are exclusive; dates must parse unless templated", () => {
    expect(
      bulktextSendStepSchema.safeParse({
        ...valid(),
        scheduleAt: "2026-09-21T15:00:00Z",
        spreadOverMinutes: 5,
      }).success,
    ).toBe(false)
    expect(
      bulktextSendStepSchema.safeParse({ ...valid(), scheduleAt: "tomorrow" })
        .success,
    ).toBe(false)
    expect(
      bulktextSendStepSchema.safeParse({
        ...valid(),
        scheduleAt: "{{send_at}}",
      }).success,
    ).toBe(true)
    expect(
      bulktextSendStepSchema.safeParse({ ...valid(), spreadOverMinutes: 1441 })
        .success,
    ).toBe(false)
    expect(
      bulktextSendStepSchema.safeParse({ ...valid(), skipIfRepliedSince: "x" })
        .success,
    ).toBe(false)
  })

  test("bounds: text 1000, ref 120", () => {
    expect(
      bulktextSendStepSchema.safeParse({ ...valid(), text: "x".repeat(1001) })
        .success,
    ).toBe(false)
    expect(
      bulktextSendStepSchema.safeParse({ ...valid(), ref: "r".repeat(121) })
        .success,
    ).toBe(false)
  })

  test("options carry only what was set", () => {
    expect(bulktextSendOptions(valid())).toEqual({
      dryRun: true,
      ref: "camp:{{user_id}}",
    })
    expect(
      bulktextSendOptions({
        ...valid(),
        dryRun: false,
        spreadOverMinutes: 30,
        skipIfRepliedSince: "2026-09-20T00:00:00Z",
      }),
    ).toEqual({
      dryRun: false,
      ref: "camp:{{user_id}}",
      spreadOverMinutes: 30,
      skipIfRepliedSince: "2026-09-20T00:00:00Z",
    })
  })

  test("is a member of the send-message node's step union", () => {
    const node = sendMessageNodeDefaultFn({
      nodeProps: {},
      dataProps: {},
      detailProps: {
        beforeStep: chooseChannelStepDefaultFn({ channel: "api" }),
      },
    })
    node.data.details.steps = [valid()]
    expect(sendMessageNodeSchema.safeParse(node).success).toBe(true)
  })

  test("channel rule: publishes on api, refused everywhere else", () => {
    const validator = channelAwareStepValidators[stepTypes.enum.bulktextSend]
    expect(validator).toBeDefined()
    if (!validator) {
      return
    }
    expect(
      resolveStepValidator(validator, channelTypes.enum.api).safeParse(valid())
        .success,
    ).toBe(true)
    for (const channel of [
      channelTypes.enum.omnichannel,
      channelTypes.enum.whatsapp,
      "",
    ]) {
      expect(
        resolveStepValidator(validator, channel).safeParse(valid()).success,
      ).toBe(false)
    }
  })
})
