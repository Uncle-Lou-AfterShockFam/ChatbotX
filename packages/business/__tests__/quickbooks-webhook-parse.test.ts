import { createHmac } from "node:crypto"
import { describe, expect, test } from "vitest"
import {
  parseQuickbooksNotification,
  QUICKBOOKS_WEBHOOK_MAX_EVENTS,
  verifyQuickbooksSignature,
} from "../src/invoice/quickbooks-webhook"

const TOKEN = "verifier-token-123"
const sign = (body: Buffer, token = TOKEN) =>
  createHmac("sha256", token).update(body).digest("base64")
const buf = (value: unknown) => Buffer.from(JSON.stringify(value))

const cloudEvent = (
  type: string,
  entityId = "42",
  realm = "9130357766900001",
) => ({
  specversion: "1.0",
  id: `ev-${entityId}`,
  source: "intuit.dsnBgbseACLLRZNxo2dfc4evmEJdxde58xeeYcZliOU=",
  type,
  datacontenttype: "application/json",
  time: "2026-09-10T21:31:25.179Z",
  intuitentityid: entityId,
  intuitaccountid: realm,
  data: {},
})

describe("quickbooks webhook signature (s214b)", () => {
  test("verifies the base64 HMAC of the raw body", () => {
    const body = buf([cloudEvent("qbo.invoice.updated.v1")])
    expect(
      verifyQuickbooksSignature({
        verifierToken: TOKEN,
        signature: sign(body),
        rawBody: body,
      }),
    ).toBe(true)
  })

  test.each([
    ["no signature", null],
    ["empty signature", ""],
    ["another token's", "OTHER"],
    ["garbage", "!!!notbase64"],
  ])("refuses %s", (_label, kind) => {
    const body = buf([])
    const signature =
      kind === "OTHER" ? sign(body, "other-token") : (kind as string | null)
    expect(
      verifyQuickbooksSignature({
        verifierToken: TOKEN,
        signature,
        rawBody: body,
      }),
    ).toBe(false)
  })

  test("refuses a signed body that was changed", () => {
    const body = buf([cloudEvent("qbo.invoice.updated.v1", "1")])
    const tampered = buf([cloudEvent("qbo.invoice.updated.v1", "2")])
    expect(
      verifyQuickbooksSignature({
        verifierToken: TOKEN,
        signature: sign(body),
        rawBody: tampered,
      }),
    ).toBe(false)
  })

  test("an empty verifier token verifies nothing", () => {
    const body = buf([])
    expect(
      verifyQuickbooksSignature({
        verifierToken: "",
        signature: sign(body, ""),
        rawBody: body,
      }),
    ).toBe(false)
  })
})

describe("quickbooks notification parser (s214b)", () => {
  test("CloudEvents: invoice and payment events, everything else ignored", () => {
    const notices = parseQuickbooksNotification(
      buf([
        cloudEvent("qbo.invoice.updated.v1", "11"),
        cloudEvent("qbo.payment.created.v1", "12"),
        cloudEvent("qbo.customer.merged.v1", "13"),
        cloudEvent("qbo.invoice.voided.v1", "not-a-number"),
        cloudEvent("qbo.invoice.updated.v1", "14", "realm-with-letters"),
        { type: "qbo.invoice.updated.v1" },
        "junk",
        null,
      ]),
    )
    expect(notices).toEqual([
      { realmId: "9130357766900001", entity: "Invoice", entityId: "11" },
      { realmId: "9130357766900001", entity: "Payment", entityId: "12" },
    ])
  })

  test("legacy eventNotifications shape", () => {
    const notices = parseQuickbooksNotification(
      buf({
        eventNotifications: [
          {
            realmId: "123",
            dataChangeEvent: {
              entities: [
                { name: "Invoice", id: "5", operation: "Update" },
                { name: "Customer", id: "6", operation: "Create" },
                { name: "Payment", id: "7", operation: "Create" },
              ],
            },
          },
          { realmId: "123" },
        ],
      }),
    )
    expect(notices).toEqual([
      { realmId: "123", entity: "Invoice", entityId: "5" },
      { realmId: "123", entity: "Payment", entityId: "7" },
    ])
  })

  test("prototype keys never resolve to an entity", () => {
    expect(
      parseQuickbooksNotification(
        buf({
          eventNotifications: [
            {
              realmId: "1",
              dataChangeEvent: {
                entities: [
                  { name: "constructor", id: "1" },
                  { name: "__proto__", id: "2" },
                  { name: "toString", id: "3" },
                ],
              },
            },
          ],
        }),
      ),
    ).toEqual([])
  })

  test.each([
    ["not JSON", Buffer.from("{nope")],
    ["a string", buf("hello")],
    ["a number", buf(42)],
    ["an object without notifications", buf({ hello: 1 })],
  ])("refuses %s", (_label, body) => {
    expect(parseQuickbooksNotification(body)).toBeNull()
  })

  test("caps the event count (both shapes)", () => {
    const events = Array.from(
      { length: QUICKBOOKS_WEBHOOK_MAX_EVENTS + 1 },
      (_, i) => cloudEvent("qbo.invoice.updated.v1", String(i + 1)),
    )
    expect(parseQuickbooksNotification(buf(events))).toBeNull()
    expect(
      parseQuickbooksNotification(
        buf(events.slice(0, QUICKBOOKS_WEBHOOK_MAX_EVENTS)),
      ),
    ).toHaveLength(QUICKBOOKS_WEBHOOK_MAX_EVENTS)
    const legacy = {
      eventNotifications: [
        {
          realmId: "1",
          dataChangeEvent: {
            entities: Array.from(
              { length: QUICKBOOKS_WEBHOOK_MAX_EVENTS + 1 },
              (_, i) => ({
                name: "Invoice",
                id: String(i + 1),
              }),
            ),
          },
        },
      ],
    }
    expect(parseQuickbooksNotification(buf(legacy))).toBeNull()
  })

  test("fuzz: random bytes never throw", () => {
    for (let i = 0; i < 300; i++) {
      const junk = Buffer.from(
        Array.from({ length: i % 200 }, () => Math.floor(Math.random() * 256)),
      )
      expect(() => parseQuickbooksNotification(junk)).not.toThrow()
    }
  })
})
