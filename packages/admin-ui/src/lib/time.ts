/**
 * [design-note V] The ONLY place that imports dayjs directly (guarded by
 * tests/timezone.test.ts). All admin times render in the server's app
 * timezone (LUCKAGENT_TIMEZONE, fetched from /admin/api/meta at boot) —
 * not the browser's — so a viewer in the US sees the same clock as one in
 * China and as the bots/logs.
 */
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import relativeTime from 'dayjs/plugin/relativeTime';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.locale('zh-cn');
dayjs.extend(relativeTime);
dayjs.extend(utc);
dayjs.extend(timezone);

export const DEFAULT_TZ = 'Asia/Shanghai';

let appTz = DEFAULT_TZ;
let appOffset = '+08:00';

export function setAppTimezone(tz: string, utcOffset?: string): void {
  try {
    dayjs().tz(tz); // throws RangeError on an unknown zone
    appTz = tz;
    appOffset = utcOffset ?? dayjs().tz(tz).format('Z');
  } catch {
    /* keep previous */
  }
}

export const appTimezone = () => appTz;

/** "Asia/Shanghai (UTC+08:00)" */
export const timezoneLabel = () => `${appTz} (UTC${appOffset})`;

/** A dayjs instance in the app timezone. `inTz()` = now. */
export const inTz = (v?: dayjs.ConfigType) => (v === undefined ? dayjs() : dayjs(v)).tz(appTz);

/** Format in the app timezone; '—' for empty values. */
export const fmt = (v: dayjs.ConfigType | null | undefined, pattern = 'YYYY-MM-DD HH:mm'): string =>
  v === null || v === undefined || v === '' ? '—' : inTz(v).format(pattern);

/** Relative time ("3 分钟前") — timezone-independent. */
export const fromNow = (v: dayjs.ConfigType) => dayjs(v).fromNow();

/** Calendar-day difference (in app tz) between `v` and today: 0 = today, -1 = yesterday. */
export const dayDiffFromToday = (v: dayjs.ConfigType) => inTz(v).startOf('day').diff(inTz().startOf('day'), 'day');

/**
 * Format a server-computed calendar day key ("2026-11-22"). It is already a
 * date in the app tz, so parse it as-is — converting would shift it a day.
 */
// dayjs parses a date-only string as that calendar day (no tz shift).
export const fmtDayKey = (day: string, pattern = 'M/D') => dayjs(day).format(pattern);
