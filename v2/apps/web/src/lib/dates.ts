/** A stored calendar day is midnight UTC, or a date-only string. A real moment is not. */
export const isCalendarDay = (iso: string | Date) =>
  typeof iso === "string" && (/T00:00:00(\.000)?Z$/.test(iso) || /^\d{4}-\d{2}-\d{2}$/.test(iso));

/**
 * Value for `<input type="date">`. A stored calendar day stays that UTC day.
 * A real moment, including the payment form's default of now, uses the local
 * calendar day, so a US evening does not offer tomorrow.
 */
export const toInputDate = (iso: string | Date) => {
  if (isCalendarDay(iso)) return new Date(iso).toISOString().slice(0, 10);
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
};
