/** `Date | null` -> the yyyy-mm-dd an <input type="date"> shows. */
export const toDateInput = (value: Date | null | undefined): string =>
  value ? value.toISOString().slice(0, 10) : ""
