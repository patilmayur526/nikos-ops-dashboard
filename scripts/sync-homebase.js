import { createClient } from '@supabase/supabase-js';

const HOMEBASE_API_KEY  = process.env.HOMEBASE_API_KEY;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const BASE_URL          = 'https://api.joinhomebase.com';

const LOCATIONS = [
  { id: '7a9a7f96-1ec0-4667-9c11-7418a2a85816', name: 'Nikos UAlbany' },
  { id: '32254de8-d353-49e9-a341-924a5d439fc9', name: 'Up North' },
];

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── HELPERS ──────────────────────────────────────────────────────────────────
function getWeekStart(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

function dateRange() {
  const end = new Date();
  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);
  return {
    start: start.toISOString().split('T')[0],
    end:   end.toISOString().split('T')[0],
  };
}

// Correct headers per Homebase docs
async function homebaseFetch(path) {
  const url = `${BASE_URL}${path}`;
  console.log(`  GET ${url}`);
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${HOMEBASE_API_KEY}`,
      'Accept':        'application/vnd.homebase-v1+json',
      'Content-Type':  'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

// Fetch all pages of a paginated endpoint
async function fetchAllPages(basePath) {
  let page = 1;
  let allResults = [];
  while (true) {
    const sep = basePath.includes('?') ? '&' : '?';
    const data = await homebaseFetch(`${basePath}${sep}per_page=100&page=${page}`);
    const items = Array.isArray(data) ? data : (data.data || data.timecards || data.shifts || data.employees || []);
    if (items.length === 0) break;
    allResults = allResults.concat(items);
    if (items.length < 100) break;
    page++;
  }
  return allResults;
}

// ── SYNC TIMECARDS (actual hours worked) ─────────────────────────────────────
async function syncTimecards(location) {
  console.log(`\n[${location.name}] Fetching timecards...`);
  const { start, end } = dateRange();

  const timecards = await fetchAllPages(
    `/locations/${location.id}/timecards?start_date=${start}&end_date=${end}`
  );
  console.log(`  → ${timecards.length} timecards found`);

  if (timecards.length === 0) return;

  // Group by week + employee + role
  const byWeek = {};
  for (const tc of timecards) {
    const date = tc.date || tc.clock_in_time?.split('T')[0] || tc.created_at?.split('T')[0];
    if (!date) continue;

    const weekStart    = getWeekStart(date);
    const employeeName = tc.employee?.name || tc.employee_name || 'Unknown';
    const role         = tc.job?.name || tc.role || tc.position || 'Staff';
    const key          = `${weekStart}__${employeeName}__${role}`;

    if (!byWeek[key]) {
      byWeek[key] = {
        week_start:      weekStart,
        location_id:     location.id,
        location_name:   location.name,
        employee_name:   employeeName,
        role:            role,
        scheduled_hours: 0,
        actual_hours:    0,
        labor_cost:      0,
      };
    }

    // Homebase timecards store duration in minutes or hours depending on version
    const hours = parseFloat(tc.hours_worked ?? tc.duration_in_hours ?? (tc.duration_in_minutes / 60) ?? 0);
    const wages = parseFloat(tc.wages_in_cents ? tc.wages_in_cents / 100 : (tc.wages ?? tc.total_pay ?? 0));

    byWeek[key].actual_hours += hours;
    byWeek[key].labor_cost   += wages;
  }

  const rows = Object.values(byWeek);
  console.log(`  → ${rows.length} weekly rows to upsert`);

  const { error } = await supabase
    .from('labor_weekly')
    .upsert(rows, { onConflict: 'week_start,employee_name,location_id' });

  if (error) console.error(`  ✗ Supabase error:`, error.message);
  else console.log(`  ✓ labor_weekly updated`);
}

// ── SYNC SHIFTS (scheduled hours) ────────────────────────────────────────────
async function syncShifts(location) {
  console.log(`\n[${location.name}] Fetching shifts...`);
  const { start, end } = dateRange();

  const shifts = await fetchAllPages(
    `/locations/${location.id}/shifts?start_date=${start}&end_date=${end}`
  );
  console.log(`  → ${shifts.length} shifts found`);

  if (shifts.length === 0) return;

  const byWeek = {};
  for (const shift of shifts) {
    const date = shift.date || shift.start_time?.split('T')[0];
    if (!date) continue;

    const weekStart    = getWeekStart(date);
    const employeeName = shift.employee?.name || shift.employee_name || 'Unknown';
    const key          = `${weekStart}__${employeeName}__${location.id}`;

    if (!byWeek[key]) byWeek[key] = { weekStart, employeeName, locationId: location.id, hours: 0 };

    const hours = parseFloat(shift.duration_in_hours ?? (shift.duration_in_minutes / 60) ?? shift.hours ?? 0);
    byWeek[key].hours += hours;
  }

  // Update scheduled_hours on existing labor_weekly rows
  let updated = 0;
  for (const entry of Object.values(byWeek)) {
    const { error } = await supabase
      .from('labor_weekly')
      .update({ scheduled_hours: entry.hours })
      .eq('week_start', entry.weekStart)
      .eq('employee_name', entry.employeeName)
      .eq('location_id', entry.locationId);
    if (error) console.error(`  ✗ Shift update error:`, error.message);
    else updated++;
  }
  console.log(`  ✓ Scheduled hours updated for ${updated} rows`);
}

// ── SYNC LABOR BY EMPLOYEE (cost summary) ─────────────────────────────────────
async function syncLaborByEmployee(location) {
  console.log(`\n[${location.name}] Fetching labor summary by employee...`);
  const { start, end } = dateRange();

  try {
    const data = await homebaseFetch(
      `/locations/${location.id}/labor/by_employee?start_date=${start}&end_date=${end}`
    );
    console.log(`  → Labor summary fetched`);
    // Log first item so we can see the shape of the data
    if (Array.isArray(data) && data.length > 0) {
      console.log(`  → Sample record:`, JSON.stringify(data[0], null, 2));
    } else {
      console.log(`  → Response:`, JSON.stringify(data, null, 2).slice(0, 500));
    }
  } catch (err) {
    console.log(`  → labor/by_employee not available:`, err.message);
  }
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Nikos Ops — Homebase Sync ===\n');

  if (!HOMEBASE_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('✗ Missing env variables. Check your .env file.');
    process.exit(1);
  }

  for (const location of LOCATIONS) {
    try {
      await syncTimecards(location);
      await syncShifts(location);
      await syncLaborByEmployee(location);
    } catch (err) {
      console.error(`\n✗ Error for ${location.name}:`, err.message);
    }
  }

  console.log('\n=== Sync complete ===');
}

main();
