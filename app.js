const STORAGE_KEY = 'finance-control-v1';
const MONTHS_SHORT = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const CATEGORY_COLORS = ['#76cdbb', '#ffad70', '#9d9eeb', '#e47b7a', '#c9d752', '#76aac4', '#d1a2cd'];
const CATEGORIES = ['Продукты', 'Кафе и досуг', 'Транспорт', 'Покупки и дом', 'Здоровье', 'Одежда', 'Образование', 'Коммуналка и связь', 'Цифровые сервисы', 'Путешествия', 'Дети', 'Накопления', 'Неразобранное'];
const FIXED_CATEGORIES = new Set(['Образование', 'Коммуналка и связь', 'Аренда']);

const DEFAULT_STATE = {
  settings: { income: 3200, savingsGoal: 800, weeklyLimit: 208, reserve: 180, uahPerEur: 51.8, usdPerEur: 1.08 },
  transactions: [],
  payments: [
    { id: 'rent', day: 5, name: 'Аренда квартиры', category: 'Аренда', amount: 820 },
    { id: 'school', day: 5, name: 'Школа Артёма', category: 'Образование', amount: 400 },
    { id: 'tutor', day: 5, name: 'Репетитор', category: 'Образование', amount: 60 },
    { id: 'mobile', day: 5, name: 'Мобильная связь', category: 'Коммуналка и связь', amount: 18 },
    { id: 'electricity', day: 25, name: 'Электричество', category: 'Коммуналка и связь', amount: 50 },
    { id: 'water', day: 25, name: 'Вода', category: 'Коммуналка и связь', amount: 20 },
    { id: 'internet', day: 25, name: 'Интернет', category: 'Коммуналка и связь', amount: 20 }
  ],
  paidPayments: {},
  shoppingItems: [],
  transactionFilter: 'all',
  search: ''
};

let state = cloneDefault();
let serverOnline = false;
let savePending = false;
let saveInFlight = false;
let toastTimer;
let pendingBotFiles = [];

function cloneDefault() { return JSON.parse(JSON.stringify(DEFAULT_STATE)); }
function normalizeState(saved) {
  return {
    ...cloneDefault(), ...saved,
    settings: { ...DEFAULT_STATE.settings, ...(saved.settings || {}) },
    payments: Array.isArray(saved.payments) && saved.payments.length ? saved.payments : cloneDefault().payments,
    transactions: Array.isArray(saved.transactions) ? saved.transactions : [],
    paidPayments: saved.paidPayments || {},
    shoppingItems: Array.isArray(saved.shoppingItems) ? saved.shoppingItems : []
  };
}
async function hydrateState() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error('server unavailable');
    state = normalizeState(await response.json());
    serverOnline = true;
  } catch {
    serverOnline = false;
  }
}
function saveState() {
  if (!serverOnline) {
    showToast('Запустите приложение через «Запустить приложение.cmd», чтобы сохранить данные в SQLite');
    return;
  }
  savePending = true;
  flushSave();
}
function flushSave() {
  if (!serverOnline || saveInFlight || !savePending) return;
  savePending = false;
  saveInFlight = true;
  fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) })
    .then(response => { if (!response.ok) throw new Error('save failed'); })
    .catch(() => { serverOnline = false; renderSettings(); showToast('Не удалось записать изменения в локальную базу'); })
    .finally(() => { saveInFlight = false; if (savePending) flushSave(); });
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const money = (value) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.abs(value || 0))} €`;
const moneyPrecise = (value) => `${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(value || 0))} €`;
const isBetween = (date, start, end) => date >= start && date <= end;
const toDate = (value) => new Date(value);
const inputDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

function showToast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 3600);
}

function financialPeriod(reference = new Date()) {
  const day = reference.getDate();
  const start = new Date(reference.getFullYear(), reference.getMonth() - (day < 10 ? 1 : 0), 10);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 9, 23, 59, 59, 999);
  return { start, end, key: inputDate(start) };
}
function periodLabel(period = financialPeriod()) {
  return `10 ${MONTHS_GEN[period.start.getMonth()]} — 9 ${MONTHS_GEN[period.end.getMonth()]}`;
}
function displayDate(value, withYear = false) {
  const d = typeof value === 'string' ? toDate(value) : value;
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}${withYear ? ` ${d.getFullYear()}` : ''}`;
}
function periodWeeks(period) {
  // Align to the Saturday on or before period.start so weeks run Sat→Fri
  const dow = period.start.getDay(); // 0=Sun … 6=Sat
  const daysBack = dow === 6 ? 0 : (dow + 1) % 7;
  const firstSat = new Date(period.start);
  firstSat.setDate(firstSat.getDate() - daysBack);
  firstSat.setHours(0, 0, 0, 0);
  const weeks = [];
  let current = new Date(firstSat);
  let weekNum = 1;
  while (current <= period.end) {
    const start = new Date(current);
    const end = new Date(current);
    end.setDate(end.getDate() + 6); // +6 = Friday
    end.setHours(23, 59, 59, 999);
    weeks.push({ start, end, label: `${start.getDate()}–${end.getDate()}`, number: weekNum });
    current = new Date(end);
    current.setDate(current.getDate() + 1);
    current.setHours(0, 0, 0, 0);
    weekNum++;
  }
  return weeks;
}
function paymentDate(payment, period) {
  const monthOffset = payment.day >= 10 ? 0 : 1;
  return new Date(period.start.getFullYear(), period.start.getMonth() + monthOffset, payment.day);
}

function normalizeNumber(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().replace(/\s/g, '').replace(',', '.').replace(/[—–]/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const source = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell); if (row.some(item => item !== '')) rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  row.push(cell); if (row.some(item => item !== '')) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map(header => header.trim());
  return rows.slice(1).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}
