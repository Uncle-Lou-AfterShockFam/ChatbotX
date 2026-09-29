import { beforeEach, describe, expect, test, vi } from "vitest"

const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn().mockResolvedValue({})
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) }
})
vi.mock("nodemailer", () => ({ default: { createTransport } }))

const { sendMail: sendMailAction } = await import("../src/actions")

const ctx = {
  auth: { host: "smtp.test", port: 587, username: "u", password: "p" },
} as never

beforeEach(() => {
  vi.clearAllMocks()
})

describe("sendMail action", () => {
  test("s221b: buffered attachments reach nodemailer unchanged, ctx never does", async () => {
    const attachments = [
      {
        filename: "a.pdf",
        content: Buffer.from("%PDF"),
        contentType: "application/pdf",
      },
    ]
    await sendMailAction({
      ctx,
      from: "a@test",
      to: "b@test",
      subject: "s",
      html: "<p>x</p>",
      attachments,
    })
    const options = sendMail.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options.attachments).toBe(attachments)
    expect(options).not.toHaveProperty("ctx")
  })

  test("a mail without attachments sends no attachments key value", async () => {
    await sendMailAction({
      ctx,
      from: "a@test",
      to: "b@test",
      subject: "s",
      html: "<p>x</p>",
    })
    const options = sendMail.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options.attachments).toBeUndefined()
  })
})
