import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const supabase          = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const LOCATION_ID   = '7a9a7f96-1ec0-4667-9c11-7418a2a85816';
const LOCATION_NAME = 'Nikos UAlbany';

function getWeekStart(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay();
  d.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
  return d.toISOString().split('T')[0];
}

function parseCSV(filePath) {
  const lines  = readFileSync(filePath, 'utf8').trim().split('\n');
  const header = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    return Object.fromEntries(header.map((h, i) => [h, cols[i]?.trim()]));
  });
}

function aggregateToWeekly(dailyRows) {
  const byWeek = {};
  for (const row of dailyRows) {
    const weekStart = getWeekStart(row.date);
    if (!byWeek[weekStart]) {
      byWeek[weekStart] = {
        week_start:    weekStart,
        location_id:   LOCATION_ID,
        location_name: LOCATION_NAME,
        gross_sales:   0,
        net_sales:     0,
        covers:        0,
      };
    }
    byWeek[weekStart].gross_sales += parseFloat(row.gross_sales || 0);
    byWeek[weekStart].net_sales   += parseFloat(row.net_sales   || 0);
    byWeek[weekStart].covers      += parseInt(row.checks        || 0);
  }
  return Object.values(byWeek).map(w => ({
    ...w,
    gross_sales: parseFloat(w.gross_sales.toFixed(2)),
    net_sales:   parseFloat(w.net_sales.toFixed(2)),
  }));
}

async function main() {
  console.log('=== Nikos Ops — Oracle Sales Import ===\n');

  const daily = parseCSV('./data/oracle_daily_sales.csv');
  console.log(`Parsed ${daily.length} days of sales data`);
  console.log('Sample:', daily[0]);

  const weekly = aggregateToWeekly(daily);
  console.log(`\nAggregated into ${weekly.length} weekly rows`);

  console.log('\nWeekly preview:');
  weekly.slice(0, 5).forEach(w =>
    console.log(`  ${w.week_start} | Net: $${w.net_sales} | Gross: $${w.gross_sales} | Checks: ${w.covers}`)
  );

  console.log('\nInserting into Supabase...');
  for (let i = 0; i < weekly.length; i += 50) {
    const batch = weekly.slice(i, i + 50);
    const { error } = await supabase.from('sales_weekly').insert(batch);
    if (error) console.error(`  ✗ Batch error:`, error.message);
    else console.log(`  ✓ Batch ${i+1}–${Math.min(i+50, weekly.length)} saved`);
  }

  console.log('\n=== Import complete ===');
}

main();
