import { describe, expect, test } from "vitest"
import { resolveMemberNotificationPrefs } from "../src/workspace-member/notification-prefs"

/**
 * The normalising read path for the two jsonb preference columns (s194).
 * Legacy rows hold `{}` or only the four original keys.
 */
describe("resolveMemberNotificationPrefs", () => {
  test("legacy {} rows: old keys false, the s194 deal keys TRUE", () => {
    const prefs = resolveMemberNotificationPrefs({
      notificationTypes: {},
      notificationChannels: {},
    })
    expect(prefs).toEqual({
      types: {
        notifyAdmin: false,
        newMessageToHuman: false,
        newOrder: false,
        taskAssigned: true,
        dealMentioned: true,
      },
      channels: {
        messenger: false,
        email: false,
        telegram: false,
        browser: false,
        push: true,
        inApp: true,
      },
    })
  })

  test("an explicit false is honoured, an explicit true kept", () => {
    const prefs = resolveMemberNotificationPrefs({
      notificationTypes: { notifyAdmin: true, taskAssigned: false },
      notificationChannels: { push: false, inApp: true, email: true },
    })
    expect(prefs.types.notifyAdmin).toBe(true)
    expect(prefs.types.taskAssigned).toBe(false)
    expect(prefs.types.dealMentioned).toBe(true)
    expect(prefs.channels.push).toBe(false)
    expect(prefs.channels.inApp).toBe(true)
    expect(prefs.channels.email).toBe(true)
  })

  test.each([
    [null],
    [undefined],
    [{ notificationTypes: null, notificationChannels: "x" }],
    [{ notificationTypes: [], notificationChannels: 5 }],
    [
      {
        notificationTypes: { taskAssigned: "yes" },
        notificationChannels: { push: 0 },
      },
    ],
  ])("null / non-object / wrong-typed values fall back to the defaults: %j", (member) => {
    const prefs = resolveMemberNotificationPrefs(member as never)
    expect(prefs.types.taskAssigned).toBe(true)
    expect(prefs.channels.push).toBe(true)
    expect(prefs.types.notifyAdmin).toBe(false)
  })

  test("unknown keys are dropped, never echoed", () => {
    const prefs = resolveMemberNotificationPrefs({
      notificationTypes: { bogus: true },
      notificationChannels: { sms: true },
    })
    expect(Object.keys(prefs.types)).not.toContain("bogus")
    expect(Object.keys(prefs.channels)).not.toContain("sms")
  })
})
