// sync-homebase.js
// Pulls labor + schedule data from both Homebase locations
// and writes it into your Supabase tables.
// Run manually: node sync-homebase.js
// Or schedule via Supabase Edge Function cron (we'll set that up next)

import { createClient } from '@supabase/supabase-js';

// ── ENV VARIABLES (set these in Vercel + locally in .env) ──────────────────
const HOMEBASE_API_KEY   = process.env.HOMEBASE_API_KEY;   // m1QsKRBpBruPHEyL1mosNlThnKK9nAeAnvGHs9YZP00
const SUPABASE_URL       = process.env.SUPABASE_URL;       // https://xxxx.supabase.co
const SUPABASE_ANON_KEY  = process.env.SUPABASE_ANON_KEY;  // eyJ...

const LOCATIONS = [
  { id: '7a9a7f96-1ec0-4667-9c11-7418a2a85816', name: 'Nikos UAlbany' },
  { id: '32254de8-d353-49e9-a341-924a5d439fc9', name: 'Up North' },
];

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── HELPERS ─────────────────────────────────────────────────────────────────
function getWeekStart(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

function dateRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 365); // pull last 12 months
  return {
    start: start.toISOString().split('T')[0],
    end:   end.toISOString().split('T')[0],
  };
}

async function homebaseFetch(path) {
  const res = await fetch(`https://api.joinhomebase.com${path}`, {
    headers: {
      'Authorization': `Bearer ${HOMEBASE_API_KEY}`,
      'Content-Type':  'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Homebase API error ${res.status}: ${text}`);
  }
  return res.json();
}

// ── PULL TIMESHEETS (actual hours worked + cost) ────────────────────────────
async function syncTimesheets(location) {
  console.log(`\n[${location.name}] Fetching timesheets...`);
  const { start, end } = dateRange();

  const data = await homebaseFetch(
    `/v1/businesses/locations/${location.id}/timesheets?start_date=${start}&end_date=${end}&status=approved`
  );

  const timesheets = data.timesheets || data.data || data || [];
  console.log(`  → ${timesheets.length} timesheet records found`);

  // Group by week
  const byWeek = {};
  for (const ts of timesheets) {
    const weekStart = getWeekStart(ts.date || ts.clock_in);
    const key = `${weekStart}__${ts.employee?.name || ts.employee_name || 'Unknown'}__${ts.role || ts.job_title || 'Staff'}`;

    if (!byWeek[key]) {
      byWeek[key] = {
        week_start:      weekStart,
        location_id:     location.id,
        location_name:   location.name,
        employee_name:   ts.employee?.name || ts.employee_name || 'Unknown',
        role:            ts.role || ts.job_title || 'Staff',
        scheduled_hours: 0,
        actual_hours:    0,
        labor_cost:      0,
      };
    }

    byWeek[key].actual_hours += parseFloat(ts.hours_worked || ts.duration_hours || 0);
    byWeek[key].labor_cost   += parseFloat(ts.wages_earned || ts.total_pay || 0);
  }

  const rows = Object.values(byWeek);

  if (rows.length === 0) {
    console.log(`  → No data to insert for ${location.name}`);
    return;
  }

  // Upsert into Supabase (update if same week+employee exists)
  const { error } = await supabase
    .from('labor_weekly')
    .upsert(rows, { onConflict: 'week_start,employee_name,location_id' });

  if (error) {
    console.error(`  ✗ Supabase insert error:`, error.message);
  } else {
    console.log(`  ✓ Inserted/updated ${rows.length} labor rows`);
  }
}

// ── PULL SCHEDULES (scheduled vs actual comparison) ─────────────────────────
async function syncSchedules(location) {
  console.log(`\n[${location.name}] Fetching schedules...`);
  const { start, end } = dateRange();

  const data = await homebaseFetch(
    `/v1/businesses/locations/${location.id}/schedules?start_date=${start}&end_date=${end}`
  );

  const shifts = data.shifts || data.data || data || [];
  console.log(`  → ${shifts.length} scheduled shifts found`);

  // Group scheduled hours by week + employee
  const byWeek = {};
  for (const shift of shifts) {
    const weekStart = getWeekStart(shift.date || shift.start_time);
    const key = `${weekStart}__${shift.employee?.name || shift.employee_name || 'Unknown'}`;

    if (!byWeek[key]) byWeek[key] = { weekStart, employee: shift.employee?.name || shift.employee_name || 'Unknown', hours: 0 };
    byWeek[key].hours += parseFloat(shift.duration_hours || shift.hours || 0);
  }

  // Update scheduled_hours in labor_weekly rows
  for (const entry of Object.values(byWeek)) {
    const { error } = await supabase
      .from('labor_weekly')
      .update({ scheduled_hours: entry.hours })
      .eq('week_start', entry.weekStart)
      .eq('employee_name', entry.employee)
      .eq('location_id', location.id);

    if (error) console.error(`  ✗ Schedule update error:`, error.message);
  }

  console.log(`  ✓ Scheduled hours updated`);
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Nikos Ops — Homebase Sync ===');
  console.log(`Pulling data for ${LOCATIONS.length} locations...\n`);

  if (!HOMEBASE_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('✗ Missing environment variables. Check your .env file.');
    process.exit(1);
  }

  for (const location of LOCATIONS) {
    try {
      await syncTimesheets(location);
      await syncSchedules(location);
    } catch (err) {
      console.error(`\n✗ Error for ${location.name}:`, err.message);
      console.error('  → Check that your API key has access to this location');
    }
  }

  console.log('\n=== Sync complete ===');
}

main();
