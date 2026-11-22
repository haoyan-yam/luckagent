import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FALLBACK_TIMEZONE, isValidTimezone, resolveAppTimezone, utcOffsetLabel } from '../src/utils/timezone.js';
import { localDay } from '../src/utils/local-day.js';

describe('resolveAppTimezone', () => {
  it('prefers LUCKAGENT_TIMEZONE over legacy SCHEDULE_TIMEZONE', () => {
    expect(resolveAppTimezone({ LUCKAGENT_TIMEZONE: 'Asia/Tokyo', SCHEDULE_TIMEZONE: 'UTC' })).toEqual({
      timezone: 'Asia/Tokyo',
      source: 'LUCKAGENT_TIMEZONE',
    });
    expect(resolveAppTimezone({ SCHEDULE_TIMEZONE: 'UTC' })).toEqual({ timezone: 'UTC', source: 'SCHEDULE_TIMEZONE' });
  });

  it('defaults to Asia/Shanghai', () => {
    expect(resolveAppTimezone({})).toEqual({ timezone: FALLBACK_TIMEZONE, source: 'default' });
    expect(FALLBACK_TIMEZONE).toBe('Asia/Shanghai');
  });

  it('falls back on an invalid name and reports it', () => {
    const r = resolveAppTimezone({ LUCKAGENT_TIMEZONE: 'GMT+8x' });
    expect(r.timezone).toBe('Asia/Shanghai');
    expect(r.invalid).toBe('LUCKAGENT_TIMEZONE=GMT+8x');
    expect(isValidTimezone('Not/AZone')).toBe(false);
  });
});

describe('utcOffsetLabel', () => {
  it('formats offsets, including US DST', () => {
    expect(utcOffsetLabel('Asia/Shanghai')).toBe('+08:00');
    expect(utcOffsetLabel('UTC')).toBe('+00:00');
    expect(utcOffsetLabel('America/New_York', new Date('2026-01-15T12:00:00Z'))).toBe('-05:00');
    expect(utcOffsetLabel('America/New_York', new Date('2026-07-15T12:00:00Z'))).toBe('-04:00');
  });
});

describe('day boundaries follow the app timezone (TZ pinned to Asia/Shanghai)', () => {
  it('localDay rolls over at Beijing midnight, not host midnight', () => {
    // 2026-11-21 23:30 in New York = 2026-11-22 12:30 in Beijing
    expect(localDay(Date.parse('2026-11-22T04:30:00Z'))).toBe('2026-11-22');
    // 16:00Z = Beijing midnight
    expect(localDay(Date.parse('2026-11-21T15:59:59Z'))).toBe('2026-11-21');
    expect(localDay(Date.parse('2026-11-21T16:00:00Z'))).toBe('2026-11-22');
  });
});

describe('admin-ui renders times via lib/time only', () => {
  it('no page imports dayjs directly', () => {
    const root = path.resolve(__dirname, '../packages/admin-ui/src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(tsx?|jsx?)$/.test(e.name) && !p.endsWith(path.join('lib', 'time.ts'))) {
          if (/from ['"]dayjs(\/[^'"]*)?['"]|new Date\([^)]*\)\.toLocale(Date|Time)?String/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
