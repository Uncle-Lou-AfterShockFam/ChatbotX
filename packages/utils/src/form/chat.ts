import {
  type FormDefinition,
  type FormField,
  formInputFields,
  isFormInputFieldType,
  MAX_FORM_VALUE,
} from "./definition"
import {
  evaluateForm,
  evaluateFormCondition,
  type FormEvaluation,
  type FormValidationIssue,
  type FormValue,
  type FormValues,
  isEmptyFormValue,
  readFormValue,
  validateFormField,
} from "./evaluate"

/**
 * The chat runner's pure half (s219 A2-2): which question comes next, and
 * how a typed reply becomes a form answer. No I/O; the worker sends, the
 * business service locks and stores.
 *
 * Next-question rule, in order (Mautic `Field::showForContact` +
 * `DisplayManager`, audit 03 sec. ADOPT):
 *   1. steps in document order, only those the evaluator REACHED (a hidden
 *      or skipped step asks nothing);
 *   2. only visible input fields; `hidden` fields are never asked in chat;
 *   3. progressive profiling: `showAfterSubmissions` N hides the field until
 *      the contact has N earlier submissions, `showWhenKnown: false` hides it
 *      when the answer is already known, and a form-level `limit` caps how
 *      many fields one run asks (`alwaysDisplay` fields are counted first
 *      and always asked);
 *   4. the first remaining field not yet asked.
 * A field progressive profiling skips is SUPPRESSED: never seen, so its
 * required flag cannot block the submission (validateFormSubmission).
 */

export type FormChatProfileContext = {
  /** Field keys whose answer the contact already holds. */
  known: ReadonlySet<string>
  /** How many earlier submissions of this form the contact has. */
  priorSubmissions: number
  /** At most this many input fields asked in one run; null = no budget. */
  limit: number | null
}

export const NO_FORM_PROFILE: FormChatProfileContext = {
  known: new Set(),
  priorSubmissions: 0,
  limit: null,
}

export type FormChatPlan = {
  /** The next input field to ask, or null when nothing is left to ask. */
  next: FormField | null
  /** Heading / paragraph blocks to send before `next` (or before finishing). */
  preface: FormField[]
  /** Visible input fields this run will never ask. */
  suppressed: Set<string>
  evaluation: FormEvaluation
}

const isProfiledOut = (
  field: FormField,
  profile: FormChatProfileContext,
): boolean => {
  const rule = field.profile
  if (!rule) {
    return false
  }
  if ((rule.showAfterSubmissions ?? 0) > profile.priorSubmissions) {
    return true
  }
  return rule.showWhenKnown === false && profile.known.has(field.key)
}

/**
 * s220c A2-4: the visible input fields progressive profiling hides from a
 * KNOWN contact on the web page (identified by a signed form link): the chat
 * planner's own rules with nothing asked yet, minus `hidden` fields (never
 * rendered anyway). The page hides them and validation does not require them.
 */
export function formProfiledOutKeys(
  def: FormDefinition,
  values: FormValues,
  profile: FormChatProfileContext,
): Set<string> {
  const { suppressed } = planFormChat(def, values, new Set(), profile)
  for (const field of formInputFields(def)) {
    if (field.type === "hidden") {
      suppressed.delete(field.key)
    }
  }
  return suppressed
}

/**
 * Plan the next message of a chat run. `askedKeys` holds every key the run
 * has already sent (answered, skipped-optional, or a display block), so a
 * question is never asked twice and a block is never re-sent.
 */
export function planFormChat(
  def: FormDefinition,
  values: FormValues,
  askedKeys: ReadonlySet<string>,
  profile: FormChatProfileContext = NO_FORM_PROFILE,
): FormChatPlan {
  const evaluation = evaluateForm(def, values)
  // An optional question the contact skipped comes back once a later answer
  // makes it required (a form-level `require` rule): the run never finishes
  // with a required field empty.
  const asked = new Set(
    [...askedKeys].filter(
      (key) =>
        !(
          evaluation.requiredFields.has(key) &&
          isEmptyFormValue(readFormValue(values, key))
        ),
    ),
  )
  const read = (key: string): FormValue =>
    evaluation.visibleFields.has(key) ? readFormValue(values, key) : undefined

  // Document order over reached steps: display blocks and input candidates.
  const ordered: { field: FormField; input: boolean }[] = []
  const suppressed = new Set<string>()
  for (const step of def.steps) {
    if (!evaluation.visibleSteps.has(step.id)) {
      continue
    }
    for (const field of step.fields) {
      if (!isFormInputFieldType(field.type)) {
        const shown =
          field.type !== "divider" &&
          (field.visibleWhen
            ? evaluateFormCondition(field.visibleWhen, read)
            : true)
        if (shown) {
          ordered.push({ field, input: false })
        }
        continue
      }
      if (!evaluation.visibleFields.has(field.key)) {
        continue
      }
      if (
        field.type === "hidden" ||
        (!asked.has(field.key) && isProfiledOut(field, profile))
      ) {
        suppressed.add(field.key)
        continue
      }
      ordered.push({ field, input: true })
    }
  }

  if (profile.limit !== null) {
    const inputs = ordered.filter((o) => o.input).map((o) => o.field)
    const always = inputs.filter((f) => f.profile?.alwaysDisplay)
    // Fields already asked were within budget when asked: spend them first,
    // then hand what is left to the unasked fields in document order.
    let spent =
      always.length +
      inputs.filter((f) => !f.profile?.alwaysDisplay && asked.has(f.key)).length
    for (const field of inputs) {
      if (field.profile?.alwaysDisplay || asked.has(field.key)) {
        continue
      }
      if (spent < profile.limit) {
        spent++
      } else {
        suppressed.add(field.key)
      }
    }
  }

  const preface: FormField[] = []
  for (const { field, input } of ordered) {
    if (asked.has(field.key) || suppressed.has(field.key)) {
      continue
    }
    if (input) {
      return { next: field, preface, suppressed, evaluation }
    }
    preface.push(field)
  }
  return { next: null, preface, suppressed, evaluation }
}

