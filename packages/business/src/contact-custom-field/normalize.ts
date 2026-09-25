import { type DatabaseClient, db } from "@chatbotx.io/database/client"
import type { CustomFieldType } from "@chatbotx.io/database/partials"
import {
  canonicalMultiSelectValue,
  canonicalNumberLiteral,
  canonicalSelectValue,
  coerceBooleanLiteral,
} from "@chatbotx.io/utils/custom-field"
import {
  currentTemporalLiteral,
  DEFAULT_FILTER_TIMEZONE,
  hasExplicitOffset,
  isTemporalCustomFieldType,
  resolveFilterTimezone,
  SourceTimezoneStrategy,
  type TemporalCustomFieldType,
  TemporalInputParsing,
} from "@chatbotx.io/utils/datetime"
import { normalizeTemporalValueForStorage } from "@chatbotx.io/utils/temporal-input"
import { normalizeStoredTimezone } from "../contact-locale"
import { ChatbotXException } from "../errors"

export type SourceTimezoneResolver = () => Promise<string>

const MAX_ERROR_VALUE_LENGTH = 80

const previewValue = (value: string): string =>
  value.length > MAX_ERROR_VALUE_LENGTH
    ? `${value.slice(0, MAX_ERROR_VALUE_LENGTH)}…`
    : value

const invalidNumberException = (value: string): ChatbotXException =>
  new ChatbotXException(
    `"${previewValue(value)}" is not a valid number value for this field.`,
    "invalidCustomFieldValue",
    400,
  )

const invalidOptionException = (
  value: string,
  options: readonly string[],
): ChatbotXException =>
  new ChatbotXException(
    `"${previewValue(value)}" is not one of this field's options (${previewValue(options.join(", "))}).`,
    "invalidCustomFieldValue",
    400,
  )

/** An option field must carry its list; a missing one is a server-side bug. */
const requireOptions = (
  options: readonly string[] | null | undefined,
): readonly string[] => {
  if (!options || options.length === 0) {
    throw new ChatbotXException(
      "This select field has no options configured.",
      "invalidCustomFieldValue",
      400,
    )
  }
  return options
}

type NonTemporalCustomFieldType = Exclude<
  CustomFieldType,
  TemporalCustomFieldType
>

/**
 * Generous runtime coercion for every non-temporal type, applied at every
 * WRITE chokepoint (contact custom fields, bot fields) so a flow/trigger/API
 * write that carries arbitrary user text can never persist garbage:
 * - `boolean` never throws (see `coerceBooleanLiteral`) — a chatbot flow must
 *   not crash on unexpected text.
 * - `number` throws a typed `ChatbotXException` on unparseable input (unlike
 *   boolean, silently coercing a bad number would hide a real authoring bug)
 *   — a blank string stays blank (means "unset", not "invalid").
 * - `shortText`/`longText`/`email`/`phoneNumber` pass through byte-identical:
 *   trimming/lowercasing here would change existing flow/tool/API behavior
 *   for callers that bypass zod, which is explicitly out of scope this phase.
 *
 * - `select` / `multiSelect` (s201) accept only the field's own options
 *   (case-insensitive, stored in the option's canonical spelling); an unknown
 *   option throws a typed exception, never a silent drop. A multiSelect is
 *   stored as canonical JSON-array text in option order.
 *
 * Registry, not an if-else ladder, so a new type only means adding one row.
 */
