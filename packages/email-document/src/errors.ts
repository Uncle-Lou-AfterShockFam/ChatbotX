/** Any schema miss; `path` points at the offending key (zod issue path). */
export class DocumentValidationError extends Error {
  readonly issues: Array<{ path: PropertyKey[]; message: string }>

  constructor(issues: Array<{ path: PropertyKey[]; message: string }>) {
    super(
      `invalid email document: ${issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
        .join("; ")}`,
    )
    this.name = "DocumentValidationError"
    this.issues = issues
  }
}

/** The serialized document is over the byte cap. */
export class DocumentTooLargeError extends Error {
  readonly bytes: number

  constructor(bytes: number, limit: number) {
    super(`email document is ${bytes} bytes (limit ${limit})`)
    this.name = "DocumentTooLargeError"
    this.bytes = bytes
  }
}

/** `columns` nested in `columns` (impossible by schema; asserted at render). */
export class DocumentDepthError extends Error {
  constructor() {
    super("email document nests columns inside columns")
    this.name = "DocumentDepthError"
  }
}
