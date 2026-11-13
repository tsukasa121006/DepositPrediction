// =====================================================
// 給与計算
// =====================================================
// ・給与計算ページの「11月分」＝ 11月に働いた分 → 12月25日（土日祝なら直前の平日）支給
// ・毎月1日以降に初めてアプリを開いたとき、その月の給料予定を「通常」タブに自動追加
//   （金額は「基本給＋手当」から計算した手取り。残業代は含めない）
// ・「預金管理に反映」ボタンで、残業代込みの手取りに予定を更新

// ---------- 税・保険の計算に使う値 ----------
// 所得税は国税庁「電子計算機等による源泉徴収税額の計算方法」（月額・甲欄）の考え方に沿った近似です。
// 税制改正で数値が変わった場合はここを修正してください。
const INCOME_TAX_PARAMS = {
  basicDeduction: 48334,       // 基礎控除（月額）
  dependentDeduction: 31667,   // 扶養控除（1人あたり月額）
  // 給与所得控除（月額）：[上限額, 率, 加算額] 上限以下ならこの式を使う
  employmentDeduction: [
    [158333, 0, 54167],
    [299999, 0.30, 6667],
    [549999, 0.20, 36667],
    [708330, 0.10, 91667],
    [Infinity, 0, 162500]
  ],
  // 税率（月額）：[上限額, 税率, 控除額]（復興特別所得税を含む）
  rates: [
    [162500, 0.05105, 0],
    [275000, 0.1021, 8296],
    [579166, 0.2042, 36374],
    [750000, 0.23483, 54113],
    [1500000, 0.33693, 130688],
    [3333333, 0.4084, 237893],
    [Infinity, 0.45945, 408061]
  ]
};

function createDefaultSalarySettings() {
  return {
    hoursPerDay: 8,        // 1日の所定労働時間
    overtimeRate: 1.25,    // 残業の割増率
    empInsPermille: 5,     // 雇用保険料率（本人負担・1000分の○）
    dependents: 0          // 扶養人数
  };
}

function createDefaultSalary() {
  return {
    initialized: false,
    settings: createDefaultSalarySettings(),
    months: {},   // 'YYYY-MM'（勤務月）→ 入力データ
    pay: {}       // 'YYYY-MM'（支給月）→ { scheduleId, settled, settledAmount }
  };
}

// ---------- データの検証・整形 ----------
const YM_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function toNonNegInt(v) {
  const n = Math.floor(toNumber(v, 0));
  return n > 0 ? n : 0;
}

