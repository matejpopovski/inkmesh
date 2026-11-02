/**
 * Fractional order keys: strings that sort lexically, with room for a new key between any two.
 *
 * A key is an integer part followed by an optional fraction. The first character of the integer
 * part encodes its length (`a` is one digit, `b` two, up to `z`, and the mirror image `Z` to `A`
 * for negatives). That prefix keeps appending cheap: pushing shapes to the top of a board only
 * increments an integer, so key length grows with log(n) instead of n.
 *
 * The characters are ASCII digits, uppercase and lowercase, which already sort correctly by code
 * unit, so plain `<` on strings gives the board order with no custom comparator.
 */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
const ZERO = DIGITS.charAt(0);
const TOP_DIGIT = DIGITS.charAt(BASE - 1);
const FIRST_KEY = 'a0';
const SMALLEST_INTEGER = 'A' + ZERO.repeat(26);

/** Long enough that two replicas filling the same gap offline will not pick the same key. */
const JITTER_DIGITS = 4;

export type Random = () => number;

function digitValue(char: string): number {
  const value = DIGITS.indexOf(char);
  if (value < 0) throw new RangeError(`invalid order key digit ${JSON.stringify(char)}`);
  return value;
}

function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new RangeError(`invalid order key head ${JSON.stringify(head)}`);
}

function integerPart(key: string): string {
  const length = integerLength(key.charAt(0));
  if (length > key.length) throw new RangeError(`truncated order key ${JSON.stringify(key)}`);
  return key.slice(0, length);
}

export function isValidOrderKey(key: string): boolean {
  if (key.length === 0 || key === SMALLEST_INTEGER) return false;
  try {
    const integer = integerPart(key);
    for (const char of key.slice(1)) digitValue(char);
    return !key.slice(integer.length).endsWith(ZERO);
  } catch {
    return false;
  }
}

function assertValid(key: string): void {
  if (!isValidOrderKey(key)) throw new RangeError(`invalid order key ${JSON.stringify(key)}`);
}

/** The next integer in sequence, or null when the 27-digit range is exhausted. */
function incrementInteger(integer: string): string | null {
  const head = integer.charAt(0);
  const digits = integer.slice(1).split('');
  for (let i = digits.length - 1; i >= 0; i--) {
    const value = digitValue(digits[i] as string) + 1;
    if (value < BASE) {
      digits[i] = DIGITS.charAt(value);
      return head + digits.join('');
    }
    digits[i] = ZERO;
  }
  if (head === 'Z') return 'a' + ZERO;
  if (head === 'z') return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > 'a') digits.push(ZERO);
  else digits.pop();
  return nextHead + digits.join('');
}

/** The previous integer in sequence, or null when the 27-digit range is exhausted. */
function decrementInteger(integer: string): string | null {
  const head = integer.charAt(0);
  const digits = integer.slice(1).split('');
  for (let i = digits.length - 1; i >= 0; i--) {
    const value = digitValue(digits[i] as string) - 1;
    if (value >= 0) {
      digits[i] = DIGITS.charAt(value);
      return head + digits.join('');
    }
    digits[i] = TOP_DIGIT;
  }
  if (head === 'a') return 'Z' + TOP_DIGIT;
  if (head === 'A') return null;
  const previousHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (previousHead < 'Z') digits.push(TOP_DIGIT);
  else digits.pop();
  return previousHead + digits.join('');
}

/**
 * A fraction strictly between `low` and `high`, read as base-62 digits after a radix point.
 * `high === null` stands for 1. Neither input may end in the zero digit, which would make two
 * different strings mean the same number and leave no key between them.
 */
function fractionBetween(low: string, high: string | null): string {
  if (high !== null) {
    let shared = 0;
    while ((low[shared] ?? ZERO) === high[shared]) shared++;
    if (shared > 0) {
      return high.slice(0, shared) + fractionBetween(low.slice(shared), high.slice(shared));
    }
  }

  const lowDigit = low.length > 0 ? digitValue(low.charAt(0)) : 0;
  const highDigit = high !== null ? digitValue(high.charAt(0)) : BASE;
  if (highDigit - lowDigit > 1) return DIGITS.charAt(Math.round((lowDigit + highDigit) / 2));

  // Adjacent digits leave no room at this position. A longer `high` means its first digit alone
  // is already inside the interval; otherwise the gap can only be found by going one digit deeper.
  if (high !== null && high.length > 1) return high.slice(0, 1);
  return DIGITS.charAt(lowDigit) + fractionBetween(low.slice(1), null);
}

/** Deterministic key strictly between `low` and `high`, where null means an open end. */
export function keyBetween(low: string | null, high: string | null): string {
  if (low !== null) assertValid(low);
  if (high !== null) assertValid(high);
  if (low !== null && high !== null && low >= high) {
    throw new RangeError(`order keys out of order: ${low} >= ${high}`);
  }

  if (low === null) {
    if (high === null) return FIRST_KEY;
    const integer = integerPart(high);
    if (integer === SMALLEST_INTEGER) {
      return integer + fractionBetween('', high.slice(integer.length));
    }
    if (integer < high) return integer;
    const previous = decrementInteger(integer);
    if (previous === null) throw new RangeError('order key range exhausted');
    return previous;
  }

  const lowInteger = integerPart(low);
  const lowFraction = low.slice(lowInteger.length);
  if (high === null) {
    return incrementInteger(lowInteger) ?? lowInteger + fractionBetween(lowFraction, null);
  }

  const highInteger = integerPart(high);
  if (lowInteger === highInteger) {
    return lowInteger + fractionBetween(lowFraction, high.slice(highInteger.length));
  }
  const next = incrementInteger(lowInteger) as string;
  return next < high ? next : lowInteger + fractionBetween(lowFraction, null);
}

function randomSuffix(random: Random): string {
  let suffix = '';
  for (let i = 0; i < JITTER_DIGITS - 1; i++) {
    suffix += DIGITS.charAt(Math.floor(random() * BASE) % BASE);
  }
  // The last digit is never zero, so the suffix cannot create a trailing-zero key.
  return suffix + DIGITS.charAt(1 + (Math.floor(random() * (BASE - 1)) % (BASE - 1)));
}

/**
 * Like `keyBetween`, with random trailing digits.
 *
 * Without jitter, two replicas that each add a shape to the top while offline compute the same
 * key. The tie-break on record id still gives a total order, but no key exists between two equal
 * keys, so a later "move between them" has nowhere to land. Random digits make that collision
 * negligible at a cost of four characters per key.
 */
export function jitteredKeyBetween(
  low: string | null,
  high: string | null,
  random: Random = Math.random,
): string {
  let base = keyBetween(low, high);
  for (;;) {
    const candidate = base + randomSuffix(random);
    if (high === null || candidate < high) return candidate;
    // `high` extends `base`, so the suffix overshot. Each step moves `base` closer to `high`
    // from below and past their shared prefix, which leaves room for a suffix.
    base = keyBetween(base, high);
  }
}
