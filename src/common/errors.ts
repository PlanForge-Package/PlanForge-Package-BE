import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Refusals the caller can act on, as codes.
 *
 * A message alone cannot be translated: it reaches the screen as a finished sentence,
 * in whatever language BE happened to be written in. The code travels with the values
 * that vary, and the screen renders it in the reader's language.
 *
 * The English text here is not dead weight — it is what an API client, a log line and
 * a failing test see. It is the fallback when the screen has no entry for a code yet,
 * which is what a newly added code looks like before the dictionary catches up.
 *
 * Adding one: put it here with its English sentence, then add the same key to the four
 * dictionaries in FE. The screen falls back to this text until you do.
 */
export const ERROR_MESSAGES = {
  // --- Scope and identity ---------------------------------------------------
  PROPERTY_REQUIRED: () => 'Select a hotel.',
  PROPERTY_NOT_FOUND: (p: P) => `Hotel not found: ${p.propertyId}`,
  PROPERTY_CODE_TAKEN: () => 'That OPERA hotel code is already registered.',
  OTHER_PROPERTY_FORBIDDEN: () => 'You cannot reach another hotel’s records.',
  ROLE_UNKNOWN: () => 'Your permissions could not be determined.',
  ROLE_FORBIDDEN: () => 'You do not have permission for this action.',
  TOKEN_REQUIRED: () => 'An authentication token is required.',
  SESSION_EXPIRED: () => 'Your session expired. Please sign in again.',
  TOKEN_INVALID: () => 'That token is not valid.',
  BAD_CREDENTIALS: () => 'That email or password is not correct.',
  ACCOUNT_DISABLED: () => 'That account is not usable. Please sign in again.',

  // --- Reservations ---------------------------------------------------------
  RESERVATION_NOT_FOUND: (p: P) => `Reservation not found: ${p.id}`,
  RESERVATION_NOT_LINKED: () =>
    'This reservation is not linked to OPERA. Sync it first, then try again.',
  RESERVATION_TARGET_REQUIRED: () => 'Name the reservation to act on.',
  DEPARTURE_BEFORE_ARRIVAL: () => 'The departure date must be after the arrival date.',
  RANGE_TOO_LONG: (p: P) => `A range can span at most ${p.days} days.`,
  NOT_WAITLISTED: (p: P) => `This reservation is not waitlisted: ${p.status}`,
  SHARE_OTHER_PROPERTY: () => 'A room cannot be shared with a reservation at another hotel.',
  NOT_SHARED: () => 'This reservation is not part of a share.',
  CHECK_IN_NOT_ALLOWED: (p: P) => `Check-in is not available in this status (${p.status}).`,
  CHECK_OUT_NOT_ALLOWED: (p: P) => `Check-out is not available in this status (${p.status}).`,
  ROOM_NUMBER_REQUIRED: () => 'No room number to assign.',
  ROOM_NOT_FOUND: (p: P) => `Room not found: ${p.room}`,
  ROOM_OCCUPIED: (p: P) => `Room ${p.room} is already in use.`,
  ROOM_NOT_SELLABLE: (p: P) => `Room ${p.room} is out of sale (${p.status}).`,
  BALANCE_OUTSTANDING: (p: P) => `An unpaid balance remains: ${p.amount}`,

  // --- Folios and postings --------------------------------------------------
  FOLIO_NOT_FOUND: (p: P) => `Folio not found: ${p.folioId}`,
  FOLIO_WINDOW_NOT_FOUND: (p: P) => `Folio not found: window ${p.window}`,
  FOLIO_WINDOW_NOT_OPEN: (p: P) => `Window ${p.window} is not open.`,
  FOLIO_TARGET_WINDOW_NOT_OPEN: (p: P) => `Window ${p.window} is not open. Open it first.`,
  FOLIO_CLOSED_NO_PAYMENT: () => 'A closed folio cannot take a payment.',
  FOLIO_CLOSED_NO_TRANSFER: () => 'A closed folio cannot be transferred.',
  POSTING_NOT_FOUND: (p: P) => `Posting not found: ${p.postingId}`,
  POSTING_NOT_LINKED: () => 'This posting is not linked to OPERA. Sync it first, then try again.',
  POSTING_FROM_PAYMENT: () =>
    'A posting created by a payment cannot be moved. Void the payment and take it again.',
  ROUTING_NOT_FOUND: (p: P) => `Routing instruction not found: ${p.transactionCode}`,

  // --- Payments -------------------------------------------------------------
  PAYMENT_NOT_FOUND: (p: P) => `Payment not found: ${p.paymentId}`,
  PAYMENT_TOKEN_REQUIRED: () => 'A card payment needs a payment token.',
  PAYMENT_DECLINED: (p: P) => `The payment was declined: ${p.reason}`,
  PAYMENT_OUTCOME_UNKNOWN: () =>
    'No response from the payment provider. It may have been authorised — check in the provider console.',
  PAYMENT_NOT_AUTHORIZED: (p: P) => `This payment is not authorised (${p.status}).`,
  PAYMENT_NOT_AUTHORIZED_REFUND_INSTEAD: (p: P) =>
    `This payment is not authorised (${p.status}). Refund a captured payment instead.`,
  PAYMENT_NOT_CAPTURED: (p: P) =>
    `Only a captured payment can be refunded (currently ${p.status}).`,
  PAYMENT_OFF_GATEWAY_CAPTURE: () =>
    'A payment that did not go through the provider cannot be captured.',
  PAYMENT_OFF_GATEWAY_VOID: () =>
    'A payment that did not go through the provider cannot be voided.',
  CAPTURE_OVER_AUTHORIZED: () => 'A capture cannot exceed the authorised amount.',
  CAPTURE_FAILED: (p: P) => `The capture failed: ${p.reason}`,
  VOID_FAILED: (p: P) => `The void failed: ${p.reason}`,
  REFUND_OVER_REMAINING: (p: P) => `That exceeds what can be refunded. Remaining: ${p.amount}`,
  REFUND_FAILED: (p: P) => `The refund failed: ${p.reason}`,

  // --- AR / city ledger -----------------------------------------------------
  AR_ACCOUNT_NOT_FOUND: (p: P) => `Account not found: ${p.id}`,
  AR_ACCOUNT_CODE_TAKEN: (p: P) => `That account code is already taken: ${p.code}`,
  AR_ACCOUNT_SUSPENDED: (p: P) => `That account is suspended: ${p.code}`,
  AR_ACCOUNT_OTHER_PROPERTY: () => 'A balance cannot be transferred to another hotel’s account.',
  AR_NOTHING_TO_TRANSFER: (p: P) =>
    `There is no balance to transfer: ${p.amount}. Only a window with a balance can be transferred.`,
  AR_CREDIT_LIMIT_EXCEEDED: (p: P) =>
    `That exceeds the credit limit. Limit ${p.limit}, after transfer ${p.after}`,
  AR_ALLOCATION_MODE_CONFLICT: () =>
    'Automatic and manual allocation cannot be combined. Choose one.',
  AR_ALLOCATION_INVOICE_INVALID: (p: P) =>
    `That invoice does not belong to this account, or is already settled: ${p.invoiceId}`,
  AR_ALLOCATION_OVER_OUTSTANDING: (p: P) =>
    `An allocation cannot exceed what the invoice still owes. Outstanding ${p.outstanding}, allocating ${p.amount}`,
  AR_ALLOCATION_DUPLICATE_INVOICE: () => 'The same invoice was named twice.',
  AR_ALLOCATION_OVER_PAYMENT: (p: P) =>
    `An allocation cannot exceed the payment. Payment ${p.payment}, allocated ${p.allocated}`,
  AR_NOTHING_TO_INVOICE: () => 'There is nothing unbilled to invoice.',
  AR_INVOICE_NOT_POSITIVE: (p: P) =>
    `The invoice total is ${p.total}. An invoice is only raised when something is owed.`,
  AR_INVOICE_NOT_FOUND: (p: P) => `Invoice not found: ${p.id}`,
  AR_INVOICE_VOID_FINAL: () => 'A voided invoice cannot be reinstated.',

  // --- Blocks ---------------------------------------------------------------
  BLOCK_NOT_FOUND: (p: P) => `Block not found: ${p.id}`,
  BLOCK_NOT_LINKED: () => 'This block is not linked to OPERA. Sync it first, then try again.',
  BLOCK_CUTOFF_AFTER_START: () => 'The cutoff date must precede the block start date.',
  END_BEFORE_START: () => 'The end date must be after the start date.',

  // --- Rates ----------------------------------------------------------------
  RATE_SELL_END_BEFORE_START: () => 'The selling end date must be after the start date.',
  RATE_AMOUNTS_EMPTY: () => 'No amount was given for any room type.',
  RATE_ROOM_TYPE_UNKNOWN: (p: P) => `Unknown room type: ${p.code}. Valid values: ${p.allowed}`,
  RATE_AMOUNT_INVALID: (p: P) =>
    `The ${p.code} amount must be a whole number of 0 or more: ${p.value}`,
  RATE_WEEKDAY_DUPLICATE: () => 'A weekday was listed twice.',

  // --- Housekeeping and rooms ----------------------------------------------
  ROOM_OCCUPIED_NO_OUT_OF_SALE: () => 'An occupied room cannot be taken out of sale.',
  TASK_NOT_FOUND: (p: P) => `Task not found: ${p.taskId}`,
  TASK_ASSIGNEE_INVALID: () => 'That account cannot be assigned.',
  TASK_ASSIGNEE_OTHER_PROPERTY: () => 'A task cannot be assigned to another hotel’s staff.',
  TASK_NOT_MINE: () => 'You can only change a task assigned to you.',

  // --- Room outages ---------------------------------------------------------
  OUTAGE_END_BEFORE_START: (p: P) =>
    `The end date (${p.end}) cannot precede the start (${p.start}).`,
  OUTAGE_IN_THE_PAST: (p: P) =>
    `A past range (${p.start} to ${p.end}) cannot be taken out of service.`,
  OUTAGE_OVERLAPS: (p: P) =>
    `Room ${p.room} is already out of service from ${p.start} to ${p.end}.`,
  OUTAGE_ROOM_ASSIGNED: (p: P) =>
    `Reservation ${p.reservation} is assigned to room ${p.room} during that range.`,
  OUTAGE_ROOM_OCCUPIED: (p: P) =>
    `Room ${p.room} is occupied and cannot be taken out of service from today.`,
  OUTAGE_NOT_FOUND: (p: P) => `Outage record not found: ${p.id}`,
  OUTAGE_ALREADY_RELEASED: () => 'That outage has already been released.',

  // --- Traces ---------------------------------------------------------------
  TRACE_NOT_FOUND: (p: P) => `Instruction not found: ${p.id}`,
  TRACE_AFTER_DEPARTURE: (p: P) =>
    `An instruction cannot be dated after the departure date (${p.departure}).`,
  TRACE_ALREADY_DONE: () => 'That instruction is already completed.',
  TRACE_DONE_NOT_DELETABLE: () => 'A completed instruction cannot be deleted.',

  // --- Cashier --------------------------------------------------------------
  SHIFT_NOT_FOUND: (p: P) => `Shift not found: ${p.id}`,
  SHIFT_ALREADY_OPEN: () => 'You already have an open shift. Close it first.',
  SHIFT_NOT_MINE: () => 'You can only close your own shift.',
  SHIFT_ALREADY_CLOSED: () => 'That shift is already closed.',

  // --- Door locks -----------------------------------------------------------
  KEY_NOT_IN_HOUSE: (p: P) =>
    `The guest is not in house (${p.status}). Issue a key after check-in.`,
  KEY_NO_ROOM: () => 'No room is assigned. Assign a room first.',
  KEY_PAST_CHECKOUT: () => 'The check-out time has passed. Extend the stay, then issue a key.',
  KEY_NOT_FOUND: (p: P) => `Key not found: ${p.keyId}`,
  KEY_ISSUE_REFUSED: (p: P) => `The lock refused to issue the card: ${p.reason}`,
  KEY_ISSUE_UNREACHABLE: () =>
    'The lock could not be reached. A card may have been made — check the encoder.',
  KEY_VOID_FAILED: () =>
    'The lock did not void the card. It may still open the door — please check.',

  // --- POS ------------------------------------------------------------------
  POS_KEY_MALFORMED: () => 'The POS key is missing or malformed.',
  POS_KEY_INVALID: () => 'The POS key is not valid.',
  POS_OUTLET_NOT_FOUND: (p: P) => `Outlet not found: ${p.id}`,
  POS_OUTLET_CODE_TAKEN: (p: P) => `That outlet code is already registered: ${p.code}`,
  POS_ROOM_NOT_IN_HOUSE: (p: P) => `No guest is in house in room ${p.room}. Check the room number.`,
  POS_RESERVATION_NOT_LINKED: (p: P) =>
    `The reservation for room ${p.room} is not linked to OPERA. Ask the front desk.`,
  POS_RESERVATION_NOT_LINKED_PLAIN: () =>
    'This reservation is not linked to OPERA. Ask the front desk.',
  POS_POSTING_NOT_LINKED: () => 'This posting is not linked to OPERA. Ask the front desk.',
  POS_FOLIO_CLOSED: () => 'That folio is already closed. Ask the front desk.',
  POS_FOLIO_CLOSED_ROOM: (p: P) => `The folio for room ${p.room} is closed. Ask the front desk.`,
  POS_FOLIO_NOT_FOUND: (p: P) => `Folio not found for room ${p.room}. ${p.reason}`,
  POS_CHARGE_NOT_MIRRORED: () => 'The charge posted but its detail could not be read back.',
  POS_CHECK_ALREADY_USED: (p: P) => `That check has already been posted: ${p.reference}`,
  POS_CHECK_NOT_FOUND: (p: P) => `Check not found: ${p.reference}`,
  POS_CHECK_ALREADY_VOIDED: (p: P) => `That check has already been voided: ${p.reference}`,

  // --- Profiles -------------------------------------------------------------
  PROFILE_NOT_FOUND: (p: P) => `Profile not found: ${p.id}`,
  PROFILE_MERGED_READ_ONLY: () =>
    'This profile has been merged into another. Edit the canonical profile instead.',
  PROFILE_PREFERENCE_UNKNOWN: (p: P) => `Unknown preference code: ${p.codes}`,
  PROFILE_MERGE_SELF: () => 'A profile cannot be merged into itself.',
  PROFILE_ALREADY_MERGED: () => 'That profile has already been merged.',
  PROFILE_TARGET_MERGED: () =>
    'The target profile has itself been merged. Name the canonical profile instead.',

  // --- Accounts -------------------------------------------------------------
  USER_NOT_FOUND: (p: P) => `Account not found: ${p.id}`,
  USER_NOT_FOUND_PLAIN: () => 'Account not found.',
  USER_EMAIL_TAKEN: () => 'That email is already in use.',
  USER_SELF_DEACTIVATE: () => 'You cannot deactivate your own account.',
  USER_SELF_ROLE: () => 'You cannot change your own role. Ask another administrator.',
  USER_LAST_ADMIN: () => 'This is the last administrator. Appoint another one first.',
  USER_CURRENT_PASSWORD_WRONG: () => 'The current password is not correct.',
  USER_PASSWORD_UNCHANGED: () => 'The new password is the same as the current one.',
} satisfies Record<string, (params: never) => string>;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

