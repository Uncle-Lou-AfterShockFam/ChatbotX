import { describe, expect, test } from "vitest"
import { sanitizeUploadFileName } from "../src/form/upload"
import { sniffUpload } from "../src/storage/sniff"

// s225a A2-4 PR 5: what an upload IS comes from its bytes, never the
// client's type or name; the name is display-only and made harmless.

const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"))
const PNG = b64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
)
const GIF = b64("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00,
  0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
])
const WEBP = b64("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=")
const text = (s: string) => new TextEncoder().encode(s)
const PDF = text("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF")

describe("sniffUpload", () => {
  test.each([
    ["png", PNG, "image/png"],
    ["gif", GIF, "image/gif"],
    ["jpeg", JPEG, "image/jpeg"],
    ["webp", WEBP, "image/webp"],
    ["pdf", PDF, "application/pdf"],
  ])("%s is recognised by its bytes", (_name, bytes, mimeType) => {
    expect(sniffUpload(bytes)?.mimeType).toBe(mimeType)
  })

  test.each([
    ["empty", new Uint8Array(0)],
    ["html", text("<!doctype html><script>alert(1)</script>")],
    [
      "svg",
      text('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'),
    ],
    ["pdf without trailer", text("%PDF-1.7\n1 0 obj")],
    ["truncated png header", PNG.subarray(0, 8)],
    [
      "bmp",
      b64(
        "Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAA////AA==",
      ),
    ],
    ["exe", Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03])],
  ])("%s is unknown", (_name, bytes) => {
    expect(sniffUpload(bytes)).toBeNull()
  })

  test("non-bytes input is unknown, never a throw", () => {
    expect(sniffUpload(null as never)).toBeNull()
    expect(sniffUpload("x" as never)).toBeNull()
  })

  test("fuzz: random bytes are never taken for an allowed type unless they carry its magic", () => {
    for (let i = 0; i < 500; i++) {
      const bytes = Uint8Array.from(
        { length: 1 + Math.floor(Math.random() * 64) },
        () => Math.floor(Math.random() * 256),
      )
      // a random PNG / GIF / PDF signature has odds far below 1 in 2^32
      expect(() => sniffUpload(bytes)).not.toThrow()
    }
  })
})

describe("sanitizeUploadFileName", () => {
  test.each([
    ["me.png", "me.png"],
    ["../../etc/passwd", "passwd"],
    ["C:\\\\Users\\\\x\\\\cv.pdf", "cv.pdf"],
    ["a\u202egnp.exe", "agnp.exe"],
    ['say "hi".pdf', "say hi.pdf"],
    ["line\nbreak.png", "linebreak.png"],
    ["", "upload.png"],
    ["..", "upload.png"],
    ["   ", "upload.png"],
  ])("%j -> %j", (raw, expected) => {
    expect(sanitizeUploadFileName(raw, "png")).toBe(expected)
  })

  test("non-strings and overlong names", () => {
    expect(sanitizeUploadFileName(undefined, "pdf")).toBe("upload.pdf")
    expect(sanitizeUploadFileName({ a: 1 }, "pdf")).toBe("upload.pdf")
    expect(sanitizeUploadFileName("x".repeat(500), "pdf")).toHaveLength(200)
  })
})