const RUNTIME_COERCE_HANDLERS = {
  // Blank means "unset" and stays blank (user-confirmed, symmetric with
  // `number` below) — only a non-blank value is coerced to "true"/"false".
  boolean: (value: string): string =>
    value.trim().length === 0 ? "" : coerceBooleanLiteral(value),
  number: (value: string): string => {
    // Delegates to the shared `canonicalNumberLiteral` (its own trim covers
    // " 1.5 " from free-text writes — flow {{variables}}, trigger actions —
    // surrounding whitespace is never numerically meaningful). The explicit
    // trim check here only distinguishes blank ("" -> unset, never throws)
    // from genuinely unparseable input (throws).
    if (value.trim().length === 0) {
      return ""
    }
    const canonical = canonicalNumberLiteral(value)
    if (canonical === null) {
      throw invalidNumberException(value)
    }
    return canonical
  },
  shortText: (value: string): string => value,
  longText: (value: string): string => value,
  email: (value: string): string => value,
  phoneNumber: (value: string): string => value,
  select: (value: string, options?: readonly string[] | null): string => {
    const known = requireOptions(options)
    const canonical = canonicalSelectValue(value, known)
    if (canonical === null) {
      throw invalidOptionException(value, known)
    }
    return canonical
  },
  multiSelect: (value: string, options?: readonly string[] | null): string => {
    const known = requireOptions(options)
    const result = canonicalMultiSelectValue(value, known)
    if (result.ok) {
      return result.value
    }
    if (result.reason === "unknownOption") {
      throw invalidOptionException(result.unknown.join(", "), known)
    }
    throw new ChatbotXException(
      result.reason === "tooManyItems"
        ? "Too many items for this multi-select field."
        : "A multi-select value must be a list of option names.",
      "invalidCustomFieldValue",
      400,
    )
  },
} as const satisfies Record<
  NonTemporalCustomFieldType,
  (value: string, options?: readonly string[] | null) => string
>

const TEMPORAL_SOURCE_TIMEZONE_REQUIRED = {
  date: () => true,
  datetime: (value: string) => !hasExplicitOffset(value),
} as const satisfies Record<TemporalCustomFieldType, (value: string) => boolean>

// Which temporal types anchor to the submitter's explicit client/browser zone.
// Only `date` does: the calendar day the user picked is local to them. A naive
// `datetime` must NOT — its stored UTC instant stays anchored to the
// contact/workspace zone no matter who submits it, so the same wall-clock
// moment never drifts between submitters.
const TEMPORAL_HONORS_EXPLICIT_TIMEZONE = {
  date: true,
  datetime: false,
} as const satisfies Record<TemporalCustomFieldType, boolean>

const resolveSourceTimezone = async (input: {
  workspaceId: string
  contactId: string
  strategy: SourceTimezoneStrategy
  tx?: DatabaseClient
}): Promise<string> => {
  const query = input.tx ?? db

  if (input.strategy === SourceTimezoneStrategy.Workspace) {
    const workspace = await query.query.workspaceModel.findFirst({
      where: { id: input.workspaceId },
      columns: { timezone: true },
    })
    return resolveFilterTimezone(normalizeStoredTimezone(workspace?.timezone))
  }

  const [contact, workspace] = await Promise.all([
    query.query.contactModel.findFirst({
      where: { id: input.contactId, workspaceId: input.workspaceId },
      columns: { timezone: true },
    }),
    query.query.workspaceModel.findFirst({
      where: { id: input.workspaceId },
      columns: { timezone: true },
    }),
  ])

  return resolveFilterTimezone(
    normalizeStoredTimezone(contact?.timezone) ??
      normalizeStoredTimezone(workspace?.timezone),
  )
}

export const createSourceTimezoneResolver = (input: {
  workspaceId: string
  contactId: string
  strategy?: SourceTimezoneStrategy
  /**
   * An explicit source zone (e.g. a flow step's captured editor browser zone)
   * that anchors EVERY temporal type outright, short-circuiting the
   * contact/workspace DB lookup. Unlike `normalizeCustomFieldValueForStorage`'s
   * `explicitTimezone` — which only `date` honors — this drives the resolver
   * itself, so a naive `datetime` (which always consults the resolver) also
   * anchors here. Ignored when blank/unrecognized.
   */
  explicitSourceTimezone?: string | null
  tx?: DatabaseClient
}): SourceTimezoneResolver => {
  const override = normalizeStoredTimezone(input.explicitSourceTimezone)
  if (override) {
    const overrideZone = resolveFilterTimezone(override)
    return () => Promise.resolve(overrideZone)
  }

  let sourceTimezonePromise: Promise<string> | undefined
  const strategy = input.strategy ?? SourceTimezoneStrategy.ContactThenWorkspace

  return async () => {
    sourceTimezonePromise ??= resolveSourceTimezone({
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      strategy,
      tx: input.tx,
    })
    return await sourceTimezonePromise
  }
}