export type FormChatAnswer =
  | { ok: true; value: FormValue }
  | { ok: false; code: FormValidationIssue["code"] }

const OPTION_NUMBER_RE = /^\d{1,3}$/
const DIGITS_RE = /^\d+$/
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T/
const LIST_SEPARATOR_RE = /[,;\n]+/

const YES = new Set(["yes", "y", "true", "1", "ok", "agree", "i agree"])
const NO = new Set(["no", "n", "false", "0"])

/** A reply that skips an OPTIONAL question (the caller checks required-ness). */
export const FORM_CHAT_SKIP_WORD = "skip"

/**
 * A quick-reply button's payload: `askform:<n>` (option n, 0-based),
 * `askform:skip`, `askform:yes`, `askform:no`. Opaque on purpose: a channel
 * that echoes the payload (Telegram) must not send an option VALUE that
 * reads as an option number, or as a flow button payload like `10:30`
 * (blind probe, s219 A2-2).
 */
export const FORM_CHAT_PAYLOAD_PREFIX = "askform:"
const PAYLOAD_RE = /^askform:([a-z0-9]{1,8})$/

export const formChatPayload = (token: string | number): string =>
  `${FORM_CHAT_PAYLOAD_PREFIX}${token}`

const payloadToken = (text: string): string | null =>
  PAYLOAD_RE.exec(text.trim().toLowerCase())?.[1] ?? null

export const isFormChatSkip = (text: string): boolean => {
  const word = text.trim().toLowerCase()
  return word === FORM_CHAT_SKIP_WORD || payloadToken(word) === "skip"
}

/**
 * True when an option can be picked by its number: no option value or label
 * is itself all digits, which would make "2" ambiguous. The chat prompt
 * numbers the list only then.
 */
export const formOptionsNumbered = (
  field: Pick<FormField, "options">,
): boolean =>
  !(field.options ?? []).some(
    (o) => OPTION_NUMBER_RE.test(o.value) || OPTION_NUMBER_RE.test(o.label),
  )

/**
 * An option by its button payload, its label, its value, or (only when the
 * list is numbered) its 1-based number; case-insensitive.
 */
export function matchFormOption(
  field: Pick<FormField, "options">,
  text: string,
): string | null {
  const options = field.options ?? []
  const needle = text.trim().toLowerCase()
  if (needle === "") {
    return null
  }
  const token = payloadToken(needle)
  if (token !== null) {
    return DIGITS_RE.test(token)
      ? (options[Number(token)]?.value ?? null)
      : null
  }
  const hit =
    options.find((o) => o.label.toLowerCase() === needle) ??
    options.find((o) => o.value.toLowerCase() === needle)
  if (hit) {
    return hit.value
  }
  if (OPTION_NUMBER_RE.test(needle) && formOptionsNumbered(field)) {
    return options[Number(needle) - 1]?.value ?? null
  }
  return null
}

/**
 * Turn one chat reply into the field's answer and validate it with the SAME
 * per-field rule the web submit uses. `text` is the reply already reduced to
 * a string by the worker (an attachment's URL, a shared location as
 * "lat,lng", a picked date as ISO); anything else is the typed text.
 */
export function parseFormChatAnswer(
  field: FormField,
  text: unknown,
): FormChatAnswer {
  if (typeof text !== "string") {
    return { ok: false, code: "type" }
  }
  const trimmed = text.trim()
  if (trimmed === "") {
    return { ok: false, code: "required" }
  }
  if (trimmed.length > MAX_FORM_VALUE) {
    return { ok: false, code: "length" }
  }
  let value: FormValue
  switch (field.type) {
    case "select":
    case "radio": {
      const hit = matchFormOption(field, trimmed)
      if (hit === null) {
        return { ok: false, code: "option" }
      }
      value = hit
      break
    }
    case "checkboxGroup": {
      const picked = new Set<string>()
      for (const token of trimmed.split(LIST_SEPARATOR_RE)) {
        if (token.trim() === "") {
          continue
        }
        const hit = matchFormOption(field, token)
        if (hit === null) {
          return { ok: false, code: "option" }
        }
        picked.add(hit)
      }
      if (picked.size === 0) {
        return { ok: false, code: "required" }
      }
      // Option order, not reply order, so two replies store alike.
      value = (field.options ?? [])
        .map((o) => o.value)
        .filter((v) => picked.has(v))
      break
    }
    case "checkbox": {
      const word = payloadToken(trimmed) ?? trimmed.toLowerCase()
      if (YES.has(word)) {
        value = true
      } else if (NO.has(word)) {
        value = false
      } else {
        return { ok: false, code: "type" }
      }
      break
    }
    case "number":
    case "slider":
    case "rating": {
      const n = Number(trimmed.replace(",", "."))
      value = Number.isFinite(n) ? n : trimmed
      break
    }
    case "email":
      value = trimmed.toLowerCase()
      break
    case "date":
      // The date picker answers with an ISO instant at UTC midnight; the
      // field stores the day (blind probe, s219 A2-2).
      value = ISO_INSTANT_RE.test(trimmed) ? trimmed.slice(0, 10) : trimmed
      break
    default:
      value = trimmed
  }
  const code = validateFormField(field, value)
  return code === null ? { ok: true, value } : { ok: false, code }
}