function toManual(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeAllowance(a) {
  return {
    id: SAFE_ID.test(String(a.id)) ? String(a.id) : makeId('al_'),
    name: String(a.name ?? ''),
    amount: toNonNegInt(a.amount),
    monthly: a.monthly !== false,
    includeInOvertime: a.includeInOvertime !== false,
    commute: a.commute === true
  };
}

function normalizeMonth(m) {
  if (!m || typeof m !== 'object') return null;
  return {
    workDays: Math.min(toNonNegInt(m.workDays), 31),
    baseSalary: toNonNegInt(m.baseSalary),
    overtimeMinutes: toNonNegInt(m.overtimeMinutes),
    allowances: (Array.isArray(m.allowances) ? m.allowances : [])
      .filter(a => a && typeof a === 'object')
      .map(normalizeAllowance),
    health: toNonNegInt(m.health),
    care: toNonNegInt(m.care),
    pension: toNonNegInt(m.pension),
    residentTax: toNonNegInt(m.residentTax),
    empInsManual: toManual(m.empInsManual),
    incomeTaxManual: toManual(m.incomeTaxManual)
  };
}

function normalizeSalary(raw) {
  const salary = createDefaultSalary();
  if (!raw || typeof raw !== 'object') return salary;

  salary.initialized = raw.initialized === true;

  const s = raw.settings || {};
  const d = salary.settings;
  const hours = Number(s.hoursPerDay);
  if (Number.isFinite(hours) && hours > 0 && hours <= 24) d.hoursPerDay = hours;
  const rate = Number(s.overtimeRate);
  if (Number.isFinite(rate) && rate >= 1 && rate <= 3) d.overtimeRate = rate;
  const emp = Number(s.empInsPermille);
  if (Number.isFinite(emp) && emp >= 0 && emp <= 100) d.empInsPermille = emp;
  d.dependents = Math.min(toNonNegInt(s.dependents), 20);

  if (raw.months && typeof raw.months === 'object') {
    for (const [ym, m] of Object.entries(raw.months)) {
      if (!YM_PATTERN.test(ym)) continue;
      const month = normalizeMonth(m);
      if (month) salary.months[ym] = month;
    }
  }

  if (raw.pay && typeof raw.pay === 'object') {
    for (const [ym, p] of Object.entries(raw.pay)) {
      if (!YM_PATTERN.test(ym) || !p || typeof p !== 'object') continue;
      salary.pay[ym] = {
        scheduleId: SAFE_ID.test(String(p.scheduleId)) ? String(p.scheduleId) : null,
        settled: p.settled === true,
        settledAmount: Math.floor(toNumber(p.settledAmount, 0))
      };
    }
  }
  return salary;
}

// ---------- 日付・祝日 ----------
function ymOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  return ymOf(new Date(y, m - 1 + n, 1));
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function nthMonday(year, month, n) {
  const first = new Date(year, month - 1, 1);
  const offset = (8 - first.getDay()) % 7; // 最初の月曜日までの日数
  return new Date(year, month - 1, 1 + offset + (n - 1) * 7);
}

const holidayCache = new Map();

// 日本の祝日（2020年以降の祝日法に基づく。振替休日・国民の休日を含む）
function getHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);

  const base = new Map();
  const add = (date, name) => base.set(dateKey(date), name);
  const fixed = (m, d, name) => add(new Date(year, m - 1, d), name);

  fixed(1, 1, '元日');
  add(nthMonday(year, 1, 2), '成人の日');
  fixed(2, 11, '建国記念の日');
  fixed(2, 23, '天皇誕生日');
  const shunbun = Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  fixed(3, shunbun, '春分の日');
  fixed(4, 29, '昭和の日');
  fixed(5, 3, '憲法記念日');
  fixed(5, 4, 'みどりの日');
  fixed(5, 5, 'こどもの日');
  add(nthMonday(year, 7, 3), '海の日');
  fixed(8, 11, '山の日');
  add(nthMonday(year, 9, 3), '敬老の日');
  const shubun = Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  fixed(9, shubun, '秋分の日');
  add(nthMonday(year, 10, 2), 'スポーツの日');
  fixed(11, 3, '文化の日');
  fixed(11, 23, '勤労感謝の日');

  const all = new Map(base);

  // 国民の休日：前日と翌日がどちらも祝日の平日
  for (let d = new Date(year, 0, 2); d.getFullYear() === year; d.setDate(d.getDate() + 1)) {
    const key = dateKey(d);
    if (base.has(key) || d.getDay() === 0) continue;
    const prev = new Date(d); prev.setDate(d.getDate() - 1);
    const next = new Date(d); next.setDate(d.getDate() + 1);
    if (base.has(dateKey(prev)) && base.has(dateKey(next))) all.set(key, '国民の休日');
  }

  // 振替休日：祝日が日曜日なら、その後の最初の祝日でない日
  for (const key of base.keys()) {
    const [y, m, dd] = key.split('-').map(Number);
    const d = new Date(y, m - 1, dd);
    if (d.getDay() !== 0) continue;
    const sub = new Date(d);
    do { sub.setDate(sub.getDate() + 1); } while (all.has(dateKey(sub)));
    all.set(dateKey(sub), '振替休日');
  }

  holidayCache.set(year, all);
  return all;
}

function isHoliday(date) {
  return getHolidays(date.getFullYear()).has(dateKey(date));
}

function isBusinessDay(date) {
  const dow = date.getDay();
  return dow !== 0 && dow !== 6 && !isHoliday(date);
}

function countBusinessDays(ym) {
  const [y, m] = ym.split('-').map(Number);
  let count = 0;
  for (let d = new Date(y, m - 1, 1); d.getMonth() === m - 1; d.setDate(d.getDate() + 1)) {
    if (isBusinessDay(d)) count++;
  }
  return count;
}