function parseBankDate(value) {
  const match = String(value || '').match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, dd, mm, yyyy, hh, min, sec] = match;
  return new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(sec));
}
function simpleHash(value) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i += 1) { result ^= value.charCodeAt(i); result = Math.imul(result, 16777619); }
  return `t${(result >>> 0).toString(36)}`;
}
function headerByPrefix(row, prefix) { return Object.keys(row).find(key => key.toLowerCase().startsWith(prefix.toLowerCase())); }
function classify(description, mcc) {
  const text = String(description || '').toLowerCase();
  if (/school|tutor|репетитор|ліцей/.test(text) || ['8211', '8299'].includes(String(mcc))) return 'Образование';
  if (/epay utilities|a1 |vivacom|yettel|lifecell|electric|water|інтернет/.test(text) || ['4900', '4814', '4812'].includes(String(mcc))) return 'Коммуналка и связь';
  if (/kaufland|lidl|billa|fantastico|metro|carrefour|conad|супермаркет/.test(text) || ['5411', '5499'].includes(String(mcc))) return 'Продукты';
  if (/restaurant|cafe|sweet things|sameks|mcd|coffee|bar |streetfood|піц/.test(text) || ['5812', '5813', '5814', '5441'].includes(String(mcc))) return 'Кафе и досуг';
  if (/booking\.com|airbnb|hotels\.com|rentalcars|ticketmaster|туристич|авиа|aeroflot/.test(text) || ['4722', '7011', '7012', '7513', '4411', '4415'].includes(String(mcc))) return 'Путешествия';
  if (/артем\s*к\.|artem\s*k\.|pocket money|карманные деньги/.test(text)) return 'Артем';
  if (/gas|shell|omv|паркінг|like bus|bdz|parking/.test(text) || ['5541', '5542', '7523', '4111'].includes(String(mcc))) return 'Транспорт';
  if (/emag|temu|jumbo|rozetka|prom\.ua|dm-|drogerie/.test(text) || ['5262', '5399', '5311', '5977', '5942'].includes(String(mcc))) return 'Покупки и дом';
  if (/pharmacy|аптека|sopharmacy/.test(text) || String(mcc) === '5912') return 'Здоровье';
  if (/zara|h&m|decathlon|cropp|sinsay/.test(text) || ['5651', '5691', '5699'].includes(String(mcc))) return 'Одежда';
  if (/apple|supercell|funpay|starpets/.test(text) || String(mcc) === '5816') return 'Цифровые сервисы';
  return 'Неразобранное';
}
function baseAmount(amount, currency) {
  const absolute = Math.abs(amount || 0);
  if (currency === 'EUR') return { value: absolute, method: 'EUR' };
  if (currency === 'BGN') return { value: absolute / 1.95583, method: 'BGN фиксированный курс' };
  if (currency === 'UAH') return { value: absolute / state.settings.uahPerEur, method: 'настройка UAH/EUR' };
  if (currency === 'USD') return { value: absolute / state.settings.usdPerEur, method: 'настройка USD/EUR' };
  return { value: absolute, method: 'валюта без конвертации' };
}
function transactionFromRow(row, accountId) {
  const dateRaw = row['Date and time'];
  const date = parseBankDate(dateRaw);
  const operationAmount = normalizeNumber(row['Operation amount']);
  const currency = String(row['Operation currency'] || 'EUR').trim().toUpperCase();
  const cardColumn = headerByPrefix(row, 'Card currency amount');
  const cardAmount = normalizeNumber(row[cardColumn]);
  const accountCurrencyMatch = (cardColumn || '').match(/\(([^)]+)\)/);
  const description = String(row.Description || 'Без описания').trim();
  const mcc = String(row.MCC || '').trim();
  if (!date || operationAmount === null) return null;
  const amount = baseAmount(operationAmount, currency);
  let type = operationAmount > 0 ? 'income' : 'expense';
  if (operationAmount < 0 && ['6010', '6011'].includes(mcc)) type = 'cash';
  if (operationAmount < 0 && mcc === '4829') type = 'review';
  if (/from uah account/i.test(description)) type = 'transfer';
  const signature = [accountId, date.toISOString(), description, mcc, operationAmount, currency, cardAmount, row.Balance || ''].join('|');
  return {
    id: simpleHash(signature), accountId, imported: true, date: date.toISOString(), description, mcc,
    operationAmount, currency, cardAmount, accountCurrency: accountCurrencyMatch ? accountCurrencyMatch[1] : '',
    exchangeRate: normalizeNumber(row['Exchange rate']), baseAmount: amount.value, conversion: amount.method,
    type, category: type === 'cash' ? 'Наличные' : type === 'transfer' ? 'Внутренний перевод' : type === 'review' ? 'Проверить перевод' : classify(description, mcc), manualCategory: false
  };
}

function runTransferMatching() {
  const candidates = state.transactions.filter(transaction => transaction.mcc === '4829' && transaction.imported);
  candidates.forEach(transaction => {
    if (!transaction.manualCategory) {
      transaction.type = transaction.operationAmount < 0 ? 'review' : 'income';
      transaction.category = transaction.operationAmount < 0 ? 'Проверить перевод' : 'Доход';
    }
  });
  const matched = new Set();
  for (const outgoing of candidates.filter(transaction => transaction.operationAmount < 0)) {
    if (matched.has(outgoing.id)) continue;
    const partner = candidates.find(incoming => {
      const minutes = Math.abs(toDate(incoming.date) - toDate(outgoing.date)) / 60000;
      const difference = Math.abs(incoming.baseAmount - outgoing.baseAmount) / Math.max(incoming.baseAmount, outgoing.baseAmount, 1);
      return incoming.operationAmount > 0 && incoming.accountId !== outgoing.accountId && !matched.has(incoming.id) && minutes <= 5 && difference <= .08;
    });
    if (partner) {
      [outgoing, partner].forEach(transaction => { transaction.type = 'transfer'; if (!transaction.manualCategory) transaction.category = 'Внутренний перевод'; });
      matched.add(outgoing.id); matched.add(partner.id);
    }
  }
}
function transactionsForPeriod(period = financialPeriod()) { return state.transactions.filter(transaction => isBetween(toDate(transaction.date), period.start, period.end)); }
function isExpense(transaction) { return transaction.type === 'expense'; }
function isFixed(transaction) { return FIXED_CATEGORIES.has(transaction.category); }
function flexExpenses(period = financialPeriod()) { return transactionsForPeriod(period).filter(transaction => isExpense(transaction) && !isFixed(transaction) && transaction.category !== 'Накопления'); }
function sum(list) { return list.reduce((total, item) => total + (Number(item.baseAmount ?? item.amount) || 0), 0); }
function actualSavings(period = financialPeriod()) { return sum(transactionsForPeriod(period).filter(transaction => transaction.category === 'Накопления')); }
function cashBalance() {
  const withdrawals = sum(state.transactions.filter(transaction => transaction.type === 'cash'));
  const spending = sum(state.transactions.filter(transaction => transaction.cashEntry));
  return withdrawals - spending;
}

