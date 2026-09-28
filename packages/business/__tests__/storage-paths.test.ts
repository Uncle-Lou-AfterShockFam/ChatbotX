import { describe, expect, test } from "vitest"
import {
  contactAvatarPrefix,
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
