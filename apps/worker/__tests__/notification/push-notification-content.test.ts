// @vitest-environment node
import { describe, expect, test } from "vitest"
import { buildNotificationContent } from "../../src/notification/lib/build-notification-content"

const incomingMessageJob = (data: Record<string, unknown> = {}) =>
  ({
    type: "notifyIncomingMessage",
    data: {
      workspaceId: "ws-1",
      conversationId: "conv-1",
      messageId: "msg-1",
      ...data,
    },
  }) as never

const assignedJob = () =>
  ({
    type: "notifyConversationAssigned",
    data: {
      workspaceId: "ws-1",
      conversationId: "conv-1",
      assignedUserId: "user-1",
    },
  }) as never

describe("buildNotificationContent", () => {
  test("uses contact full name as title", () => {
    const result = buildNotificationContent({
      job: incomingMessageJob({ messageText: "Hey there" }),
      contactFullName: "Jane Doe",
      workspaceLanguage: "en",
    })
    expect(result.title).toBe("Jane Doe")
    expect(result.body).toBe("Hey there")
  })

  test("falls back to generic title when contact has no name", () => {
    const result = buildNotificationContent({
      job: incomingMessageJob({ messageText: "Hey there" }),
      contactFullName: null,
      workspaceLanguage: "en",
    })
    expect(result.title).toBe("New message")
  })

  test("uses location placeholder body", () => {
    const result = buildNotificationContent({
      job: incomingMessageJob({ contentType: "location" }),
      contactFullName: "Jane",
      workspaceLanguage: "en",
    })
    expect(result.body).toBe("Shared a location")
  })

  test("uses refLink placeholder body", () => {
    const result = buildNotificationContent({
      job: incomingMessageJob({ contentType: "refLink" }),
      contactFullName: "Jane",
      workspaceLanguage: "en",
    })
    expect(result.body).toBe("Sent a link")
  })

  test("uses singular attachment copy", () => {
    const result = buildNotificationContent({
      job: incomingMessageJob({ attachmentCount: 1 }),
      contactFullName: "Jane",
      workspaceLanguage: "en",
    })
    expect(result.body).toBe("Sent an attachment")
  })

  test("uses plural attachment-count copy", () => {
    const result = buildNotificationContent({
      job: incomingMessageJob({ attachmentCount: 2 }),
      contactFullName: "Jane",
      workspaceLanguage: "en",
    })
    expect(result.body).toBe("Sent 2 attachments")
  })

  test("assigned-conversation copy is templated", () => {
    const result = buildNotificationContent({
      job: assignedJob(),
      contactFullName: "Jane",
      workspaceLanguage: "en",
    })
    expect(result.title).toBe("Jane")
    expect(result.body).toBe("You were assigned a conversation")
  })

  test("falls back to en for an unknown workspace language", () => {
    const result = buildNotificationContent({
      job: incomingMessageJob({ contentType: "location" }),
      contactFullName: "Jane",
      workspaceLanguage: "xx-unsupported",
    })
    expect(result.body).toBe("Shared a location")
  })

  test("returns localized copy for a non-en workspace language", () => {
    const result = buildNotificationContent({
      job: incomingMessageJob({ contentType: "location" }),
      contactFullName: "Jane",
      workspaceLanguage: "vi",
    })
    expect(result.body).toBe("Đã chia sẻ vị trí")
  })

  test("falls back to en when workspace language is undefined", () => {
    const result = buildNotificationContent({
      job: incomingMessageJob({ contentType: "location" }),
      contactFullName: "Jane",
      workspaceLanguage: undefined,
    })
    expect(result.body).toBe("Shared a location")
  })
})

describe("buildNotificationContent: notifyUser (s194)", () => {
  const userJob = (
    notificationType: string,
    payload: Record<string, unknown>,
  ) =>
    ({
      type: "notifyUser",
      data: {
        workspaceId: "ws-1",
        userId: "u-2",
        notificationType,
        dealId: "d-1",
        taskId: null,
        commentId: null,
        notificationId: null,
        payload,
      },
    }) as never

  test("taskAssigned: task title + localized body", () => {
    const result = buildNotificationContent({
      job: userJob("taskAssigned", { taskTitle: "Call", dealTitle: "D" }),
      contactFullName: undefined,
      workspaceLanguage: "de",
    })
    expect(result.title).toBe("Call")
    expect(result.body).toBe("Dir wurde eine Aufgabe zugewiesen")
  })

  test("dealMentioned: deal title + excerpt, generic fallbacks", () => {
    expect(
      buildNotificationContent({
        job: userJob("dealMentioned", { dealTitle: "D", excerpt: "hi" }),
        contactFullName: undefined,
        workspaceLanguage: "en",
      }),
    ).toEqual({ title: "D", body: "hi" })
    expect(
      buildNotificationContent({
        job: userJob("dealMentioned", { dealTitle: null }),
        contactFullName: undefined,
        workspaceLanguage: "en",
      }),
    ).toEqual({
      title: "You were mentioned on a deal",
      body: "You were mentioned on a deal",
    })
  })

  test("every locale carries the two s194 keys", async () => {
    const { t } = await import("../../src/notification/lib/strings")
    for (const lang of [
      "en",
      "vi",
      "ar",
      "da",
      "de",
      "es",
      "fi",
      "fr",
      "he",
      "id",
      "it",
      "ja",
      "nl",
      "pt-BR",
      "pt-PT",
      "ro",
      "sv",
      "tr",
      "zh-CN",
      "zh-TW",
    ]) {
      const s = t(lang)
      expect(s.assignedTask, lang).toBeTruthy()
      expect(s.mentionedInDeal, lang).toBeTruthy()
    }
  })
})