function toggleShoppingPurchased(itemId) {
  const item = state.shoppingItems.find(entry => entry.id === itemId);
  if (!item) return;
  if (!item.purchased) {
    const txId = simpleHash(`shopping-tx|${item.id}`);
    item.purchased = true;
    item.createdTransactionId = txId;
    state.transactions.push({
      id: txId, accountId: 'Список покупок', imported: false, cashEntry: false,
      date: new Date().toISOString(), description: item.name, mcc: '',
      operationAmount: -item.price, currency: 'EUR', baseAmount: item.price,
      conversion: 'список покупок', type: 'expense', category: 'Продукты', manualCategory: true
    });
    showToast(`«${item.name}» куплено — добавлена трата ${money(item.price)}`);
  } else {
    if (item.createdTransactionId) {
      state.transactions = state.transactions.filter(tx => tx.id !== item.createdTransactionId);
      item.createdTransactionId = null;
    }
    item.purchased = false;
    showToast('Отметка снята');
  }
  saveState(); renderAll();
}
function deleteShoppingItem(itemId) {
  const item = state.shoppingItems.find(entry => entry.id === itemId);
  if (!item) return;
  if (item.createdTransactionId) state.transactions = state.transactions.filter(tx => tx.id !== item.createdTransactionId);
  state.shoppingItems = state.shoppingItems.filter(entry => entry.id !== itemId);
  saveState(); renderAll(); showToast('Позиция удалена');
}

function runAutoClassify() {
  let changed = 0;
  state.transactions.forEach(tx => {
    if (tx.manualCategory) return;
    const desc = tx.description || '';
    if (/from uah account/i.test(desc) && tx.type !== 'transfer') {
      tx.type = 'transfer'; tx.category = 'Внутренний перевод'; changed++;
    } else if (tx.imported && tx.type === 'expense') {
      const newCat = classify(desc, tx.mcc);
      if (newCat !== tx.category) { tx.category = newCat; changed++; }
    }
  });
  return changed;
}

