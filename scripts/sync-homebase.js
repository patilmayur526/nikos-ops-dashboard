import { createClient } from '@supabase/supabase-js';

const HOMEBASE_API_KEY  = process.env.HOMEBASE_API_KEY;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const BASE_URL          = 'https://api.joinhomebase.com';

const LOCATIONS = [
  { id: '7a9a7f96-1ec0-4667-9c11-7418a2a85816', name: 'Nikos UAlbany' },
];

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function getWeekStart(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay();
  d.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
  return d.toISOString().split('T')[0];
}

function getMonthChunks() {
  const chunks = [];
  const now = new Date();
  for (let i = 35; i >= 0; i--) {
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
  const res = await fetch(`${BASE_URL}${path}`, {
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
    process.stdout.write(` ${items.length}`);
    if (items.length < 100) break;
    page++;
  }
  return all;
}

async function syncTimecards(location) {
  console.log(`\n[${location.name}] Fetching timecards...`);
  const chunks = getMonthChunks();
  let allTimecards = [];

  for (const chunk of chunks) {
    process.stdout.write(`  ${chunk.start}:`);
    try {
      const items = await fetchAllPages(
        `/locations/${location.id}/timecards?start_date=${chunk.start}&end_date=${chunk.end}`
      );
      console.log(` records`);
      allTimecards = allTimecards.concat(items);
    } catch (err) {
      console.log(` skipped (${err.message})`);
    }
  }

  console.log(`\n  Total: ${allTimecards.length} timecards`);
  if (allTimecards.length === 0) return;

  // Group by week + employee + role
  const byWeek = {};
  for (const tc of allTimecards) {
    // Name is top-level first_name + last_name
    const employeeName = `${tc.first_name || ''} ${tc.last_name || ''}`.trim() || 'Unknown';
    const role         = tc.role || 'Staff';
    const department   = tc.department || '';

    // Date comes from clock_in
    const date = tc.clock_in?.split('T')[0] || tc.created_at?.split('T')[0];
    if (!date) continue;

    const weekStart = getWeekStart(date);
    const key       = `${weekStart}__${employeeName}__${role}`;

    if (!byWeek[key]) {
      byWeek[key] = {
        week_start:      weekStart,
        location_id:     location.id,
        location_name:   location.name,
        employee_name:   employeeName,
        role,
        department,
        scheduled_hours: 0,
        actual_hours:    0,
        labor_cost:      0,
      };
    }

    // All the real data is nested inside tc.labor
    const labor = tc.labor || {};
    byWeek[key].actual_hours    += parseFloat(labor.regular_hours    || 0);
    byWeek[key].labor_cost      += parseFloat(labor.costs            || 0);
    byWeek[key].scheduled_hours += parseFloat(labor.scheduled_hours  || 0);
  }

  const rows = Object.values(byWeek);
  console.log(`  Grouped into ${rows.length} weekly rows`);

  // Preview first 3 rows so we can verify
  console.log('\n  Preview (first 3 rows):');
  rows.slice(0, 3).forEach(r => {
    console.log(`    ${r.week_start} | ${r.employee_name} | ${r.role} | ${r.actual_hours.toFixed(2)}h | $${r.labor_cost.toFixed(2)}`);
  });

  console.log(`\n  Inserting into Supabase...`);
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const { error } = await supabase.from('labor_weekly').insert(batch);
    if (error) console.error(`  ✗ Batch ${i+1}–${Math.min(i+50, rows.length)}:`, error.message);
    else console.log(`  ✓ Batch ${i+1}–${Math.min(i+50, rows.length)} saved`);
  }
}

async function syncShifts(location) {
  console.log(`\n[${location.name}] Fetching shifts (scheduled hours)...`);
  const chunks = getMonthChunks();
  let allShifts = [];

  for (const chunk of chunks) {
    process.stdout.write(`  ${chunk.start}:`);
    try {
      const items = await fetchAllPages(
        `/locations/${location.id}/shifts?start_date=${chunk.start}&end_date=${chunk.end}`
      );
      console.log(` records`);
      allShifts = allShifts.concat(items);
    } catch (err) {
      console.log(` skipped (${err.message})`);
    }
  }

  console.log(`\n  Total: ${allShifts.length} shifts`);
  if (allShifts.length === 0) return;

  // Group scheduled hours by week + employee
  const byWeek = {};
  for (const shift of allShifts) {
    const date = shift.start_time?.split('T')[0] || shift.date;
    if (!date) continue;
    const weekStart    = getWeekStart(date);
    const employeeName = `${shift.first_name || ''} ${shift.last_name || ''}`.trim() ||
                          shift.employee?.name || 'Unknown';
    const key = `${weekStart}__${employeeName}__${location.id}`;
    if (!byWeek[key]) byWeek[key] = { weekStart, employeeName, locationId: location.id, hours: 0 };
    const duration = shift.duration_in_minutes
      ? shift.duration_in_minutes / 60
      : (parseFloat(shift.duration_in_hours || shift.hours || 0));
    byWeek[key].hours += duration;
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

async function main() {
  console.log('=== Nikos Ops — Homebase Sync ===\n');
  if (!HOMEBASE_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('✗ Missing env variables.'); process.exit(1);
  }
  for (const location of LOCATIONS) {
    try {
      await syncTimecards(location);
      await syncShifts(location);
    } catch (err) {
      console.error(`\n✗ Fatal error for ${location.name}:`, err.message);
    }
  }
  console.log('\n=== Sync complete ===');
}

main();