// 支給日：支給月の25日。土日祝なら直前の平日
function getPayDate(payYM) {
  const [y, m] = payYM.split('-').map(Number);
  const d = new Date(y, m - 1, 25);
  while (!isBusinessDay(d)) d.setDate(d.getDate() - 1);
  return dateKey(d);
}

function formatJpDate(dateStr) {
  if (!dateStr) return '日付未設定';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
  return `${y}年${m}月${d}日（${dow}）`;
}

function formatYen(n) {
  const v = Math.round(toNumber(n, 0));
  return (v < 0 ? '-¥' : '¥') + Math.abs(v).toLocaleString();
}

function formatMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h}時間${m}分` : `${h}時間`;
}

// ---------- 月ごとのデータ ----------
function emptyMonth(ym) {
  return {
    workDays: countBusinessDays(ym),
    baseSalary: 0,
    overtimeMinutes: 0,
    allowances: [],
    health: 0,
    care: 0,
    pension: 0,
    residentTax: 0,
    empInsManual: null,
    incomeTaxManual: null
  };
}

// 保存されていない月は、直前の保存済みの月から引き継いだ内容を作る
function deriveMonth(ym) {
  const month = emptyMonth(ym);
  const prevKey = Object.keys(appState.salary.months).filter(k => k < ym).sort().pop();
  if (!prevKey) return month;

  const prev = appState.salary.months[prevKey];
  month.baseSalary = prev.baseSalary;
  month.allowances = prev.allowances
    .filter(a => a.monthly)
    .map(a => ({ ...a, id: makeId('al_') }));
  month.health = prev.health;
  month.care = prev.care;
  month.pension = prev.pension;
  month.residentTax = prev.residentTax;
  return month;
}

function getMonthView(ym) {
  const stored = appState.salary.months[ym];
  return stored ? { data: stored, stored: true } : { data: deriveMonth(ym), stored: false };
}

function materializeMonth(ym) {
  if (!appState.salary.months[ym]) appState.salary.months[ym] = deriveMonth(ym);
  return appState.salary.months[ym];
}

// ---------- 計算 ----------
function calcEmploymentInsurance(gross, permille) {
  // 本人負担分：50銭以下切り捨て、50銭超は切り上げ
  const rateMicro = Math.round(permille * 1000);
  const v = gross * rateMicro;
  let yen = Math.floor(v / 1000000);
  if (v - yen * 1000000 > 500000) yen++;
  return yen;
}

function calcIncomeTax(taxable, dependents) {
  if (taxable <= 0) return 0;
  const p = INCOME_TAX_PARAMS;
  const [, eRate, eAdd] = p.employmentDeduction.find(([limit]) => taxable <= limit);
  const employmentDeduction = Math.ceil(taxable * eRate + eAdd);
  const base = Math.floor(taxable - employmentDeduction - p.basicDeduction - dependents * p.dependentDeduction);
  if (base <= 0) return 0;
  const [, rate, sub] = p.rates.find(([limit]) => base <= limit);
  const tax = base * rate - sub;
  return tax > 0 ? Math.round(tax / 10) * 10 : 0;
}

function calcSalary(data, settings, opts = {}) {
  const days = data.workDays;
  const dayMinutes = Math.round(settings.hoursPerDay * 60);
  const ratePct = Math.round(settings.overtimeRate * 100);

  const allowanceTotal = data.allowances.reduce((s, a) => s + a.amount, 0);
  const allowanceForOvertime = data.allowances.filter(a => a.includeInOvertime).reduce((s, a) => s + a.amount, 0);
  const commuteTotal = data.allowances.filter(a => a.commute).reduce((s, a) => s + a.amount, 0);

  const overtimeBase = data.baseSalary + allowanceForOvertime;
  const minutes = opts.ignoreOvertime ? 0 : data.overtimeMinutes;
  const canCalcOvertime = days > 0 && dayMinutes > 0;

  // 残業代 ＝ 時給 × 割増率 × 残業時間（1円未満切り捨て）
  // 時給 ＝ (基本給＋対象の手当) ÷ (出勤日数 × 所定労働時間)
  const overtimePay = canCalcOvertime
    ? Math.floor((overtimeBase * ratePct * minutes) / (100 * days * dayMinutes))
    : 0;
  const hourly = canCalcOvertime ? overtimeBase / (days * dayMinutes / 60) : null;

  const gross = data.baseSalary + allowanceTotal + overtimePay;
  const useManual = !opts.ignoreManual;

  const empInsAuto = calcEmploymentInsurance(gross, settings.empInsPermille);
  const empIns = useManual && data.empInsManual !== null ? data.empInsManual : empInsAuto;
  const socialInsurance = data.health + data.care + data.pension + empIns;

  const taxable = gross - commuteTotal - socialInsurance;
  const incomeTaxAuto = calcIncomeTax(taxable, settings.dependents);
  const incomeTax = useManual && data.incomeTaxManual !== null ? data.incomeTaxManual : incomeTaxAuto;

  const deductionTotal = socialInsurance + incomeTax + data.residentTax;

  return {
    canCalcOvertime,
    hourly,
    overtimeBase,
    minutes,
    overtimePay,
    allowanceTotal,
    gross,
    empInsAuto,
    empIns,
    incomeTaxAuto,
    incomeTax,
    deductionTotal,
    takeHome: gross - deductionTotal
  };
}

// ---------- 預金管理との連携 ----------
function getSalaryTabId() {
  const tabs = appState.tabs;
  const byName = tabs.find(t => t.name === '通常');
  if (byName) return byName.id;
  const byId = tabs.find(t => t.id === 'tab_normal');
  return byId ? byId.id : tabs[0].id;
}

function findSchedule(id) {
  return id ? appState.schedules.find(s => s.id === id) : null;
}

// 初めて給与機能が動くときは、今月分の自動追加を見送る（手入力の給料予定と重複しないように）
function ensureSalaryInitialized() {
  const salary = appState.salary;
  if (salary.initialized) return;
  const payYM = ymOf(new Date());
  if (!salary.pay[payYM]) salary.pay[payYM] = { scheduleId: null, settled: false, settledAmount: 0 };
  salary.initialized = true;
}

// 毎月1日以降、今月の給料予定がまだなければ追加する
function autoAddSalarySchedule() {
  const salary = appState.salary;
  const payYM = ymOf(new Date());
  if (salary.pay[payYM]) return null;

  const workYM = addMonths(payYM, -1);
  const { data } = getMonthView(workYM);
  if (data.baseSalary <= 0) return null; // 給与データ未入力なら、入力されるまで待つ

  const amount = calcSalary(data, salary.settings, { ignoreOvertime: true, ignoreManual: true }).takeHome;
  const date = getPayDate(payYM);
  const schedule = { id: makeId('s_'), tabId: getSalaryTabId(), date, title: '給料', amount };
  appState.schedules.push(schedule);
  salary.pay[payYM] = { scheduleId: schedule.id, settled: false, settledAmount: 0 };
  return { date, amount };
}

// 予定が預金金額に自動計上されたとき（script.js から呼ばれる）
function onScheduleSettled(schedule) {
  for (const link of Object.values(appState.salary.pay)) {
    if (link.scheduleId === schedule.id) {
      link.settled = true;
      link.settledAmount = Math.floor(toNumber(schedule.amount, 0));
    }
  }
}

function getPayStatus(workYM) {
  const payYM = addMonths(workYM, 1);
  const link = appState.salary.pay[payYM];
  const schedule = link ? findSchedule(link.scheduleId) : null;
  if (schedule) return { kind: 'scheduled', payYM, schedule };
  if (link && link.settled) return { kind: 'settled', payYM, link };
  return { kind: 'none', payYM, link };
}

function reflectSalary(workYM) {
  const data = materializeMonth(workYM);
  const result = calcSalary(data, appState.salary.settings);
  const amount = result.takeHome;

  if (data.baseSalary <= 0) {
    alert('基本給を入力してから反映してください。');
    return;
  }

  const status = getPayStatus(workYM);
  const payYM = status.payYM;
  let message = '';

  if (status.kind === 'scheduled') {
    const s = status.schedule;
    if (!confirm(`${formatJpDate(s.date)}の給料予定を\n${formatYen(s.amount)} → ${formatYen(amount)}（手取り）に更新します。よろしいですか？`)) return;
    s.amount = amount;
    message = '給料予定を更新しました';
  } else if (status.kind === 'settled') {
    const diff = amount - status.link.settledAmount;
    if (diff === 0) {
      alert(`この月の給料は預金金額に計上済みで、金額も同じです（${formatYen(amount)}）。`);
      return;
    }
    const sign = diff > 0 ? '+' : '-';
    if (!confirm(`${formatJpDate(getPayDate(payYM))}の給料は、すでに預金金額に計上済みです（${formatYen(status.link.settledAmount)}）。\n差額 ${sign}¥${Math.abs(diff).toLocaleString()} を預金金額に反映します。よろしいですか？`)) return;
    takeForcedSnapshot('給与反映前');
    appState.depositBalance = toNumber(appState.depositBalance, 0) + diff;
    status.link.settledAmount = amount;
    message = '差額を預金金額に反映しました';
  } else {
    const date = getPayDate(payYM);
    if (!confirm(`${formatJpDate(date)}に、給料 ${formatYen(amount)}（手取り）の予定を作成します。よろしいですか？`)) return;
    const schedule = { id: makeId('s_'), tabId: getSalaryTabId(), date, title: '給料', amount };
    appState.schedules.push(schedule);
    appState.salary.pay[payYM] = { scheduleId: schedule.id, settled: false, settledAmount: 0 };
    message = '給料予定を作成しました';
  }

  // 支給日がすでに過ぎていれば、そのまま預金金額に計上される
  const settled = settlePastSchedules();
  saveData();
  renderSalaryPage();
  showToast(message);
  if (settled) setTimeout(() => notifySettlement(settled), 2600);
}

// =====================================================
// 画面
// =====================================================
let salaryViewYM = ymOf(new Date());

function showView() {
  const isSalary = location.hash === '#salary';
  document.getElementById('depositView').hidden = isSalary;
  document.getElementById('salaryView').hidden = !isSalary;
  if (isSalary) {
    renderSalaryPage();
  } else {
    renderAll();
  }
  window.scrollTo(0, 0);
}

function openSalaryPage() {
  history.pushState({ view: 'salary' }, '', '#salary');
  showView();
}

function backToDeposit() {
  if (history.state && history.state.view === 'salary') {
    history.back(); // popstate で画面が切り替わる
  } else {
    history.replaceState(null, '', location.pathname + location.search);
    showView();
  }
}

function switchCheckbox(field, checked, label, allowId) {
  return `
    <label class="switch">
      <input type="checkbox" data-allow-id="${allowId}" data-allow-field="${field}" ${checked ? 'checked' : ''}>
      <span class="switch-track" aria-hidden="true"></span>
      <span class="switch-label">${label}</span>
    </label>`;
}

function renderAllowanceList(data) {
  if (data.allowances.length === 0) {
    return '<p class="salary-empty">手当はありません。「＋ 手当を追加」から登録できます。</p>';
  }
  return data.allowances.map(a => `
    <div class="allowance-item">
      <div class="allowance-row">
        <input type="text" class="allowance-name" placeholder="手当の名前" value="${escapeHtml(a.name)}" data-allow-id="${a.id}" data-allow-field="name" aria-label="手当の名前">
        <div class="yen-input">
          <span>¥</span>
          <input type="number" inputmode="numeric" min="0" value="${a.amount || ''}" placeholder="0" data-allow-id="${a.id}" data-allow-field="amount" aria-label="手当の金額">
        </div>
        <button type="button" class="btn-action" data-action="delete-allowance" data-allow-id="${a.id}">削除</button>
      </div>
      <div class="allowance-switches">
        ${switchCheckbox('monthly', a.monthly, '毎月', a.id)}
        ${switchCheckbox('includeInOvertime', a.includeInOvertime, '残業代の計算に含める', a.id)}
        ${switchCheckbox('commute', a.commute, '通勤手当（非課税）', a.id)}
      </div>
    </div>`).join('');
}

function yenField(field, label, value, note = '') {
  return `
    <label class="salary-field">
      <span class="salary-field-label">${label}${note ? `<small>${note}</small>` : ''}</span>
      <span class="yen-input">
        <span>¥</span>
        <input type="number" inputmode="numeric" min="0" value="${value || ''}" placeholder="0" data-field="${field}">
      </span>
    </label>`;
}

function renderSalaryPage() {
  const body = document.getElementById('salaryBody');
  if (!body) return;

  const ym = salaryViewYM;
  const [y, m] = ym.split('-').map(Number);
  const payYM = addMonths(ym, 1);
  const { data, stored } = getMonthView(ym);
  const settings = appState.salary.settings;
  const businessDays = countBusinessDays(ym);

  document.getElementById('salaryMonthLabel').textContent = `${y}年${m}月分`;
  document.getElementById('salaryPayDate').textContent = `支給日：${formatJpDate(getPayDate(payYM))}`;

  body.innerHTML = `
    <p class="salary-carry-note" id="salaryCarryNote" ${stored ? 'hidden' : ''}>
      この月はまだ入力されていません。前の月の基本給・毎月の手当・控除を引き継いで表示しています。
    </p>

    <div class="salary-layout">
      <div class="salary-inputs">
        <section class="panel salary-card">
          <h2 class="panel-title">勤務と基本給</h2>
          <label class="salary-field">
            <span class="salary-field-label">出勤日数<small>この月の平日：${businessDays}日（土日祝を除く）</small></span>
            <span class="unit-input">
              <input type="number" inputmode="numeric" min="0" max="31" value="${data.workDays || ''}" placeholder="0" data-field="workDays">
              <span>日</span>
            </span>
          </label>
          ${yenField('baseSalary', '基本給', data.baseSalary)}
          <div class="salary-field">
            <span class="salary-field-label">残業時間</span>
            <span class="time-input">
              <input type="number" inputmode="numeric" min="0" value="${Math.floor(data.overtimeMinutes / 60) || ''}" placeholder="0" data-field="otHours" aria-label="残業時間（時間）">
              <span>時間</span>
              <input type="number" inputmode="numeric" min="0" max="59" value="${data.overtimeMinutes % 60 || ''}" placeholder="0" data-field="otMinutes" aria-label="残業時間（分）">
              <span>分</span>
            </span>
          </div>
          <p class="salary-calc-detail" id="overtimeDetail"></p>
        </section>

        <section class="panel salary-card">
          <h2 class="panel-title">手当</h2>
          <div class="allowance-list">${renderAllowanceList(data)}</div>
          <button type="button" class="salary-add-btn" data-action="add-allowance">＋ 手当を追加</button>
          <p class="salary-note">「毎月」がオンの手当は、翌月以降にも自動で引き継がれます。</p>
        </section>

        <section class="panel salary-card">
          <h2 class="panel-title">控除</h2>
          <p class="salary-note">給与明細の金額を入力してください。翌月にも引き継がれます。</p>
          ${yenField('health', '健康保険料', data.health)}
          ${yenField('care', '介護保険料', data.care, '40〜64歳のみ')}
          ${yenField('pension', '厚生年金保険料', data.pension)}
          ${yenField('residentTax', '住民税', data.residentTax)}
          <p class="salary-note salary-note-split">次の2つは自動で計算します。給与明細と金額が違う場合は、明細の金額を入力すると優先されます（空欄に戻すと自動計算）。</p>
          <label class="salary-field">
            <span class="salary-field-label">雇用保険料</span>
            <span class="yen-input">
              <span>¥</span>
              <input type="number" inputmode="numeric" min="0" value="${data.empInsManual ?? ''}" data-field="empInsManual" id="empInsInput">
            </span>
          </label>
          <label class="salary-field">
            <span class="salary-field-label">所得税</span>
            <span class="yen-input">
              <span>¥</span>
              <input type="number" inputmode="numeric" min="0" value="${data.incomeTaxManual ?? ''}" data-field="incomeTaxManual" id="incomeTaxInput">
            </span>
          </label>
        </section>
      </div>

      <div class="salary-side">
        <section class="panel salary-card salary-result">
          <h2 class="panel-title">計算結果</h2>
          <dl class="result-list">
            <dt>残業代</dt><dd id="resOvertime"></dd>
            <dt>給与総額</dt><dd id="resGross" class="result-strong"></dd>
            <dt>控除合計</dt><dd id="resDeduction" class="amount-minus"></dd>
          </dl>
          <div class="take-home">
            <span>手取り</span>
            <span id="resTakeHome"></span>
          </div>
          <div class="reflect-box">
            <p class="reflect-status" id="reflectStatus"></p>
            <button type="button" class="btn-modal btn-confirm reflect-btn" data-action="reflect">預金管理に反映</button>
          </div>
        </section>

        <details class="panel salary-card salary-settings">
          <summary>計算の設定</summary>
          <label class="salary-field">
            <span class="salary-field-label">1日の所定労働時間</span>
            <span class="unit-input">
              <input type="number" inputmode="decimal" min="1" max="24" step="0.25" value="${settings.hoursPerDay}" data-setting="hoursPerDay">
              <span>時間</span>
            </span>
          </label>
          <label class="salary-field">
            <span class="salary-field-label">残業の割増率</span>
            <span class="unit-input">
              <input type="number" inputmode="decimal" min="1" max="3" step="0.01" value="${settings.overtimeRate}" data-setting="overtimeRate">
              <span>倍</span>
            </span>
          </label>
          <label class="salary-field">
            <span class="salary-field-label">雇用保険料率（本人負担）<small>1000分の○で入力</small></span>
            <span class="unit-input">
              <input type="number" inputmode="decimal" min="0" max="100" step="0.5" value="${settings.empInsPermille}" data-setting="empInsPermille">
              <span>/1000</span>
            </span>
          </label>
          <label class="salary-field">
            <span class="salary-field-label">扶養人数</span>
            <span class="unit-input">
              <input type="number" inputmode="numeric" min="0" max="20" value="${settings.dependents}" data-setting="dependents">
              <span>人</span>
            </span>
          </label>
          <p class="salary-note">設定はすべての月に共通です。所得税は国税庁の計算方法に沿った概算です。</p>
        </details>
      </div>
    </div>
  `;

  renderSalaryResults();
}

// 入力中にフォーカスが外れないよう、結果部分だけを書き換える
function renderSalaryResults() {
  const ym = salaryViewYM;
  const { data } = getMonthView(ym);
  const r = calcSalary(data, appState.salary.settings);
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };

  set('resOvertime', formatYen(r.overtimePay));
  set('resGross', formatYen(r.gross));
  set('resDeduction', formatYen(-r.deductionTotal));
  set('resTakeHome', formatYen(r.takeHome));

  const detail = document.getElementById('overtimeDetail');
  if (detail) {
    detail.textContent = r.canCalcOvertime
      ? `時給 ${r.hourly.toLocaleString(undefined, { maximumFractionDigits: 2 })}円 × ${appState.salary.settings.overtimeRate} × ${formatMinutes(r.minutes)} ＝ ${formatYen(r.overtimePay)}（1円未満切り捨て）`
      : '出勤日数を入力すると残業代を計算します。';
  }

  const empIns = document.getElementById('empInsInput');
  if (empIns) empIns.placeholder = `自動：${r.empInsAuto.toLocaleString()}`;
  const tax = document.getElementById('incomeTaxInput');
  if (tax) tax.placeholder = `自動：${r.incomeTaxAuto.toLocaleString()}`;

  const statusEl = document.getElementById('reflectStatus');
  if (statusEl) {
    const st = getPayStatus(ym);
    const payDate = formatJpDate(getPayDate(st.payYM));
    if (st.kind === 'scheduled') {
      const same = st.schedule.amount === r.takeHome;
      statusEl.textContent = `${formatJpDate(st.schedule.date)}の給料予定：${formatYen(st.schedule.amount)}${same ? '（反映済み）' : ''}`;
    } else if (st.kind === 'settled') {
      const same = st.link.settledAmount === r.takeHome;
      statusEl.textContent = `${payDate}の給料は預金金額に計上済み：${formatYen(st.link.settledAmount)}${same ? '（反映済み）' : ''}`;
    } else if (!st.link && st.payYM > ymOf(new Date())) {
      const [py, pm] = st.payYM.split('-').map(Number);
      statusEl.textContent = `${py}年${pm}月1日に給料予定が自動で追加されます。今すぐ追加する場合は反映ボタンを押してください。`;
    } else {
      statusEl.textContent = `${payDate}の給料予定はありません。反映ボタンで作成できます。`;
    }
  }
}

// ---------- 入力の処理 ----------
function parseIntInput(v) {
  const n = Math.floor(Number(String(v).replace(/[,，\s]/g, '')));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function handleSalaryInput(e) {
  const t = e.target;

  if (t.dataset.setting) {
    const key = t.dataset.setting;
    const v = Number(t.value);
    const s = appState.salary.settings;
    if (key === 'hoursPerDay' && v > 0 && v <= 24) s.hoursPerDay = v;
    if (key === 'overtimeRate' && v >= 1 && v <= 3) s.overtimeRate = v;
    if (key === 'empInsPermille' && v >= 0 && v <= 100) s.empInsPermille = v;
    if (key === 'dependents') s.dependents = Math.min(parseIntInput(t.value), 20);
    saveData();
    renderSalaryResults();
    return;
  }

  const ym = salaryViewYM;
  const field = t.dataset.field;
  const allowId = t.dataset.allowId;
  if (!field && !allowId) return;

  const data = materializeMonth(ym);
  const note = document.getElementById('salaryCarryNote');
  if (note) note.hidden = true;

  if (allowId) {
    const a = data.allowances.find(x => x.id === allowId);
    if (!a) return;
    const f = t.dataset.allowField;
    if (f === 'name') a.name = t.value;
    else if (f === 'amount') a.amount = parseIntInput(t.value);
    else if (t.type === 'checkbox') a[f] = t.checked;
  } else if (field === 'otHours' || field === 'otMinutes') {
    const body = document.getElementById('salaryBody');
    const h = parseIntInput(body.querySelector('[data-field="otHours"]').value);
    const mi = Math.min(parseIntInput(body.querySelector('[data-field="otMinutes"]').value), 59);
    data.overtimeMinutes = h * 60 + mi;
  } else if (field === 'empInsManual' || field === 'incomeTaxManual') {
    data[field] = t.value === '' ? null : parseIntInput(t.value);
  } else if (field === 'workDays') {
    data.workDays = Math.min(parseIntInput(t.value), 31);
  } else {
    data[field] = parseIntInput(t.value);
  }

  saveData();
  renderSalaryResults();
}

function handleSalaryClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const ym = salaryViewYM;

  if (action === 'add-allowance') {
    const data = materializeMonth(ym);
    data.allowances.push(normalizeAllowance({ id: makeId('al_'), name: '', amount: 0 }));
    saveData();
    renderSalaryPage();
    const inputs = document.querySelectorAll('.allowance-name');
    if (inputs.length) inputs[inputs.length - 1].focus();
  } else if (action === 'delete-allowance') {
    const data = materializeMonth(ym);
    const a = data.allowances.find(x => x.id === btn.dataset.allowId);
    if (a && (a.name || a.amount) && !confirm(`手当「${a.name || '名前なし'}」を削除しますか？`)) return;
    data.allowances = data.allowances.filter(x => x.id !== btn.dataset.allowId);
    saveData();
    renderSalaryPage();
  } else if (action === 'reflect') {
    reflectSalary(ym);
  }
}

function initSalaryPage() {
  document.getElementById('openSalaryBtn').addEventListener('click', openSalaryPage);
  document.getElementById('backToDepositBtn').addEventListener('click', backToDeposit);
  document.getElementById('salaryPrevBtn').addEventListener('click', () => {
    salaryViewYM = addMonths(salaryViewYM, -1);
    renderSalaryPage();
  });
  document.getElementById('salaryNextBtn').addEventListener('click', () => {
    salaryViewYM = addMonths(salaryViewYM, 1);
    renderSalaryPage();
  });
  document.getElementById('salaryThisMonthBtn').addEventListener('click', () => {
    salaryViewYM = ymOf(new Date());
    renderSalaryPage();
  });

  const body = document.getElementById('salaryBody');
  body.addEventListener('input', e => { if (e.target.type !== 'checkbox') handleSalaryInput(e); });
  body.addEventListener('change', e => { if (e.target.type === 'checkbox') handleSalaryInput(e); });
  body.addEventListener('click', handleSalaryClick);

  window.addEventListener('popstate', showView);
  if (location.hash === '#salary') showView();
}