function renderDashboard() {
  const period = financialPeriod();
  const fixedPlan = sum(state.payments);
  const budget = Math.max(0, state.settings.income - fixedPlan - state.settings.savingsGoal);
  const spent = sum(flexExpenses(period));
  const remaining = budget - spent;
  const savings = actualSavings(period);
  $('#period-label').textContent = periodLabel(period);
  $('#income-value').textContent = money(state.settings.income);
  $('#fixed-value').textContent = money(fixedPlan);
  $('#fixed-foot').textContent = `${state.payments.length} плановых платежей`;
  $('#savings-actual').textContent = money(savings);
  $('#savings-goal').textContent = money(state.settings.savingsGoal);
  $('#savings-progress').style.width = `${Math.min(100, state.settings.savingsGoal ? savings / state.settings.savingsGoal * 100 : 0)}%`;
  $('#savings-foot').textContent = savings ? `${Math.round(savings / state.settings.savingsGoal * 100)}% цели на период` : 'Отметьте перевод категорией «Накопления»';
  $('#budget-remaining').textContent = money(remaining);
  $('#budget-spent').textContent = money(spent);
  $('#budget-limit').textContent = money(budget);
  const use = budget ? spent / budget : 0;
  $('#budget-meter-fill').style.width = `${Math.min(use * 100, 100)}%`;
  $('#budget-meter-fill').style.background = use > 1 ? '#e05555' : use >= .85 ? '#c87c25' : '#2a1800';
  $('#budget-status').textContent = state.transactions.length === 0 ? 'Импортируйте выписку, чтобы увидеть прогресс' : remaining >= 0 ? `В запасе ${money(remaining)} до конца периода` : `Превышение плана на ${money(-remaining)}`;
  renderWeekly(period);
  renderCategories(period);
  renderInsights(period);
  renderUpcoming(period);
  $('#cash-balance').textContent = money(cashBalance());
}
function renderWeekly(period) {
  const weeks = periodWeeks(period);
  const expenses = flexExpenses(period);
  $('#weekly-chart').innerHTML = weeks.map(week => {
    const total = sum(expenses.filter(transaction => isBetween(toDate(transaction.date), week.start, week.end)));
    const ratio = state.settings.weeklyLimit ? total / state.settings.weeklyLimit : 0;
    const status = ratio > 1 ? 'over' : ratio >= .85 ? 'warning' : '';
    return `<div class="week-column"><div class="week-value">${money(total)}</div><div class="week-bar-wrap"><div class="week-bar ${status}" style="height:${Math.max(3, Math.min(ratio * 100, 100))}%"></div></div><div class="week-label">${week.label}</div></div>`;
  }).join('');
  const planned = state.settings.weeklyLimit * weeks.length;
  $('#weekly-subtitle').textContent = `${weeks.length} недель по ${money(state.settings.weeklyLimit)}`;
  $('#weekly-total-chip').textContent = money(sum(expenses));
  const difference = Math.max(0, (state.settings.income - sum(state.payments) - state.settings.savingsGoal) - planned);
  $('#weekly-note').textContent = difference > 0 ? `В недельные конверты распределено ${money(planned)}. Резерв ${money(state.settings.reserve)} и ещё ${money(Math.max(0, difference - state.settings.reserve))} остаются вне недельных лимитов.` : 'Недельные конверты покрывают весь гибкий бюджет.';
}
function getActiveWeek(period = financialPeriod()) {
  const weeks = periodWeeks(period);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return weeks.find(week => isBetween(today, week.start, week.end)) || (today < period.start ? weeks[0] : weeks[weeks.length - 1]);
}
function sumByCategory(transactions, category) { return sum(transactions.filter(transaction => transaction.category === category)); }
function shoppingTotal(items) { return items.reduce((total, item) => total + (Number(item.price) || 0), 0); }
function renderWeeklyView() {
  const period = financialPeriod();
  const week = getActiveWeek(period);
  const weeks = periodWeeks(period);
  const currentIndex = weeks.findIndex(item => item.number === week.number);
  const weekTransactions = flexExpenses(period).filter(transaction => isBetween(toDate(transaction.date), week.start, week.end));
  const weekSpent = sum(weekTransactions);
  const productSpent = sumByCategory(weekTransactions, 'Продукты');
  const cafeSpent = sumByCategory(weekTransactions, 'Кафе и досуг');
  const otherSpent = Math.max(0, weekSpent - productSpent - cafeSpent);
  const previous = currentIndex > 0 ? weeks[currentIndex - 1] : null;
  const previousTransactions = previous ? flexExpenses(period).filter(transaction => isBetween(toDate(transaction.date), previous.start, previous.end)) : [];
  const cafeRollover = Math.max(0, 40 - sumByCategory(previousTransactions, 'Кафе и досуг'));
  const productPenalty = Math.max(0, sumByCategory(previousTransactions, 'Продукты') - 168);
  const productLimit = Math.max(0, 168 - productPenalty);
  const cafeLimit = 40 + cafeRollover;
  const remaining = state.settings.weeklyLimit - weekSpent;
  const now = new Date();
  const dayStart = new Date(Math.max(now.setHours(0, 0, 0, 0), week.start.getTime()));
  const daysLeft = Math.max(1, Math.ceil((week.end - dayStart) / 86400000) + 1);
  const shoppingItems = state.shoppingItems.filter(item => item.weekKey === inputDate(week.start));
  const bigShopping = shoppingItems.filter(item => item.bucket === 'big-shop');
  const midweekShopping = shoppingItems.filter(item => item.bucket === 'midweek');
  const DOW_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  $('#week-range').textContent = `Неделя ${week.number}: ${DOW_SHORT[week.start.getDay()]} ${displayDate(week.start)} — ${DOW_SHORT[week.end.getDay()]} ${displayDate(week.end)}`;
  $('#week-available').textContent = money(remaining);
  $('#week-available-caption').textContent = remaining >= 0 ? `из ${money(state.settings.weeklyLimit)} на эту неделю` : `перерасход на ${money(-remaining)}`;
  $('#week-daily').textContent = money(Math.max(0, remaining) / daysLeft);
  $('#week-days-left').textContent = `на ${daysLeft} ${daysLeft === 1 ? 'день' : daysLeft < 5 ? 'дня' : 'дней'}`;
  $('#week-spent').textContent = money(weekSpent);
  $('#week-spent-caption').textContent = otherSpent ? `включая прочее: ${money(otherSpent)}` : 'по гибким категориям';
  $('#rollover-caption').textContent = currentIndex ? `Из прошлой недели: +${money(cafeRollover)} к кафе${productPenalty ? `, −${money(productPenalty)} из продуктов` : ''}.` : 'Перенос появится после завершения первой недели.';
  const envelopes = [
    { name: 'Продукты', caption: `130 € закупка + 38 € докупка${productPenalty ? `, штраф за прошлую неделю −${money(productPenalty)}` : ''}`, spent: productSpent, limit: productLimit, planned: shoppingTotal(bigShopping) + shoppingTotal(midweekShopping) },
    { name: 'Кафе и досуг', caption: cafeRollover ? `40 € + перенос ${money(cafeRollover)}` : 'Лимит недели: 40 €', spent: cafeSpent, limit: cafeLimit, planned: 0 },
    { name: 'Весь недельный бюджет', caption: otherSpent ? `Прочие траты: ${money(otherSpent)}` : 'Продукты, кафе и другие гибкие траты', spent: weekSpent, limit: state.settings.weeklyLimit, planned: 0 }
  ];
  $('#week-envelopes').innerHTML = envelopes.map(item => {
    const ratio = item.limit ? item.spent / item.limit : 0;
    const status = ratio > 1 ? 'over' : ratio >= .85 ? 'warning' : '';
    return `<article class="envelope"><div class="envelope-top"><div><h3>${esc(item.name)}</h3><p>${esc(item.caption)}</p></div><span class="chip chip-neutral">${money(Math.max(0, item.limit - item.spent))}</span></div><strong>${money(item.spent)} <span class="of">/ ${money(item.limit)}</span></strong><div class="envelope-progress ${status}"><span style="width:${Math.min(100, ratio * 100)}%"></span></div><small>${item.planned ? `В списке покупок запланировано ${money(item.planned)}` : ratio > 1 ? `Лимит превышен на ${money(item.spent - item.limit)}` : `Свободно ${money(item.limit - item.spent)}`}</small></article>`;
  }).join('');
  $('#shopping-total').textContent = money(shoppingTotal(shoppingItems.filter(item => !item.purchased)));
  $('#shopping-budgets').innerHTML = [
    { label: 'Основная закупка', amount: shoppingTotal(bigShopping), limit: 130 },
    { label: 'Докупка', amount: shoppingTotal(midweekShopping), limit: 38 }
  ].map(item => `<div class="shopping-budget">${item.label}<strong>${money(item.amount)} / ${money(item.limit)}</strong></div>`).join('');
  $('#shopping-list').innerHTML = shoppingItems.length ? shoppingItems.sort((a, b) => Number(a.purchased) - Number(b.purchased)).map(item => {
    const essentialBadge = item.essential ? '' : '<span class="optional-badge">можно отложить</span>';
    return `<div class="shopping-item ${item.purchased ? 'is-purchased' : ''}"><span>${item.purchased ? '✓' : '○'}</span><span class="shopping-item-name">${esc(item.name)}${essentialBadge}<small>· ${item.bucket === 'big-shop' ? 'закупка' : 'докупка'}</small></span><span class="shopping-item-price">${money(item.price)}</span><button class="shopping-buy-btn" data-shopping-item="${item.id}">${item.purchased ? 'Вернуть' : 'Куплено'}</button><button class="shopping-delete-btn" data-delete-item="${item.id}" aria-label="Удалить">×</button></div>`;
  }).join('') : '<div class="empty-state">Добавьте продукты, чтобы увидеть стоимость запланированной корзины.</div>';
  $$('#shopping-list [data-shopping-item]').forEach(button => button.addEventListener('click', () => toggleShoppingPurchased(button.dataset.shoppingItem)));
  $$('#shopping-list [data-delete-item]').forEach(button => button.addEventListener('click', () => deleteShoppingItem(button.dataset.deleteItem)));
  $('#weekly-guide').innerHTML = `<div class="panel-head"><div><h3>Небольшой план</h3><p>Чтобы бюджет не ощущался запретом</p></div><span class="spark">✦</span></div><div class="guide-point"><strong>Перед основной закупкой</strong><p>Корзина сейчас на ${money(shoppingTotal(bigShopping))}. До лимита 130 € ${shoppingTotal(bigShopping) <= 130 ? `ещё ${money(130 - shoppingTotal(bigShopping))}` : `перебор на ${money(shoppingTotal(bigShopping) - 130)}`}.</p></div><div class="guide-point"><strong>Покупка прямо сейчас</strong><p>${remaining > 0 ? `Безопасный ориентир — до ${money(Math.max(0, remaining) / daysLeft)} в день до ${displayDate(week.end)}.` : 'Неделя уже вышла за лимит: лучше использовать только обязательные покупки.'}</p></div><div class="guide-point"><strong>Что переносится</strong><p>Остаток кафе переносится в следующую неделю. Перерасход по продуктам уменьшит её продуктовый конверт.</p></div>`;
}
function renderCategories(period) {
  const grouped = {};
  flexExpenses(period).forEach(transaction => { grouped[transaction.category] = (grouped[transaction.category] || 0) + transaction.baseAmount; });
  const groups = Object.entries(grouped).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const total = groups.reduce((number, [, value]) => number + value, 0);
  let angle = 0;
  const slices = groups.map(([, value], index) => {
    const next = angle + (total ? value / total * 360 : 0); const piece = `${CATEGORY_COLORS[index]} ${angle}deg ${next}deg`; angle = next; return piece;
  });
  $('#category-donut').style.background = slices.length ? `conic-gradient(${slices.join(', ')})` : 'conic-gradient(#e8eeeb 0deg 360deg)';
  $('#donut-total').textContent = money(total);
  $('#category-legend').innerHTML = groups.length ? groups.map(([category, value], index) => `<li><span class="legend-dot" style="background:${CATEGORY_COLORS[index]}"></span><span class="legend-name">${esc(category)}</span><span class="legend-value">${Math.round(value / total * 100)}%</span></li>`).join('') : '<li><span class="legend-name">Пока нет расходов в этом периоде</span></li>';
}
function renderInsights(period) {
  const expenses = flexExpenses(period);
  const insights = [];
  const marketplace = sum(expenses.filter(transaction => /emag|temu|jumbo|rozetka|prom\.ua/i.test(transaction.description)));
  const micro = expenses.filter(transaction => ['5814', '5441'].includes(transaction.mcc) && transaction.baseAmount >= 1 && transaction.baseAmount <= 8);
  const cafe = sum(expenses.filter(transaction => transaction.category === 'Кафе и досуг'));
  const unreconciled = transactionsForPeriod(period).filter(transaction => transaction.type === 'review').length;
  if (marketplace > 100) insights.push({ icon: '◒', title: 'Маркетплейсы выше порога', text: `${money(marketplace)} за период. Попробуйте правило 48 часов перед новой покупкой.` });
  if (micro.length) insights.push({ icon: '◌', title: 'Малые траты на ходу', text: `${micro.length} операций на ${money(sum(micro))} в кафе и фастфуде до 8 € каждая.` });
  if (cafe >= 128) insights.push({ icon: '☕', title: 'Кафе близко к лимиту', text: `${money(cafe)} из ориентира 160 € на финансовый месяц.` });
  if (unreconciled) insights.push({ icon: '!', title: 'Есть переводы для проверки', text: `${unreconciled} операций с MCC 4829 не удалось надёжно сопоставить со своим счётом.` });
  if (!insights.length) insights.push({ icon: '✦', title: 'Пока всё спокойно', text: state.transactions.length ? 'Продолжайте пополнять данные — рекомендации появятся по мере истории.' : 'Загрузите CSV-выписки, и приложение покажет наблюдения.' });
  $('#insights-list').innerHTML = insights.slice(0, 3).map(item => `<div class="insight"><span class="insight-icon">${item.icon}</span><div><strong>${esc(item.title)}</strong><p>${esc(item.text)}</p></div></div>`).join('');
}
function renderUpcoming(period) {
  const items = state.payments.map(payment => ({ ...payment, date: paymentDate(payment, period) })).sort((a, b) => a.date - b.date).slice(0, 4);
  $('#upcoming-payments').innerHTML = items.map(item => {
    const paid = state.paidPayments[`${period.key}:${item.id}`];
    return `<div class="upcoming-item"><div class="date-block"><strong>${item.date.getDate()}</strong><small>${MONTHS_SHORT[item.date.getMonth()].replace('.', '')}</small></div><div><div class="upcoming-name">${esc(item.name)}</div><div class="upcoming-status">${paid ? 'Отмечено оплаченным' : 'Ожидает оплаты'}</div></div><div class="upcoming-amount">${money(item.amount)}</div></div>`;
  }).join('');
}

