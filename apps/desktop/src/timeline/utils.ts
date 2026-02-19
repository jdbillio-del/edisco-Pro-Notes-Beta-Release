const MS_PER_DAY = 86_400_000;

type DateRange = { start: Date; end: Date };

type TimelineLike = {
  startDate?: string | null;
  endDate?: string | null;
};

export const parseIsoDate = (value?: string | null) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
};

const toDayNumber = (date: Date) =>
  Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY);

export const diffInDays = (start: Date, end: Date) => toDayNumber(end) - toDayNumber(start);

export const addDays = (date: Date, days: number) => {
  const dayNumber = toDayNumber(date) + days;
  return new Date(dayNumber * MS_PER_DAY);
};

export const buildDateRange = (start: Date, end: Date) => {
  const count = diffInDays(start, end);
  return Array.from({ length: count + 1 }, (_, index) => addDays(start, index));
};

export const isValidRange = (startValue?: string | null, endValue?: string | null) => {
  const start = parseIsoDate(startValue);
  const end = parseIsoDate(endValue);
  if (!start || !end) return false;
  return diffInDays(start, end) >= 0;
};

export const getRangeFromRows = (rows: TimelineLike[], paddingDays: number) => {
  let min: Date | null = null;
  let max: Date | null = null;

  rows.forEach((row) => {
    const start = parseIsoDate(row.startDate);
    const end = parseIsoDate(row.endDate);
    if (!start || !end) return;
    if (diffInDays(start, end) < 0) return;
    if (!min || start < min) min = start;
    if (!max || end > max) max = end;
  });

  if (!min || !max) return null;

  return {
    start: addDays(min, -paddingDays),
    end: addDays(max, paddingDays)
  } satisfies DateRange;
};

export const formatDayLabel = (date: Date, showMonth: boolean) => {
  return date.toLocaleDateString(undefined, {
    month: showMonth ? "short" : undefined,
    day: "numeric"
  });
};

export const formatRangeLabel = (startValue?: string | null, endValue?: string | null) => {
  const start = parseIsoDate(startValue);
  const end = parseIsoDate(endValue);
  if (!start || !end) return "";
  return `${start.toLocaleDateString()} – ${end.toLocaleDateString()}`;
};

export const projectColorForId = (projectId: string, palette: string[]) => {
  if (!projectId) return palette[0];
  let hash = 0;
  for (let i = 0; i < projectId.length; i += 1) {
    hash = (hash * 31 + projectId.charCodeAt(i)) % 1_000_000;
  }
  return palette[hash % palette.length];
};
