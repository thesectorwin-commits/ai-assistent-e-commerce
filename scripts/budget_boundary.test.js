// Unit test for the hard-ceiling budget check (api/_budget.js) — no server/network
// involved, just the pure boundary logic. This is the single implementation
// api/chat.js now uses for BOTH the free-text budget ceiling and the structured
// known-budget range's upper bound, so there is only one semantic to test:
// "до X" / "не дороже X" -> price <= X passes, price > X fails.
// Run: node scripts/budget_boundary.test.js
import { exceedsBudget } from '../api/_budget.js';

const cases = [
  { price: 19999, max: 20000, expectExceeds: false, label: 'price below max -> passes' },
  { price: 20000, max: 20000, expectExceeds: false, label: 'price === max -> passes (TC-39)' },
  { price: 20001, max: 20000, expectExceeds: true, label: 'price above max -> fails' },
];

let failed = 0;
for (const c of cases) {
  const got = exceedsBudget(c.price, c.max);
  const ok = got === c.expectExceeds;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.label}: exceedsBudget(${c.price}, ${c.max}) = ${got}, expected ${c.expectExceeds}`);
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed) process.exitCode = 1;