function renderTransactions() {
  const period = financialPeriod();
  const query = state.search.toLocaleLowerCase();
  const filtered = transactionsForPeriod(period).filter(transaction => {
    const matchFilter = state.transactionFilter === 'all' || (state.transactionFilter === 'transfer' ? transaction.type === 'transfer' : transaction.type === state.transactionFilter);
    const matchQuery = !query || `${transaction.description} ${transaction.category}`.toLocaleLowerCase().includes(query);
    return matchFilter && matchQuery;
  }).sort((a, b) => toDate(b.date) - toDate(a.date));
  $('#transactions-list').innerHTML = filtered.length ? filtered.map(transaction => {
    const sign = transaction.operationAmount > 0 ? '+' : transaction.type === 'cash' || transaction.type === 'transfer' ? '↔' : '−';
    const amountClass = transaction.operationAmount > 0 ? 'positive' : transaction.type === 'cash' || transaction.type === 'transfer' ? 'muted' : 'negative';
    const original = `${Math.abs(transaction.operationAmount).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${transaction.currency}`;
    const options = categoryOptions(transaction.category, transaction.type);
    return `<div class="transaction-row"><div><div class="merchant">${esc(transaction.description)}${transaction.type === 'review' ? '<span class="review-tag">проверить</span>' : ''}</div><div class="transaction-meta">${displayDate(transaction.date, true)} · ${esc(transaction.accountId)} · MCC ${esc(transaction.mcc || '—')}</div></div><select class="category-select" data-transaction-id="${transaction.id}" aria-label="Категория для ${esc(transaction.description)}">${options}</select><div class="amount ${amountClass}" title="Исходная сумма: ${esc(original)}; способ конвертации: ${esc(transaction.conversion)}">${sign} ${moneyPrecise(transaction.baseAmount)}</div></div>`;
  }).join('') : '<div class="empty-state">В выбранном финансовом периоде нет подходящих операций.</div>';
  $$('.category-select').forEach(select => select.addEventListener('change', event => {
    const transaction = state.transactions.find(item => item.id === event.target.dataset.transactionId);
    if (!transaction) return;
    transaction.category = event.target.value;
    if (transaction.type === 'review' && !['Проверить перевод', 'Внутренний перевод'].includes(transaction.category)) transaction.type = 'expense';
    if (transaction.category === 'Внутренний перевод') transaction.type = 'transfer';
    transaction.manualCategory = true;
    saveState(); renderAll(); showToast('Категория сохранена');
  }));
}
function categoryOptions(selected, type) {
  const categories = type === 'transfer' || type === 'review' ? [...CATEGORIES, 'Внутренний перевод', 'Проверить перевод'] : CATEGORIES;
  if (!categories.includes(selected)) categories.unshift(selected);
  return categories.map(category => `<option value="${esc(category)}" ${category === selected ? 'selected' : ''}>${esc(category)}</option>`).join('');
}

