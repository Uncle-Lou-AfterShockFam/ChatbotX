import { describe, expect, test } from "vitest"
import {
  contactAvatarPrefix,
  isContactAvatarKey,
  workspaceContactFilesPrefix,
} from "../src/storage/paths"

describe("storage paths", () => {
  test("each prefix ends in a slash so a neighbouring id never matches", () => {
    expect(workspaceContactFilesPrefix("1")).toBe("public/space/1/contacts/")
    expect(contactAvatarPrefix("1", "2")).toBe(
      "public/space/1/contacts/2/avatar/",
    )
    const workspace10Key = `${contactAvatarPrefix("10", "2")}abc`
    const contact20Key = `${contactAvatarPrefix("1", "20")}abc`
    expect(workspace10Key.startsWith(workspaceContactFilesPrefix("1"))).toBe(
      false,
    )
    expect(contact20Key.startsWith(contactAvatarPrefix("1", "2"))).toBe(false)
  })

  test("a contact's avatar prefix sits inside its workspace's contact-files prefix", () => {
    expect(
      contactAvatarPrefix("ws", "c").startsWith(
        workspaceContactFilesPrefix("ws"),
      ),
    ).toBe(true)
  })
})

describe("isContactAvatarKey", () => {
  test("matches only a key directly under some contact's avatar prefix", () => {
    expect(isContactAvatarKey(`${contactAvatarPrefix("1", "2")}k`)).toBe(true)
    for (const key of [
      "public/space/1/avatars/k",
      "public/space/1/contacts/2/avatar/",
      "public/space/1/contacts/2/avatar/a/b",
      "https://x/public/space/1/contacts/2/avatar/k",
      "workspaces/1/documents/2/k.pdf",
    ]) {
      expect(isContactAvatarKey(key)).toBe(false)
    }
  })
})
