const utcRfc3339Pattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u;

export function parseByteFenceUtcTimestamp(value) {
  const match = typeof value === "string" && utcRfc3339Pattern.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const nanoseconds = Number((match[7] ?? "").padEnd(9, "0"));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  const days = daysFromCivil(year, month, day);
  return {
    seconds: ((days * 24n + BigInt(hour)) * 60n + BigInt(minute)) * 60n + BigInt(second),
    nanoseconds
  };
}

export function compareByteFenceUtcTimestamps(left, right) {
  if (left.seconds < right.seconds) return -1;
  if (left.seconds > right.seconds) return 1;
  return Math.sign(left.nanoseconds - right.nanoseconds);
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

// Proleptic Gregorian conversion adapted from the public-domain civil calendar
// algorithm by Howard Hinnant. BigInt keeps the second coordinate exact.
function daysFromCivil(year, month, day) {
  let adjustedYear = BigInt(year);
  if (month <= 2) adjustedYear -= 1n;
  const era = floorDiv(adjustedYear, 400n);
  const yearOfEra = adjustedYear - era * 400n;
  const adjustedMonth = BigInt(month + (month > 2 ? -3 : 9));
  const dayOfYear = (153n * adjustedMonth + 2n) / 5n + BigInt(day) - 1n;
  const dayOfEra =
    yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
  return era * 146097n + dayOfEra - 719468n;
}

function floorDiv(dividend, divisor) {
  const quotient = dividend / divisor;
  return dividend % divisor < 0n ? quotient - 1n : quotient;
}
