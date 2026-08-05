(function exposeFinanceLogic(root, factory) {
  const api = factory();
  root.FinanceLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createFinanceLogic() {
  function categorySummary(transactions) {
    const grouped = new Map();
    transactions.forEach(transaction => {
      const category = transaction.category || 'Неразобранное';
      const amount = Number(transaction.baseAmount ?? transaction.amount) || 0;
      const current = grouped.get(category) || { amount: 0, count: 0 };
      current.amount += amount;
      current.count += 1;
      grouped.set(category, current);
    });
    const total = [...grouped.values()].reduce((sum, item) => sum + item.amount, 0);
    return [...grouped.entries()]
      .map(([category, item]) => ({
        category,
        amount: Math.round(item.amount * 100) / 100,
        share: total ? Math.round(item.amount / total * 100) : 0,
        count: item.count
      }))
      .sort((a, b) => b.amount - a.amount);
  }

  function moveWeekKey(weeks, selectedKey, direction) {
    if (!weeks.length) return null;
    const currentIndex = weeks.findIndex(week => week.key === selectedKey);
    if (currentIndex < 0) return weeks[0].key;
    const nextIndex = Math.min(weeks.length - 1, Math.max(0, currentIndex + (direction || 0)));
    return weeks[nextIndex].key;
  }

  function movePeriodKey(periodKey, direction) {
    const date = new Date(`${periodKey}T12:00:00`);
    if (Number.isNaN(date.getTime())) return periodKey;
    date.setMonth(date.getMonth() + direction);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-10`;
  }

  function planMetrics(plan, referenceDate = new Date()) {
    const target = Number(plan.targetAmount) || 0;
    const saved = Math.min(target, Math.max(0, Number(plan.savedAmount) || 0));
    const remaining = Math.max(0, target - saved);
    const targetDate = new Date(`${plan.targetDate}T12:00:00`);
    const reference = new Date(referenceDate);
    const monthsLeft = Number.isNaN(targetDate.getTime())
      ? 0
      : Math.max(1, (targetDate.getFullYear() - reference.getFullYear()) * 12 + targetDate.getMonth() - reference.getMonth() + 1);
    return {
      saved,
      remaining,
      progress: target ? Math.min(100, Math.round(saved / target * 100)) : 0,
      monthsLeft,
      monthlyNeeded: monthsLeft ? Math.ceil(remaining / monthsLeft) : remaining
    };
  }

  function categoryBudgetSummary(transactions, limits) {
    const actuals = categorySummary(transactions);
    const categories = new Set([...actuals.map(item => item.category), ...Object.keys(limits || {})]);
    return [...categories]
      .filter(category => Number(limits?.[category]) > 0)
      .map(category => {
        const actual = actuals.find(item => item.category === category)?.amount || 0;
        const limit = Number(limits[category]);
        return {
          category,
          actual,
          limit,
          remaining: limit - actual,
          progress: Math.min(100, Math.round(actual / limit * 100)),
          over: actual > limit
        };
      })
      .sort((a, b) => b.actual - a.actual);
  }

  function budgetSnapshot({ income, fixed, savings, reserved, spent }) {
    const available = Math.max(0, (Number(income) || 0) - (Number(fixed) || 0) - (Number(savings) || 0));
    const safeReserved = Math.max(0, Number(reserved) || 0);
    const safeSpent = Math.max(0, Number(spent) || 0);
    return { available, reserved: safeReserved, spent: safeSpent, free: available - safeReserved - safeSpent };
  }

  function forecastSpend(spent, elapsedDays, totalDays) {
    const safeSpent = Math.max(0, Number(spent) || 0);
    const safeElapsed = Math.max(0, Number(elapsedDays) || 0);
    const safeTotal = Math.max(safeElapsed, Number(totalDays) || 0);
    const dailyAverage = safeElapsed ? safeSpent / safeElapsed : 0;
    return {
      projected: Math.round((safeSpent + dailyAverage * Math.max(0, safeTotal - safeElapsed)) * 100) / 100,
      remainingDays: Math.max(0, safeTotal - safeElapsed),
      dailyAverage: Math.round(dailyAverage * 100) / 100
    };
  }

  return { categorySummary, moveWeekKey, movePeriodKey, planMetrics, categoryBudgetSummary, budgetSnapshot, forecastSpend };
});