function renderCalendar() {
  const period = financialPeriod();
  const payments = state.payments.map(payment => ({ ...payment, date: paymentDate(payment, period) })).sort((a, b) => a.date - b.date);
  const total = sum(payments);
  const paid = payments.filter(payment => state.paidPayments[`${period.key}:${payment.id}`]);
  $('#calendar-total').textContent = money(total);
  $('#calendar-paid').textContent = money(sum(paid));
  $('#calendar-pending').textContent = money(total - sum(paid));
  $('#calendar-list').innerHTML = payments.map(payment => {
    const key = `${period.key}:${payment.id}`; const isPaid = Boolean(state.paidPayments[key]);
    return `<article class="calendar-item"><div class="calendar-day"><strong>${payment.date.getDate()}</strong><span>${MONTHS_SHORT[payment.date.getMonth()]}</span></div><div><div class="calendar-name">${esc(payment.name)}</div><div class="calendar-category">${esc(payment.category)}</div></div><div class="calendar-amount">${money(payment.amount)}</div><button class="${isPaid ? 'paid-toggle' : 'pending-toggle'}" data-payment-key="${key}">${isPaid ? 'Оплачено ✓' : 'Отметить'}</button></article>`;
  }).join('');
  $$('[data-payment-key]').forEach(button => button.addEventListener('click', () => {
    const key = button.dataset.paymentKey;
    if (state.paidPayments[key]) delete state.paidPayments[key]; else state.paidPayments[key] = true;
    saveState(); renderDashboard(); renderCalendar();
  }));
}

function renderSettings() {
  const budgetForm = $('#budget-form');
  budgetForm.income.value = state.settings.income;
  budgetForm.savingsGoal.value = state.settings.savingsGoal;
  budgetForm.weeklyLimit.value = state.settings.weeklyLimit;
  budgetForm.reserve.value = state.settings.reserve;
  const fxForm = $('#fx-form');
  fxForm.uahPerEur.value = state.settings.uahPerEur;
  fxForm.usdPerEur.value = state.settings.usdPerEur;
  $('#data-count').textContent = state.transactions.length;
  $('#account-count').textContent = new Set(state.transactions.map(transaction => transaction.accountId)).size;
  const databaseStatus = $('#database-status');
  databaseStatus.textContent = serverOnline ? 'SQLite подключена: данные сохраняются в data/finance.db на этом устройстве.' : 'Локальная база недоступна. Запускайте приложение через «Запустить приложение.cmd».';
  databaseStatus.className = `database-status ${serverOnline ? 'is-online' : 'is-offline'}`;
}
function renderAll() { runTransferMatching(); renderDashboard(); renderWeeklyView(); renderTransactions(); renderCalendar(); renderSettings(); }

