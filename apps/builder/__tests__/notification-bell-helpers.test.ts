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

  test("the badge caps at 99+", () => {
    expect(badgeLabel(1)).toBe("1")
    expect(badgeLabel(99)).toBe("99")
    expect(badgeLabel(100)).toBe("99+")
  })
})
