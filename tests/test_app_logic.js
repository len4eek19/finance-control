const test = require('node:test');
const assert = require('node:assert/strict');
const {
  categorySummary,
  moveWeekKey,
  movePeriodKey,
  planMetrics,
  categoryBudgetSummary,
  budgetSnapshot,
  forecastSpend
} = require('../app-logic.js');

test('categorySummary returns totals and percentages for every category', () => {
  const summary = categorySummary([
    { category: 'Продукты', baseAmount: 30 },
    { category: 'Продукты', baseAmount: 20 },
    { category: 'Кафе и досуг', baseAmount: 50 }
  ]);

  assert.deepEqual(summary, [
    { category: 'Продукты', amount: 50, share: 50, count: 2 },
    { category: 'Кафе и досуг', amount: 50, share: 50, count: 1 }
  ]);
});

test('moveWeekKey moves within bounds and keeps current week when direction is absent', () => {
  const weeks = [
    { key: '2026-08-01' },
    { key: '2026-08-08' },
    { key: '2026-08-15' }
  ];

  assert.equal(moveWeekKey(weeks, '2026-08-08', -1), '2026-08-01');
  assert.equal(moveWeekKey(weeks, '2026-08-08', 1), '2026-08-15');
  assert.equal(moveWeekKey(weeks, '2026-08-01', -1), '2026-08-01');
  assert.equal(moveWeekKey(weeks, 'missing', 1), '2026-08-01');
});

test('movePeriodKey shifts the financial month by one month', () => {
  assert.equal(movePeriodKey('2026-08-10', -1), '2026-07-10');
  assert.equal(movePeriodKey('2026-08-10', 1), '2026-09-10');
});

test('planMetrics calculates progress and monthly contribution', () => {
  assert.deepEqual(
    planMetrics({ targetAmount: 1000, savedAmount: 250, targetDate: '2026-12-15' }, new Date('2026-08-04')),
    { saved: 250, remaining: 750, progress: 25, monthsLeft: 5, monthlyNeeded: 150 }
  );
});

test('categoryBudgetSummary compares actual spending with configured limits', () => {
  assert.deepEqual(
    categoryBudgetSummary(
      [
        { category: 'Продукты', baseAmount: 60 },
        { category: 'Кафе и досуг', baseAmount: 120 }
      ],
      { 'Продукты': 100, 'Кафе и досуг': 100 }
    ),
    [
      { category: 'Кафе и досуг', actual: 120, limit: 100, remaining: -20, progress: 100, over: true },
      { category: 'Продукты', actual: 60, limit: 100, remaining: 40, progress: 60, over: false }
    ]
  );
});

test('budgetSnapshot separates available, reserved, spent and free money', () => {
  assert.deepEqual(
    budgetSnapshot({ income: 3200, fixed: 1388, savings: 800, reserved: 150, spent: 200 }),
    { available: 1012, reserved: 150, spent: 200, free: 662 }
  );
});

test('forecastSpend projects current daily spending through the period end', () => {
  assert.deepEqual(forecastSpend(300, 10, 30), { projected: 900, remainingDays: 20, dailyAverage: 30 });
  assert.deepEqual(forecastSpend(0, 0, 30), { projected: 0, remainingDays: 30, dailyAverage: 0 });
});