/** Values that vary within a message. Rendered by whichever side owns the wording. */
type P = Record<string, string | number>;
export type ErrorParams = P;

interface ErrorBody {
  statusCode: number;
  code: ErrorCode;
  params?: ErrorParams;
  message: string;
}

function body(status: number, code: ErrorCode, params?: ErrorParams): ErrorBody {
  const render = ERROR_MESSAGES[code] as (p: ErrorParams) => string;
  return {
    statusCode: status,
    code,
    ...(params ? { params } : {}),
    message: render(params ?? {}),
  };
}

/** 404 — the record is not there. */
export function notFound(code: ErrorCode, params?: ErrorParams): HttpException {
  return new NotFoundException(body(404, code, params));
}

/** 400 — the request is wrong in a way the caller can fix. */
export function badRequest(code: ErrorCode, params?: ErrorParams): HttpException {
  return new BadRequestException(body(400, code, params));
}

/** 409 — the request conflicts with the current state. */
export function conflict(code: ErrorCode, params?: ErrorParams): HttpException {
  return new ConflictException(body(409, code, params));
}

/** 403 — authenticated, but not allowed. */
export function forbidden(code: ErrorCode, params?: ErrorParams): HttpException {
  return new ForbiddenException(body(403, code, params));
}

/** 401 — not authenticated, or no longer. */
export function unauthorized(code: ErrorCode, params?: ErrorParams): HttpException {
  return new UnauthorizedException(body(401, code, params));
}

/**
 * The code a refusal carries, if it carries one.
 *
 * Tests assert on this rather than on the sentence: the wording belongs to whichever
 * screen renders it, and a test that pins prose fails when a translator improves it.
 */
export function errorCode(error: unknown): ErrorCode | undefined {
  if (!(error instanceof HttpException)) return undefined;
  const response = error.getResponse();
  if (typeof response === 'object' && response !== null && 'code' in response) {
    return (response as { code: ErrorCode }).code;
  }
  return undefined;
}
