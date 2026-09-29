// @vitest-environment node

import { NextRequest } from "next/server"
import { describe, expect, test, vi } from "vitest"
import {
  BodyReadTimeoutError,
  readBodyBytesCapped,
  readBodyCapped,
} from "@/lib/forms/public-form-request"

/**
 * The capped body readers (s200, s225a): real bytes are counted whatever
 * Content-Length says, and with a deadline a body that trickles or never
 * ends is cancelled instead of pinning its buffered bytes.
 */
const streamed = (
  onStart: (c: ReadableStreamDefaultController<Uint8Array>) => void,
  cancel = vi.fn(),
) =>
  new NextRequest("https://chat.example/x", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({ start: onStart, cancel }),
    duplex: "half",
  } as ConstructorParameters<typeof NextRequest>[1] & { duplex: "half" })

describe("readBodyBytesCapped", () => {
  test("returns the bytes, and null one byte past the cap", async () => {
    const ok = streamed((c) => {
      c.enqueue(new Uint8Array([1, 2]))
      c.enqueue(new Uint8Array([3]))
      c.close()
    })
    expect(await readBodyBytesCapped(ok, 3)).toEqual(new Uint8Array([1, 2, 3]))
    const cancel = vi.fn()
    const over = streamed((c) => {
      c.enqueue(new Uint8Array(4))
    }, cancel)
    expect(await readBodyBytesCapped(over, 3)).toBeNull()
    expect(cancel).toHaveBeenCalled()
  })

  test("a body that never ends is cancelled at the deadline", async () => {
    const cancel = vi.fn()
    const hanging = streamed((c) => {
      c.enqueue(new Uint8Array([1]))
    }, cancel)
    await expect(
      readBodyBytesCapped(hanging, 1024, { timeoutMs: 30 }),
    ).rejects.toBeInstanceOf(BodyReadTimeoutError)
    expect(cancel).toHaveBeenCalled()
  })

  test("a body that finishes in time is not affected by the deadline", async () => {
    const quick = streamed((c) => {
      c.enqueue(new Uint8Array([7]))
      c.close()
    })
    expect(await readBodyBytesCapped(quick, 8, { timeoutMs: 1000 })).toEqual(
      new Uint8Array([7]),
    )
  })

  test("readBodyCapped decodes UTF-8", async () => {
    const text = streamed((c) => {
      c.enqueue(new TextEncoder().encode('{"a":"é"}'))
      c.close()
    })
    expect(await readBodyCapped(text, 64)).toBe('{"a":"é"}')
  })
})
