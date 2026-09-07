import type { DateOrder } from './dates'

export type PaymentSource = 'venmo' | 'zelle' | 'other'

/**
 * What a spreadsheet column means. `description` is distinct from `note`: a
 * description is the bank's own free-text blob that we mine for a payer name,
 * whereas a note is what the payer typed ("Q3 raffle - 4 tickets").
 */
export type ColumnRole =
  | 'date'
  | 'amount'
  | 'credit'
  | 'debit'
  | 'payer_name'
  | 'payer_email'
  | 'payer_phone'
  | 'payer_handle'
  | 'note'
  | 'description'
  | 'external_ref'
  | 'status'
  | 'type'

export const COLUMN_ROLE_LABELS: Record<ColumnRole, string> = {
  date: 'Date',
  amount: 'Amount',
  credit: 'Credit / Money in',
  debit: 'Debit / Money out',
  payer_name: 'Payer name',
  payer_email: 'Payer email',
  payer_phone: 'Payer phone',
  payer_handle: 'Payer handle',
  note: 'Note / memo',
  description: 'Bank description',
  external_ref: 'Transaction ID',
  status: 'Status',
  type: 'Transaction type',
}

/**
 * How to read one particular CSV layout. Saved as a reusable preset so the
 * second import of any given bank's format is one click.
 */
export interface ColumnMapping {
  /** Row index (0-based, in the raw grid) that holds the real header. */
  headerRowIndex: number
  /** Role -> column index. Absent roles are simply unavailable in this file. */
  roles: Partial<Record<ColumnRole, number>>
  /** How to read ambiguous numeric dates. */
  dateOrder: DateOrder
  /**
   * How to tell money in from money out:
   *  - 'sign'            a single amount column, negative means outgoing
   *  - 'credit_debit'    separate credit and debit columns
   *  - 'type_column'     a type/status column names the direction
   *  - 'all_incoming'    treat every row as money in (small, hand-made files)
   */
  directionMode: 'sign' | 'credit_debit' | 'type_column' | 'all_incoming'
  source: PaymentSource
}

/** Every machine-readable flag a payment row can carry into the review queue. */
export const PAYMENT_FLAGS = {
  partial_amount: 'Amount is not a whole number of tickets; the remainder needs a decision',
  entries_overridden: 'Entry count was set by hand rather than computed',
  zero_entries: 'Amount is less than the price of one ticket',
  outgoing: 'Money leaving the account, not a ticket purchase',
  negative_amount: 'Amount was negative in the source file',
  unparseable_amount: 'Could not read the amount',
  unparseable_date: 'Could not read the date',
  missing_date: 'No date in this row',
  outside_window: 'Dated outside this drawing’s window',
  missing_payer: 'No payer name, email, phone or handle could be identified',
  name_from_description: 'Payer name was extracted from the bank description and should be confirmed',
  duplicate_suspected: 'Looks identical to a payment already imported',
  large_amount: 'Unusually large amount',
  ambiguous_date_order: 'Date could be read as either MM/DD or DD/MM',
  ambiguous_separator: 'Thousands/decimal separator was ambiguous',
  non_usd_currency: 'Amount may not be in US dollars',
  excess_precision: 'Amount had more than two decimal places',
  assumed_century: 'Two-digit year; century was assumed',
  failed_status: 'Source marked this transaction as failed, pending or cancelled',
  formula_sanitized: 'A cell began with a spreadsheet formula character and was neutralised',
} as const

export type PaymentFlag = keyof typeof PAYMENT_FLAGS

/** One CSV row after normalisation, ready to become a `payments` record. */
export interface NormalizedPayment {
  sourceRowNumber: number
  source: PaymentSource
  rawPayerName: string | null
  payerName: string | null
  payerEmail: string | null
  payerPhone: string | null
  payerHandle: string | null
  paidOn: string | null
  paidAt: string | null
  amountCents: number
  direction: 'in' | 'out'
  note: string | null
  externalRef: string | null
  entries: number
  remainderCents: number
  flags: PaymentFlag[]
  dedupeHash: string
  rawRow: Record<string, string>
}

export interface ImportPreview {
  headerRowIndex: number
  headers: string[]
  mapping: ColumnMapping
  rows: NormalizedPayment[]
  /** Rows that could not be turned into a payment at all, with the reason. */
  rejected: Array<{ sourceRowNumber: number; reason: string; rawRow: Record<string, string> }>
  totals: {
    rowCount: number
    usableCount: number
    incomingCount: number
    outgoingCount: number
    totalCents: number
    totalEntries: number
    unallocatedCents: number
    flaggedCount: number
  }
}
