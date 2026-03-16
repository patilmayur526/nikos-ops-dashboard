import { createClient } from '@supabase/supabase-js';

const HOMEBASE_API_KEY  = process.env.HOMEBASE_API_KEY;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const BASE_URL          = 'https://api.joinhomebase.com';

// Up North excluded — requires All-in-one tier upgrade to access API
const LOCATIONS = [
  { id: '7a9a7f96-1ec0-4667-9c11-7418a2a85816', name: 'Nikos UAlbany' },
];

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── HELPERS ───────────────────────────────────────────────────────────────────
function getWeekStart(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay();
  d.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
  return d.toISOString().split('T')[0];
}

// Returns array of {start, end} month chunks covering last 12 months
// Homebase max range = 1 month per request
function getMonthChunks() {
  const chunks = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end   = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
    chunks.push({
      start: start.toISOString().split('T')[0],
      end:   end > now ? now.toISOString().split('T')[0] : end.toISOString().split('T')[0],
    });
  }
  return chunks;
}

async function homebaseFetch(path) {
  const url = `${BASE_URL}${path}`;
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

async function fetchAllPages(basePath) {
  let page = 1;
  let all  = [];
  while (true) {
    const sep   = basePath.includes('?') ? '&' : '?';
    const data  = await homebaseFetch(`${basePath}${sep}per_page=100&page=${page}`);
    const items = Array.isArray(data)
      ? data
      : (data.timecards || data.shifts || data.employees || data.data || []);
    if (items.length === 0) break;
    all = all.concat(items);
    console.log(`    page ${page}: ${items.length} records`);
    if (items.length < 100) break;
    page++;
  }
  return all;
}

// ── SYNC TIMECARDS ────────────────────────────────────────────────────────────
async function syncTimecards(location) {
  console.log(`\n[${location.name}] Fetching timecards (12 months, month by month)...`);
  const chunks = getMonthChunks();
  let allTimecards = [];

  for (const chunk of chunks) {
    process.stdout.write(`  ${chunk.start} → ${chunk.end} ... `);
    try {
      const items = await fetchAllPages(
        `/locations/${location.id}/timecards?start_date=${chunk.start}&end_date=${chunk.end}`
      );
      console.log(`${items.length} records`);
      allTimecards = allTimecards.concat(items);
    } catch (err) {
      console.log(`skipped (${err.message})`);
    }
  }

  console.log(`\n  Total timecards: ${allTimecards.length}`);
  if (allTimecards.length === 0) {
    console.log('  → No timecard data found. Check that timecards exist in Homebase.');
    return;
  }

  // Log first record so we can see field names
  console.log('  → Sample record:', JSON.stringify(allTimecards[0], null, 2));

  // Group by week + employee + role
  const byWeek = {};
  for (const tc of allTimecards) {
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
        role,
        scheduled_hours: 0,
        actual_hours:    0,
        labor_cost:      0,
      };
    }

    const hours = parseFloat(
      tc.hours_worked ??
      tc.duration_in_hours ??
      (tc.duration_in_minutes != null ? tc.duration_in_minutes / 60 : null) ??
      0
    );
    const wages = parseFloat(
      tc.wages_in_cents != null ? tc.wages_in_cents / 100 :
      (tc.wages ?? tc.total_pay ?? tc.amount ?? 0)
    );

    byWeek[key].actual_hours += hours;
    byWeek[key].labor_cost   += wages;
  }

  const rows = Object.values(byWeek);
  console.log(`\n  Upserting ${rows.length} weekly rows into Supabase...`);

  // Upsert in batches of 50
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const { error } = await supabase
      .from('labor_weekly')
      .upsert(batch, { ignoreDuplicates: false });
    if (error) console.error(`  ✗ Batch ${i}-${i+50} error:`, error.message);
    else console.log(`  ✓ Batch ${i + 1}–${Math.min(i + 50, rows.length)} saved`);
  }
}

// ── SYNC SHIFTS ───────────────────────────────────────────────────────────────
async function syncShifts(location) {
  console.log(`\n[${location.name}] Fetching shifts (scheduled hours)...`);
  const chunks = getMonthChunks();
  let allShifts = [];

  for (const chunk of chunks) {
    process.stdout.write(`  ${chunk.start} → ${chunk.end} ... `);
    try {
      const items = await fetchAllPages(
        `/locations/${location.id}/shifts?start_date=${chunk.start}&end_date=${chunk.end}`
      );
      console.log(`${items.length} records`);
      allShifts = allShifts.concat(items);
    } catch (err) {
      console.log(`skipped (${err.message})`);
    }
  }

  console.log(`\n  Total shifts: ${allShifts.length}`);
  if (allShifts.length === 0) return;

  const byWeek = {};
  for (const shift of allShifts) {
    const date = shift.date || shift.start_time?.split('T')[0];
    if (!date) continue;
    const weekStart    = getWeekStart(date);
    const employeeName = shift.employee?.name || shift.employee_name || 'Unknown';
    const key          = `${weekStart}__${employeeName}__${location.id}`;
    if (!byWeek[key]) byWeek[key] = { weekStart, employeeName, locationId: location.id, hours: 0 };
    const hours = parseFloat(
      shift.duration_in_hours ??
      (shift.duration_in_minutes != null ? shift.duration_in_minutes / 60 : null) ??
      shift.hours ?? 0
    );
    byWeek[key].hours += hours;
  }

  let updated = 0;
  for (const entry of Object.values(byWeek)) {
    const { error } = await supabase
      .from('labor_weekly')
      .update({ scheduled_hours: entry.hours })
      .eq('week_start', entry.weekStart)
      .eq('employee_name', entry.employeeName)
      .eq('location_id', entry.locationId);
    if (!error) updated++;
  }
  console.log(`  ✓ Scheduled hours updated for ${updated} rows`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Nikos Ops — Homebase Sync ===\n');

  if (!HOMEBASE_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('✗ Missing env variables. Check .env file.');
    process.exit(1);
  }

  for (const location of LOCATIONS) {
    try {
      await syncTimecards(location);
      await syncShifts(location);
    } catch (err) {
      console.error(`\n✗ Fatal error for ${location.name}:`, err.message);
    }
  }

  console.log('\n=== Sync complete — check Supabase Table Editor → labor_weekly ===');
}

main();
