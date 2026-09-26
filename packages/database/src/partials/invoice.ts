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

export const invoiceMethods = z.enum(["stripeInvoice"])
export type InvoiceMethod = z.infer<typeof invoiceMethods>

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
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
])

/** Stripe three-decimal currencies: not supported (numeric(14,2) storage). */
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "JOD", "KWD", "OMR", "TND"])

const ISO_CURRENCY = /^[A-Z]{3}$/
const MONEY_INPUT = /^(\d{1,12})(?:\.(\d{1,2}))?$/
/** Commas only as 3-digit thousands groups: "1,250.50" yes, "12,50" no (that is a decimal comma). */
const GROUPED_MONEY_INPUT = /^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/
const MONEY_SPACES = /[\s_]/g

/** Upper bound of numeric(14,2): 12 integer digits. */
const MAX_MINOR = 999_999_999_999_99n

/**
 * Normalise an invoice currency to upper-case ISO 4217, or null when it is not
 * a three-letter code or is a three-decimal currency the hub cannot store.
 */
export function normalizeInvoiceCurrency(value: unknown): string | null {
  if (typeof value !== "string") {
    return null
  }
  const upper = value.trim().toUpperCase()
  if (!ISO_CURRENCY.test(upper) || THREE_DECIMAL_CURRENCIES.has(upper)) {
    return null
  }
  return upper
}

export function currencyExponent(currency: string): 0 | 2 {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2
}

/**
 * Parse a money input EXACTLY (no floating point) into minor units of
 * `currency`. Accepts "1,250.50", "1250.5", "7" (a decimal comma like "12,50" is rejected, never read as 1250); numbers only when they are
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
    text = value.replace(MONEY_SPACES, "")
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
