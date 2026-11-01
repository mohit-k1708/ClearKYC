import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * The Overview's date filter, kept in the URL (?range=7d|30d|90d|month|all, or ?from=&to=) so it can be shared and survives a refresh.
 * Dates are UTC calendar days, like the backend. Also works out the previous period of the same length, for comparisons.
 */
const DAY = 86_400_000;
const iso = (d) => d.toISOString().slice(0, 10);
const shift = (isoDate, days) => iso(new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + days * DAY));
const span = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY) + 1;

export const RANGE_PRESETS = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'month', label: 'This month' },
  { key: 'all', label: 'All time' },
];

export default function useOverviewRange() {
  const [params, setParams] = useSearchParams();
  const rangeParam = params.get('range') || '';
  const fromParam = params.get('from') || '';
  const toParam = params.get('to') || '';

  const value = useMemo(() => {
    const today = iso(new Date());
    if (fromParam && toParam) {
      const from = fromParam <= toParam ? fromParam : toParam;
      const to = toParam > today ? today : toParam;
      return { key: 'custom', label: 'Custom range', from, to, days: span(from, to), api: { from, to } };
    }
    const key = RANGE_PRESETS.some((p) => p.key === rangeParam) ? rangeParam : '30d';
    if (key === 'all') return { key, label: 'All time', from: null, to: today, days: null, api: { range: 'all' } };
    const days = key === 'month' ? Number(today.slice(8)) : Number(key.replace('d', ''));
    const from = shift(today, -(days - 1));
    return { key, label: RANGE_PRESETS.find((p) => p.key === key).label, from, to: today, days, api: { from, to: today } };
  }, [rangeParam, fromParam, toParam]);

  // The period just before this one, same length (not available for "All time").
  const previous = useMemo(() => {
    if (!value.from) return null;
    const to = shift(value.from, -1);
    return { from: shift(to, -(value.days - 1)), to };
  }, [value]);

  function setRange(next) {
    const p = new URLSearchParams(params);
    ['range', 'from', 'to'].forEach((k) => p.delete(k));
    Object.entries(next).forEach(([k, v]) => v && p.set(k, v));
    setParams(p, { replace: true });
  }

  return { range: value, previous, setRange };
}
