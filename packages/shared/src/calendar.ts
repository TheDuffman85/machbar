// Keep both successful and unsuccessful checks bounded: clients choose timezones.
const validity = new Map<string, boolean>();
const formatters = new Map<string, Intl.DateTimeFormat>();
const capacity = 1024;
const supported = new Set(Intl.supportedValuesOf('timeZone').map((value) => value.toLowerCase()));

export function validTimezone(value: string): boolean {
  if (value.length > 100) return false;
  const key = value.toLowerCase();
  if (supported.has(key)) return true;
  const cached = validity.get(key);
  if (cached !== undefined) return cached;
  let valid = true;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
  } catch {
    valid = false;
  }
  if (validity.size >= capacity) validity.delete(validity.keys().next().value!);
  validity.set(key, valid);
  return valid;
}

export function calendarFormatter(timezone: string, time = false): Intl.DateTimeFormat {
  const key = `${time}:${timezone}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(time ? 'en-GB' : 'en-US', {
      timeZone: timezone,
      ...(time
        ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const }
        : ({ year: 'numeric', month: '2-digit', day: '2-digit' } as const)),
    });
    if (formatters.size >= capacity) formatters.delete(formatters.keys().next().value!);
    formatters.set(key, formatter);
  }
  return formatter;
}
