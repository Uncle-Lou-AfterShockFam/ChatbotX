import {
  type FormDefinition,
  type FormField,
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
const LIST_SEPARATOR_RE = /[,;\n]+/

const YES = new Set(["yes", "y", "true", "1", "ok", "agree", "i agree"])
const NO = new Set(["no", "n", "false", "0"])

/** A reply that skips an OPTIONAL question (the caller checks required-ness). */
export const FORM_CHAT_SKIP_WORD = "skip"

export const isFormChatSkip = (text: string): boolean =>
  text.trim().toLowerCase() === FORM_CHAT_SKIP_WORD

/** An option by its 1-based number, its value or its label (case-insensitive). */
export function matchFormOption(
  field: Pick<FormField, "options">,
  text: string,
): string | null {
  const options = field.options ?? []
  const needle = text.trim().toLowerCase()
  if (needle === "") {
    return null
  }
  if (OPTION_NUMBER_RE.test(needle)) {
    const option = options[Number(needle) - 1]
    if (option) {
      return option.value
    }
  }
  const hit =
    options.find((o) => o.value.toLowerCase() === needle) ??
    options.find((o) => o.label.toLowerCase() === needle)
  return hit ? hit.value : null
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
      const word = trimmed.toLowerCase()
      if (YES.has(word)) {
        value = true
      } else if (NO.has(word)) {
        value = false
      } else {
        return { ok: false, code: "type" }
      }
      break
    }
    case "number": {
      const n = Number(trimmed.replace(",", "."))
      value = Number.isFinite(n) ? n : trimmed
      break
    }
    case "email":
      value = trimmed.toLowerCase()
      break
    default:
      value = trimmed
  }
  const code = validateFormField(field, value)
  return code === null ? { ok: true, value } : { ok: false, code }
}