/**
 * Source zone whose offset anchors a temporal value at write time.
 *
 * - Offset-bearing `datetime` carries its own zone already, so no source zone
 *   is needed and we use UTC.
 * - `date` always needs a source zone: it stores the calendar day as start of
 *   day in the chosen source zone, including lenient unix/offset inputs.
 * - Type honors the submitter's browser zone (`date`) and one was captured
 *   -> that explicit zone wins outright, no contact/workspace DB lookup.
 * - Otherwise -> fall back to the memoized contact -> workspace -> UTC resolver.
 */
const resolveTemporalSourceTimezone = async (input: {
  type: TemporalCustomFieldType
  value: string
  explicitTimezone?: string | null
  resolveSourceTimezone: SourceTimezoneResolver
}): Promise<string> => {
  const { type, value, explicitTimezone, resolveSourceTimezone } = input

  if (!TEMPORAL_SOURCE_TIMEZONE_REQUIRED[type](value)) {
    return DEFAULT_FILTER_TIMEZONE
  }

  if (TEMPORAL_HONORS_EXPLICIT_TIMEZONE[type]) {
    const explicit = normalizeStoredTimezone(explicitTimezone)
    if (explicit) {
      return resolveFilterTimezone(explicit)
    }
  }

  return await resolveSourceTimezone()
}

export const normalizeCustomFieldValueForStorage = async (input: {
  type: CustomFieldType
  value: string
  /** The field's option list; required for `select` / `multiSelect`. */
  options?: readonly string[] | null
  resolveSourceTimezone: SourceTimezoneResolver
  /**
   * Browser zone captured at form submit. Honored only by `date` (see
   * TEMPORAL_HONORS_EXPLICIT_TIMEZONE); `datetime` ignores it and keeps
   * resolving via the stored contact/workspace zones.
   */
  explicitTimezone?: string | null
  /**
   * Strict (default): accept only canonical ISO. Lenient: run the loose
   * multi-format parser first. Non-temporal types ignore it.
   */
  temporalInputParsing?: TemporalInputParsing
  /**
   * When a temporal `value` is blank, stamp the current date/datetime in the
   * resolved source zone instead of storing an empty string. Used by the flow
   * "set custom field" step so an empty date/datetime records "now". Non-empty
   * values and non-temporal types are unaffected.
   */
  fillEmptyTemporalWithNow?: boolean
}): Promise<string | null> => {
  const {
    type,
    value,
    options,
    resolveSourceTimezone,
    explicitTimezone,
    temporalInputParsing = TemporalInputParsing.Strict,
    fillEmptyTemporalWithNow = false,
  } = input

  if (!isTemporalCustomFieldType(type)) {
    return RUNTIME_COERCE_HANDLERS[type](value, options)
  }

  const isEmpty = value.length === 0
  if (isEmpty && !fillEmptyTemporalWithNow) {
    return value
  }

  const sourceTimezone = await resolveTemporalSourceTimezone({
    type,
    value,
    explicitTimezone,
    resolveSourceTimezone,
  })

  // A blank value becomes the canonical "now" literal in the resolved zone,
  // which is already canonical ISO, so it normalizes under Strict regardless of
  // the caller's parsing mode.
  return isEmpty
    ? normalizeTemporalValueForStorage({
        type,
        value: currentTemporalLiteral(type, sourceTimezone),
        timezone: sourceTimezone,
        parsing: TemporalInputParsing.Strict,
      })
    : normalizeTemporalValueForStorage({
        type,
        value,
        timezone: sourceTimezone,
        parsing: temporalInputParsing,
      })
}