async function previewFiles(files) {
  let count = 0; let valid = 0;
  for (const file of files) { const rows = parseCsv(await file.text()); count += rows.length; if (rows[0]?.['Date and time'] && rows[0]?.['Operation amount']) valid += rows.length; }
  const el = $('#import-preview');
  el.hidden = false;
  el.textContent = valid ? `Найдено ${valid} операций в ${files.length} ${files.length === 1 ? 'файле' : 'файлах'}. Проверьте имя источника и нажмите «Импортировать».` : `Не удалось найти ожидаемые колонки «Date and time» и «Operation amount». Строк прочитано: ${count}.`;
  $('#import-submit').disabled = !valid;
}
async function importFiles(files, manualAccount) {
  const existingIds = new Set(state.transactions.map(transaction => transaction.id));
  let added = 0, duplicate = 0, invalid = 0;
  for (const file of files) {
    const rows = parseCsv(await file.text());
    const name = manualAccount && files.length === 1 ? manualAccount.trim() : file.name.replace(/\.csv$/i, '');
    rows.forEach(row => {
      const transaction = transactionFromRow(row, name || 'Импорт');
      if (!transaction) { invalid += 1; return; }
      if (existingIds.has(transaction.id)) { duplicate += 1; return; }
      existingIds.add(transaction.id); state.transactions.push(transaction); added += 1;
    });
  }
  saveState(); renderAll();
  showToast(`Импорт: добавлено ${added}, пропущено повторов ${duplicate}${invalid ? `, не прочитано ${invalid}` : ''}`);
}

function openPaymentEditor() {
  $('#payment-form-list').innerHTML = state.payments.map(payment => `<div class="payment-form-row"><span>${payment.day} число</span><label>Название<input name="name-${payment.id}" value="${esc(payment.name)}" /></label><label>Сумма, €<input name="amount-${payment.id}" type="number" min="0" step="1" value="${payment.amount}" /></label></div>`).join('');
  $('#payment-dialog').showModal();
}
function addManualTransaction(form) {
  const data = new FormData(form);
  const value = Number(data.get('amount'));
  if (!value) return;
  const date = new Date(`${data.get('date')}T12:00:00`);
  const entryType = data.get('entryType');
  const source = data.get('source');
  const isIncome = entryType === 'income';
  state.transactions.push({
    id: simpleHash(`manual|${Date.now()}|${Math.random()}`), accountId: source === 'cash' ? 'Кошелёк наличных' : 'Ручной ввод', imported: false, cashEntry: source === 'cash' && entryType === 'expense',
    date: date.toISOString(), description: data.get('description') || (isIncome ? 'Ручной доход' : entryType === 'transfer' ? 'Ручной перевод' : 'Ручная трата'), mcc: '', operationAmount: isIncome ? value : -value, currency: 'EUR',
    baseAmount: value, conversion: 'ручной ввод', type: entryType, category: data.get('category'), manualCategory: true
  });
  saveState(); renderAll(); $('#cash-dialog').close(); form.reset(); showToast('Операция добавлена');
}
function exportBackup() {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...state }, null, 2)], { type: 'application/json' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `finance-backup-${inputDate(new Date())}.json`; link.click(); URL.revokeObjectURL(link.href); showToast('Резервная копия скачана');
}

async function checkBotFiles() {
  if (!serverOnline) return;
  try {
    const res = await fetch('/api/bot-files', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    pendingBotFiles = data.files || [];
    updateBotNotification();
  } catch {}
}
function updateBotNotification() {
  const wrap = $('#bot-import-wrap');
  const info = $('#bot-import-info');
  if (!wrap || !info) return;
  if (pendingBotFiles.length > 0) {
    wrap.hidden = false;
    info.textContent = `${pendingBotFiles.length} CSV-${pendingBotFiles.length === 1 ? 'файл' : 'файла'} ожидают импорта: ${pendingBotFiles.join(', ')}`;
  } else {
    wrap.hidden = true;
    info.textContent = '';
  }
}
async function importBotFiles() {
  if (!pendingBotFiles.length) return;
  const existingIds = new Set(state.transactions.map(tx => tx.id));
  let added = 0, duplicate = 0, invalid = 0;
  const completedFiles = [];
  const failedFiles = [];
  for (const filename of pendingBotFiles) {
    try {
      const res = await fetch(`/bot-imports/${encodeURIComponent(filename)}`);
      if (!res.ok) { failedFiles.push(filename); continue; }
      const text = await res.text();
      const rows = parseCsv(text);
      const name = filename.replace(/\.csv$/i, '');
      rows.forEach(row => {
        const tx = transactionFromRow(row, name);
        if (!tx) { invalid++; return; }
        if (existingIds.has(tx.id)) { duplicate++; return; }
        existingIds.add(tx.id); state.transactions.push(tx); added++;
      });
      completedFiles.push(filename);
    } catch {
      failedFiles.push(filename);
    }
  }
  if (completedFiles.length) {
    const doneResponse = await fetch('/api/bot-files/done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: completedFiles })
    }).catch(() => null);
    if (!doneResponse?.ok) failedFiles.push(...completedFiles);
  }
  pendingBotFiles = [...new Set(failedFiles)];
  updateBotNotification();
  saveState(); renderAll();
  showToast(`Telegram: добавлено ${added}, дублей ${duplicate}${invalid ? `, не прочитано ${invalid}` : ''}${pendingBotFiles.length ? `, ожидают повтора ${pendingBotFiles.length}` : ''}`);
}

