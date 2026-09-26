import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { nameInitials } from "@chatbotx.io/utils/initials"
import { act } from "react"
import { hydrateRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, describe, expect, test, vi } from "vitest"

let root: Root | undefined
let container: HTMLElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

// The server streams HTML as UTF-8; a lone surrogate cannot be encoded and
// becomes U+FFFD on the wire, while the client still renders the original.
function overTheWire(html: string): string {
  return new TextDecoder().decode(new TextEncoder().encode(html))
}

async function hydrateErrors(text: string) {
  const element = <span>{text}</span>
  container = document.createElement("div")
  container.innerHTML = overTheWire(renderToString(element))
  document.body.append(container)
  const recoverable = vi.fn()
  await act(() => {
    root = hydrateRoot(container as HTMLElement, element, {
      onRecoverableError: recoverable,
    })
  })
  return recoverable
}

describe("avatar initials (s209, React #418 on /contacts)", () => {
  test("a UTF-16 slice through an emoji in the second place mismatches on hydration", async () => {
    expect(await hydrateErrors("J\u{1F600}hn".slice(0, 2))).toHaveBeenCalled()
  })

  test("nameInitials of the same name hydrates cleanly", async () => {
    expect(
      await hydrateErrors(nameInitials("J\u{1F600}hn")),
    ).not.toHaveBeenCalled()
  })

  test("gate: no avatar initials are cut with a UTF-16 slice(0, 2) in src", () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) {
          walk(path)
        } else if (/\.tsx?$/.test(entry)) {
          readFileSync(path, "utf8")
            .split("\n")
            .forEach((line, i) => {
              if (
                /\.slice\(0,\s*2\)/.test(line) &&
                /name|initial/i.test(line)
              ) {
                offenders.push(`${path}:${i + 1}`)
              }
            })
        }
      }
    }
    walk("src")
    expect(offenders).toEqual([])
  })
})
