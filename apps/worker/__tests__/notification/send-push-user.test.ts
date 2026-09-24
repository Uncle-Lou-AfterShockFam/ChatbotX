// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * The per-user `notifyUser` job (s194): never touches a conversation, sends to
 * exactly the payload's user, carries the deal deep link in `data`, prunes a
 * DeviceNotRegistered token and rethrows only when every chunk failed.
 */
const chunkPushNotifications = vi.fn((messages: { to: string }[]) => [messages])
const sendPushNotificationsAsync = vi.fn()

vi.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken = (token: string) => token.startsWith("Expo[")
    chunkPushNotifications = chunkPushNotifications
    sendPushNotificationsAsync = sendPushNotificationsAsync
  },
}))
vi.mock("../../src/env", () => ({
  env: { EXPO_PUSH_ENABLED: true, EXPO_ACCESS_TOKEN: undefined },
}))

const findByOrFail = vi.fn()
const findByUserIds = vi.fn()
const deleteByTokens = vi.fn().mockResolvedValue(undefined)
const workspaceFind = vi.fn().mockResolvedValue({ language: "vi" })
const logInfo = vi.fn()

vi.mock("@chatbotx.io/business", () => ({
  conversationService: { findByOrFail },
  workspaceMemberService: { listUserIdsByWorkspaceId: vi.fn() },
  deviceTokenService: { findByUserIds, deleteByTokens },
  contactService: { findById: vi.fn() },
  workspaceService: { find: workspaceFind },
}))
vi.mock("../../src/lib/logger", () => ({
  logger: { warn: vi.fn(), info: logInfo },
}))

const ALL_CHUNKS_FAILED = /All 1 Expo push chunk/

const { sendPushForNotificationJob } = await import(
  "../../src/notification/handlers/send-push"
)

const userJob = (over: Record<string, unknown> = {}) =>
  ({
    type: "notifyUser",
    data: {
      workspaceId: "ws-1",
      userId: "user-2",
      notificationType: "taskAssigned",
      dealId: "deal-1",
      taskId: "task-1",
      commentId: null,
      notificationId: "n-1",
      payload: {
        pipelineId: "p1",
        dealTitle: "Big deal",
        taskTitle: "Call back",
        actorId: "u1",
      },
      ...over,
    },
  }) as never

beforeEach(() => {
  vi.clearAllMocks()
  workspaceFind.mockResolvedValue({ language: "vi" })
  deleteByTokens.mockResolvedValue(undefined)
  chunkPushNotifications.mockImplementation((messages) => [messages])
})

describe("notifyUser push", () => {
  test("sends to the payload user only, never resolving a conversation, with the deal deep link and localized copy", async () => {
    findByUserIds.mockResolvedValue([{ token: "Expo[t2]" }])
    sendPushNotificationsAsync.mockResolvedValue([{ status: "ok", id: "r" }])

    await sendPushForNotificationJob(userJob())

    expect(findByOrFail).not.toHaveBeenCalled()
    expect(findByUserIds).toHaveBeenCalledWith({ userIds: ["user-2"] })
    const [messages] = sendPushNotificationsAsync.mock.calls[0]
    expect(messages).toHaveLength(1)
    expect(messages[0].title).toBe("Call back")
    expect(messages[0].body).toBe("Bạn đã được giao một công việc")
    expect(messages[0].data).toEqual({
      workspaceId: "ws-1",
      kind: "taskAssigned",
      dealId: "deal-1",
      taskId: "task-1",
      commentId: null,
      notificationId: "n-1",
    })
  })

  test("a mention uses the deal title and the excerpt", async () => {
    findByUserIds.mockResolvedValue([{ token: "Expo[t2]" }])
    sendPushNotificationsAsync.mockResolvedValue([{ status: "ok", id: "r" }])

    await sendPushForNotificationJob(
      userJob({
        notificationType: "dealMentioned",
        taskId: null,
        commentId: "c-1",
        payload: { dealTitle: "Big deal", actorId: "u1", excerpt: "@Demo hi" },
      }),
    )

    const [messages] = sendPushNotificationsAsync.mock.calls[0]
    expect(messages[0].title).toBe("Big deal")
    expect(messages[0].body).toBe("@Demo hi")
  })

  test("falls back to the generic copy when the payload has no titles", async () => {
    findByUserIds.mockResolvedValue([{ token: "Expo[t2]" }])
    sendPushNotificationsAsync.mockResolvedValue([{ status: "ok", id: "r" }])
    workspaceFind.mockResolvedValue(undefined)

    await sendPushForNotificationJob(
      userJob({
        notificationType: "dealMentioned",
        payload: { dealTitle: null, actorId: null },
      }),
    )

    const [messages] = sendPushNotificationsAsync.mock.calls[0]
    expect(messages[0].title).toBe("You were mentioned on a deal")
    expect(messages[0].body).toBe("You were mentioned on a deal")
  })

  test("no device token = nothing sent, job completes", async () => {
    findByUserIds.mockResolvedValue([])
    await expect(sendPushForNotificationJob(userJob())).resolves.toBeUndefined()
    expect(sendPushNotificationsAsync).not.toHaveBeenCalled()
  })

  test("prunes a DeviceNotRegistered token (the fake-token proof path)", async () => {
    findByUserIds.mockResolvedValue([{ token: "Expo[stale]" }])
    sendPushNotificationsAsync.mockResolvedValue([
      {
        status: "error",
        message: "not registered",
        details: { error: "DeviceNotRegistered" },
      },
    ])

    await sendPushForNotificationJob(userJob())

    expect(deleteByTokens).toHaveBeenCalledWith({ tokens: ["Expo[stale]"] })
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ error: "DeviceNotRegistered" }),
      "Expo push ticket error",
    )
  })

  test("throws when every chunk failed so BullMQ retries", async () => {
    findByUserIds.mockResolvedValue([{ token: "Expo[t2]" }])
    sendPushNotificationsAsync.mockRejectedValue(new Error("down"))

    await expect(sendPushForNotificationJob(userJob())).rejects.toThrow(
      ALL_CHUNKS_FAILED,
    )
  })

  test("a malformed job (no userId) sends nothing and does not throw", async () => {
    findByUserIds.mockResolvedValue([])
    await expect(
      sendPushForNotificationJob(userJob({ userId: undefined })),
    ).resolves.toBeUndefined()
    expect(findByUserIds).toHaveBeenCalledWith({ userIds: [undefined] })
    expect(sendPushNotificationsAsync).not.toHaveBeenCalled()
  })
})