async function cloudSync() {
  const btn = $('#cloud-sync-btn');
  if (btn) btn.disabled = true;
  try {
    const r = await fetch('/api/cloud-sync', { cache: 'no-store' }).then(x => x.json());
    if (r.ok) {
      if (r.imported_expenses || r.imported_csvs) {
        await initialize();
        showToast(`Синхронизировано: ${r.imported_expenses} операций, ${r.imported_csvs} CSV`);
      } else {
        showToast('Нет новых данных от бота');
      }
    } else {
      showToast(r.reason || 'Ошибка синхронизации', 'error');
    }
  } catch {
    showToast('Нет связи с сервером', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function setupEvents() {
  $$('.nav-item').forEach(button => button.addEventListener('click', () => activateView(button.dataset.view)));
  $$('[data-view-target]').forEach(button => button.addEventListener('click', () => activateView(button.dataset.viewTarget)));
  $$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => {
    const dialog = $(`#${button.dataset.closeDialog}`);
    if (!dialog) return;
    dialog.close();
    dialog.querySelector('form')?.reset();
    const preview = $('#import-preview');
    if (preview) preview.hidden = true;
  }));
  $('#open-settings').addEventListener('click', () => activateView('settings'));
  $('#open-import').addEventListener('click', () => $('#import-dialog').showModal());
  $('#transactions-import').addEventListener('click', () => $('#import-dialog').showModal());
  $('#csv-files').addEventListener('change', event => previewFiles([...event.target.files]));
  $('#import-form').addEventListener('submit', async event => { event.preventDefault(); const files = [...$('#csv-files').files]; if (!files.length) return; await importFiles(files, $('#import-account').value); $('#import-dialog').close(); event.currentTarget.reset(); $('#import-preview').hidden = true; });
  $('#open-cash-entry').addEventListener('click', () => openCashDialog());
  $('#transactions-cash').addEventListener('click', () => openCashDialog());
  $('#cash-form').addEventListener('submit', event => { event.preventDefault(); addManualTransaction(event.currentTarget); });
  $('#cash-form').entryType.addEventListener('change', event => { if (event.target.value === 'transfer') $('#cash-category').value = 'Накопления'; });
  $('#open-payment-edit').addEventListener('click', openPaymentEditor);
  $('#payment-form').addEventListener('submit', event => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    state.payments.forEach(payment => { payment.name = String(data.get(`name-${payment.id}`)).trim() || payment.name; payment.amount = Math.max(0, Number(data.get(`amount-${payment.id}`)) || 0); });
    saveState(); renderAll(); $('#payment-dialog').close(); showToast('План платежей обновлён');
  });
  $('#budget-form').addEventListener('submit', event => { event.preventDefault(); const data = new FormData(event.currentTarget); ['income', 'savingsGoal', 'weeklyLimit', 'reserve'].forEach(key => state.settings[key] = Math.max(0, Number(data.get(key)) || 0)); saveState(); renderAll(); showToast('План месяца сохранён'); });
  $('#fx-form').addEventListener('submit', event => { event.preventDefault(); const data = new FormData(event.currentTarget); state.settings.uahPerEur = Math.max(.01, Number(data.get('uahPerEur')) || 51.8); state.settings.usdPerEur = Math.max(.01, Number(data.get('usdPerEur')) || 1.08); state.transactions.forEach(transaction => { if (transaction.imported) { const converted = baseAmount(transaction.operationAmount, transaction.currency); transaction.baseAmount = converted.value; transaction.conversion = converted.method; } }); saveState(); renderAll(); showToast('Курсы пересчитаны для импортированных операций'); });
  $$('#type-filters .filter').forEach(button => button.addEventListener('click', () => { state.transactionFilter = button.dataset.filter; $$('#type-filters .filter').forEach(item => item.classList.toggle('is-selected', item === button)); renderTransactions(); }));
  $('#transaction-search').addEventListener('input', event => { state.search = event.target.value; renderTransactions(); });
  $('#shopping-form').addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const price = Number(data.get('price'));
    if (!price) return;
    const week = getActiveWeek();
    state.shoppingItems.push({ id: simpleHash(`shopping|${Date.now()}|${Math.random()}`), weekKey: inputDate(week.start), name: String(data.get('name')).trim(), price, bucket: data.get('bucket'), essential: data.get('essential') !== '0', purchased: false });
    saveState(); event.currentTarget.reset(); renderWeeklyView(); showToast('Позиция добавлена в список покупок');
  });
  $('#export-backup').addEventListener('click', exportBackup);
  $('#clear-data').addEventListener('click', () => { if (!confirm('Удалить все импортированные операции, наличные и отметки платежей из этого браузера?')) return; state = cloneDefault(); saveState(); renderAll(); showToast('Локальные данные удалены'); });
  $('#open-help').addEventListener('click', () => $('#help-dialog').showModal());
  const botBtn = $('#bot-import-btn');
  if (botBtn) botBtn.addEventListener('click', importBotFiles);
  const cloudSyncBtn = $('#cloud-sync-btn');
  if (cloudSyncBtn) cloudSyncBtn.addEventListener('click', cloudSync);
}
function openCashDialog() { const form = $('#cash-form'); form.reset(); form.date.value = inputDate(new Date()); form.entryType.value = 'expense'; form.source.value = 'cash'; $('#cash-dialog').showModal(); }
function activateView(view) {
  $$('.nav-item').forEach(button => button.classList.toggle('is-active', button.dataset.view === view));
  $$('[data-view-panel]').forEach(panel => panel.classList.toggle('is-visible', panel.dataset.viewPanel === view));
  $('#page-title').textContent = ({ dashboard: 'Финансовый месяц', weekly: 'Недельный бюджет', transactions: 'Операции', calendar: 'Платежи', settings: 'Настройки' })[view] || 'Финансовый месяц';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function initialize() {
  await hydrateState();
  const reclassified = runAutoClassify();
  if (reclassified > 0) saveState();
  await checkBotFiles();
  $('#cash-category').innerHTML = CATEGORIES.filter(category => category !== 'Неразобранное').map(category => `<option>${category}</option>`).join('');
  setupEvents(); renderAll();
}
initialize();
