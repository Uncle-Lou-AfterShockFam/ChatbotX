import { z } from "zod"

/**
 * Hub invoicing (s205b). An Invoice is the hub's ledger row; a provider
 * (Stripe Invoices today, Stripe Checkout and WooCommerce later) collects it.
 * `draft` = hub row exists, provider not finalized yet (a failed finalize
 * stays here with `lastError` and can be retried). Terminal states never
 * regress: see `INVOICE_STATUS_TRANSITIONS`.
 */
export const invoiceStatuses = z.enum([
  "draft",
  "open",
  "paid",
  "void",
  "uncollectible",
  "refunded",
])
export type InvoiceStatus = z.infer<typeof invoiceStatuses>

/**
 * How an invoice is collected. `stripeInvoice`: a real Stripe Invoice (Stripe
 * hosts the page and the PDF). `stripeCheckout` (s207b): a one-off Checkout
 * Session minted on each visit to the hub's stable `/pay/<token>` link; no
 * card is saved. A request may also say `default`: the workspace's choice.
 */
export const invoiceMethods = z.enum(["stripeInvoice", "stripeCheckout"])
export type InvoiceMethod = z.infer<typeof invoiceMethods>
export const requestedInvoiceMethods = z.enum([
  "default",
  ...invoiceMethods.options,
])
export type RequestedInvoiceMethod = z.infer<typeof requestedInvoiceMethods>

/** Base62, 22 characters = 128 random bits: the only secret in `/pay/<token>`. */
export const INVOICE_PAY_TOKEN_LENGTH = 22

/**
 * Allowed `from` states for each target state. A webhook that arrives out of
 * order (payment_failed after paid) finds its `from` set empty for the row's
 * current state and is recorded but applied as a no-op.
 */
export const INVOICE_STATUS_TRANSITIONS: Record<
  InvoiceStatus,
  readonly InvoiceStatus[]
> = {
  draft: [],
  open: ["draft"],
  paid: ["draft", "open", "uncollectible"],
  void: ["draft", "open", "uncollectible"],
  uncollectible: ["open"],
  refunded: ["paid"],
}

/** A Stripe secret or restricted key; `livemode` follows the prefix. Client-safe. */
export const STRIPE_SECRET_KEY_PATTERN =
  /^(sk|rk)_(test|live)_[A-Za-z0-9]{16,256}$/
export const STRIPE_WEBHOOK_SECRET_PATTERN = /^whsec_[A-Za-z0-9+/=]{16,256}$/

export const DEFAULT_INVOICE_CURRENCY = "USD"
export const INVOICE_MAX_LINE_ITEMS = 50
export const INVOICE_MAX_QUANTITY = 10_000
export const INVOICE_MAX_DUE_DAYS = 365
export const INVOICE_DESCRIPTION_MAX = 500
export const INVOICE_MEMO_MAX = 1000

/**
 * Stripe zero-decimal currencies (docs.stripe.com/currencies#zero-decimal).
 * Amounts in these are whole units; a fractional input is rejected.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
])

/**
 * Refused: Stripe's three-decimal currencies (numeric(14,2) storage) and its
 * special cases ISK / UGX, zero-decimal currencies Stripe still takes in
 * two-decimal amounts. Fail closed rather than bill 100x.
 */
const UNSUPPORTED_CURRENCIES = new Set([
  "BHD",
  "JOD",
  "KWD",
  "OMR",
  "TND",
  "ISK",
  "UGX",
])

const ISO_CURRENCY = /^[A-Z]{3}$/
const MONEY_INPUT = /^(\d{1,12})(?:\.(\d{1,2}))?$/
/**
 * Commas only as thousands groups, and only where that reading is certain:
 * two or more groups, or a decimal point ("1,250.50", "1,234,567"). A single
 * group ("12,500") is refused: a decimal-comma writer means 12.5.
 */
const GROUPED_MONEY_INPUT =
  /^\d{1,3}(?:(?:,\d{3}){2,}(?:\.\d{1,2})?|,\d{3}\.\d{1,2})$/

/** Upper bound of numeric(14,2): 12 integer digits. */
const MAX_MINOR = 999_999_999_999_99n

/**
 * Normalise an invoice currency to upper-case ISO 4217, or null when it is not
 * a three-letter code or is a currency the hub refuses (see UNSUPPORTED_CURRENCIES).
 */
export function normalizeInvoiceCurrency(value: unknown): string | null {
  if (typeof value !== "string") {
    return null
  }
  const upper = value.trim().toUpperCase()
  if (!ISO_CURRENCY.test(upper) || UNSUPPORTED_CURRENCIES.has(upper)) {
    return null
  }
  return upper
}

export function currencyExponent(currency: string): 0 | 2 {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2
}

/**
 * Parse a money input EXACTLY (no floating point) into minor units of
 * `currency`. Accepts "1,250.50", "1250.5", "7"; refuses a decimal comma ("12,50"), an ambiguous single group ("12,500") and inner spaces ("12 50"); numbers only when they are
 * safe integers or have at most two decimals when printed. Returns null for
 * negatives, NaN, more than two decimals, a fraction in a zero-decimal
 * currency, or anything past numeric(14,2).
 */
export function parseMoneyToMinor(
  value: unknown,
  currency: string,
): bigint | null {
  let text: string
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      return null
    }
    text = String(value)
  } else if (typeof value === "string") {
    // Only the edges are trimmed: "12 50" is refused, never read as 1250.
    text = value.trim()
    if (text.includes(",")) {
      if (!GROUPED_MONEY_INPUT.test(text)) {
        return null
      }
      text = text.replaceAll(",", "")
    }
  } else {
    return null
  }
  const match = MONEY_INPUT.exec(text)
  if (!match) {
    return null
  }
  const whole = BigInt(match[1] as string)
  const fraction = (match[2] ?? "").padEnd(2, "0")
  const exponent = currencyExponent(currency)
  if (exponent === 0 && fraction !== "00") {
    return null
  }
  const minor = exponent === 0 ? whole : whole * 100n + BigInt(fraction)
  if (minor > MAX_MINOR) {
    return null
  }
  return minor
}

/** Minor units -> the numeric(14,2) string the database returns. */
export function minorToDecimalString(minor: bigint, currency: string): string {
  if (minor < 0n) {
    throw new RangeError("minorToDecimalString: negative amount")
  }
  if (currencyExponent(currency) === 0) {
    return `${minor}.00`
  }
  const whole = minor / 100n
  const cents = minor % 100n
  return `${whole}.${cents.toString().padStart(2, "0")}`
}

/** A stored numeric(14,2) string -> minor units (exact). */
export function decimalStringToMinor(value: string, currency: string): bigint {
  const minor = parseMoneyToMinor(value, currency)
  if (minor === null) {
    throw new RangeError(`decimalStringToMinor: not a stored amount: ${value}`)
  }
  return minor
}
