// @vitest-environment node
import { describe, expect, test } from "vitest"
import {
  badgeLabel,
  notificationHref,
} from "../src/features/notifications/components/notification-bell"

describe("notification bell helpers (s194)", () => {
  test("the deep link carries the pipeline and the deal, URL-encoded", () => {
    expect(
      notificationHref("ws 1", {
        dealId: "d/1",
        payload: {
          pipelineId: "p&1",
          dealTitle: null,
          actorId: null,
        },
      }),
    ).toBe("/space/ws 1/deals?pipelineId=p%261&status=all&dealId=d%2F1")
  })

  test("s220: a form submission links to that form's submissions", () => {
    expect(
      notificationHref("ws-1", {
        dealId: null,
        payload: {
          formId: "f/1",
          formTitle: "Intake",
          submissionId: "sub-1",
          contactName: null,
        },
      }),
    ).toBe("/space/ws-1/forms/f%2F1/submissions")
  })

  test("the badge caps at 99+", () => {
    expect(badgeLabel(1)).toBe("1")
    expect(badgeLabel(99)).toBe("99")
    expect(badgeLabel(100)).toBe("99+")
  })
})
