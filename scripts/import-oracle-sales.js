import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const supabase          = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const LOCATION_ID   = '7a9a7f96-1ec0-4667-9c11-7418a2a85816';
const LOCATION_NAME = 'Nikos UAlbany';

function parseCSV(filePath) {
  const lines  = readFileSync(filePath, 'utf8').trim().split('\n');
  const header = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    return Object.fromEntries(header.map((h, i) => [h, cols[i]?.trim()]));
  });
}

async function main() {
  console.log('=== Nikos Ops — Oracle Sales Import (daily) ===\n');

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('✗ Missing env variables.'); process.exit(1);
  }

  const daily = parseCSV('./data/oracle_daily_sales.csv');
  console.log(`Parsed ${daily.length} daily rows`);
  console.log(`Date range: ${daily[0].date} → ${daily[daily.length-1].date}`);

  // Map to sales_daily schema
  const rows = daily.map(r => ({
    week_start:    r.date,          // renamed col — stores the actual date
    location_id:   LOCATION_ID,
    location_name: LOCATION_NAME,
    gross_sales:   parseFloat(r.gross_sales || 0),
    net_sales:     parseFloat(r.net_sales   || 0),
    covers:        parseInt(r.checks        || 0),
  }));

  // Preview
  console.log('\nSample rows:');
  rows.filter(r => r.net_sales > 0).slice(0, 5).forEach(r =>
    console.log(`  ${r.week_start} | Net: $${r.net_sales} | Gross: $${r.gross_sales} | Checks: ${r.covers}`)
  );
  console.log('\nZero days sample:');
  rows.filter(r => r.net_sales === 0).slice(0, 3).forEach(r =>
    console.log(`  ${r.week_start} | $0 — closed/prep day`)
  );

  // Clear old weekly data first
  console.log('\nClearing old sales_daily data...');
  const { error: delError } = await supabase
    .from('sales_daily')
    .delete()
    .eq('location_id', LOCATION_ID);
  if (delError) console.error('  ✗ Clear error:', delError.message);
  else console.log('  ✓ Cleared');

  // Insert in batches
  console.log('\nInserting into sales_daily...');
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const { error } = await supabase.from('sales_daily').insert(batch);
    if (error) console.error(`  ✗ Batch ${i+1}–${Math.min(i+50, rows.length)}:`, error.message);
    else console.log(`  ✓ Batch ${i+1}–${Math.min(i+50, rows.length)} saved`);
  }

  // Verify via weekly view
  console.log('\nVerifying weekly view...');
  const { data: weekly, error: viewError } = await supabase
    .from('sales_weekly')
    .select('*')
    .order('week_start', { ascending: true });

  if (viewError) {
    console.error('  ✗ View error:', viewError.message);
  } else {
    console.log(`  ✓ ${weekly.length} weeks visible in sales_weekly view`);
    console.log('\n  Top 5 weeks by net sales:');
    [...weekly]
      .sort((a, b) => b.net_sales - a.net_sales)
      .slice(0, 5)
      .forEach(w => console.log(
        `    ${w.week_start} | Net: $${parseFloat(w.net_sales).toFixed(2)} | ` +
        `Checks: ${w.covers} | Open days: ${w.open_days}`
      ));
  }

  console.log('\n=== Import complete ===');
}

main();
