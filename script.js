// =====================================================
// データ保存まわりの設定
// =====================================================
// キー名はアプリ固有の名前にする（同じ github.io の別アプリと衝突しないように）
const STORAGE_KEY = 'deposit_sim_app__data_v1';
const BACKUP_KEY = 'deposit_sim_app__backups_v1';   // 自動バックアップ（日ごとのスナップショット）
const META_KEY = 'deposit_sim_app__meta_v1';        // 最終書き出し日時など
const LEGACY_KEY = 'acc_sim_data';                   // 旧バージョンのキー（移行元。削除はしない）
const MAX_BACKUPS = 7;                               // 自動バックアップの保持世代数
const EXPORT_REMIND_DAYS = 7;                        // ファイル書き出しを促すまでの日数
const EXPORT_FORMAT = 'deposit-sim-backup';

function createDefaultState() {
  return {
    depositBalance: 0,
    lastProcessDate: '',
    tabs: [
      { id: 'tab_normal', name: '通常' },
      { id: 'tab_furima', name: 'フリマ' }
    ],
    activeTabId: 'tab_normal',
    schedules: [],
    memos: [],
    salary: createDefaultSalary()
  };
}

let appState = createDefaultState();

let currentPromoteMemoId = null;
let currentEditTabId = null;

// 読み込み時の状態（画面上のお知らせ表示に使う）
let loadStatus = {
  source: 'none',        // 'main' | 'legacy' | 'backup' | 'none'
  corruptSaved: false,   // 壊れたデータを退避したか
  saveError: false       // 保存に失敗したか
};

// =====================================================
// ストレージの低レベル操作（例外で落ちないようにする）
// =====================================================
function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    console.error('localStorage read error:', e);
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.error('localStorage write error:', e);
    return false;
  }
}

function readJson(key, fallback) {
  const raw = safeGet(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function getMeta() {
  const meta = readJson(META_KEY, {});
  return (meta && typeof meta === 'object') ? meta : {};
}

function setMeta(patch) {
  safeSet(META_KEY, JSON.stringify({ ...getMeta(), ...patch }));
}

// =====================================================
// データの検証・整形
// =====================================================
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function makeId(prefix) {
  return prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// 読み込んだデータを安全な形に整える。データとして使えなければ null を返す
function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Array.isArray(raw.schedules) && !Array.isArray(raw.memos) && !Array.isArray(raw.tabs)) {
    return null;
  }

  const state = createDefaultState();

  state.depositBalance = toNumber(
    raw.depositBalance !== undefined ? raw.depositBalance : raw.totalBalance,
    0
  );
  state.lastProcessDate = typeof raw.lastProcessDate === 'string' ? raw.lastProcessDate : '';

  if (Array.isArray(raw.tabs)) {
    const tabs = raw.tabs
      .filter(t => t && typeof t === 'object')
      .map(t => ({
        id: SAFE_ID.test(String(t.id)) ? String(t.id) : makeId('tab_'),
        name: String(t.name ?? '').trim() || 'タブ'
      }));
    if (tabs.length > 0) state.tabs = tabs;
  }

  const tabIds = new Set(state.tabs.map(t => t.id));

  state.schedules = (Array.isArray(raw.schedules) ? raw.schedules : [])
    .filter(s => s && typeof s === 'object')
    .map(s => ({
      id: SAFE_ID.test(String(s.id)) ? String(s.id) : makeId('s_'),
      tabId: tabIds.has(String(s.tabId)) ? String(s.tabId) : state.tabs[0].id,
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(s.date)) ? String(s.date) : '',
      title: String(s.title ?? ''),
      amount: toNumber(s.amount, 0)
    }));

  state.memos = (Array.isArray(raw.memos) ? raw.memos : [])
    .filter(m => m && typeof m === 'object')
    .map(m => ({
      id: SAFE_ID.test(String(m.id)) ? String(m.id) : makeId('m_'),
      title: String(m.title ?? ''),
      amount: toNumber(m.amount, 0)
    }));

  state.activeTabId = tabIds.has(String(raw.activeTabId)) ? String(raw.activeTabId) : state.tabs[0].id;

  state.salary = normalizeSalary(raw.salary);

  return state;
}

function hasUserData(state) {
  return state.schedules.length > 0 || state.memos.length > 0 || state.depositBalance !== 0 ||
    (state.salary && Object.keys(state.salary.months).length > 0);
}

// =====================================================
// 自動バックアップ（端末内に日ごとのスナップショットを保持）
// =====================================================
function getBackups() {
  const list = readJson(BACKUP_KEY, []);
  return Array.isArray(list) ? list.filter(b => b && b.data) : [];
}

// その日最初の保存時に、保存前のデータをスナップショットとして残す
function takeDailySnapshot(stateToKeep) {
  if (!hasUserData(stateToKeep)) return;
  const today = getTodayString();
  const backups = getBackups();
  if (backups.length > 0 && backups[0].day === today) return;

  backups.unshift({ day: today, savedAt: new Date().toISOString(), data: stateToKeep });
  while (backups.length > MAX_BACKUPS) backups.pop();

  if (!safeSet(BACKUP_KEY, JSON.stringify(backups))) {
    // 容量不足の場合は世代を減らして再試行
    safeSet(BACKUP_KEY, JSON.stringify(backups.slice(0, 2)));
  }
}

// インポートや復元の直前など、日付に関係なく今の状態を残しておく
function takeForcedSnapshot(label) {
  if (!hasUserData(appState)) return;
  const backups = getBackups();
  backups.unshift({
    day: getTodayString(),
    savedAt: new Date().toISOString(),
    label,
    data: JSON.parse(JSON.stringify(appState))
  });
  while (backups.length > MAX_BACKUPS) backups.pop();
  safeSet(BACKUP_KEY, JSON.stringify(backups));
}

// =====================================================
// 読み込み・保存
// =====================================================
function loadData() {
  const rawMain = safeGet(STORAGE_KEY);
  let loaded = null;

  // 1. 通常の保存データ
  if (rawMain) {
    try {
      loaded = normalizeState(JSON.parse(rawMain));
    } catch (e) {
      console.error('Data parse error:', e);
    }
    if (loaded) {
      loadStatus.source = 'main';
    } else {
      // 壊れたデータは上書きせず、別キーに退避しておく
      safeSet(STORAGE_KEY + '__corrupt_' + Date.now(), rawMain);
      loadStatus.corruptSaved = true;
    }
  }

  // 2. 旧バージョンのキーから移行
  if (!loaded) {
    const rawLegacy = safeGet(LEGACY_KEY);
    if (rawLegacy) {
      try {
        loaded = normalizeState(JSON.parse(rawLegacy));
      } catch (e) {
        console.error('Legacy data parse error:', e);
      }
      if (loaded) loadStatus.source = 'legacy';
    }
  }

  // 3. 自動バックアップから復旧
  if (!loaded) {
    for (const b of getBackups()) {
      const s = normalizeState(b.data);
      if (s) {
        loaded = s;
        loadStatus.source = 'backup';
        break;
      }
    }
  }

  if (loaded) {
    appState = loaded;
  } else {
    appState = createDefaultState();
    loadStatus.source = 'none';
  }

  pendingSettlement = processDailyTransition();
}

let pendingSettlement = null;

function saveData() {
  // 保存前の内容を（その日初回のみ）自動バックアップに残す
  const previous = normalizeState(readJson(STORAGE_KEY, null));
  if (previous) takeDailySnapshot(previous);

  const ok = safeSet(STORAGE_KEY, JSON.stringify(appState));
  if (ok && loadStatus.source === 'none') loadStatus.source = 'main';
  if (ok !== !loadStatus.saveError) {
    loadStatus.saveError = !ok;
    renderNotice();
  }
  return ok;
}

function getTodayString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// --- 日次自動更新ロジック ---
// 日付が過ぎた予定（今日より前の日付）をリストから外し、金額を預金金額に計上する。
// 日付が未入力の予定と、今日の予定はそのまま残す。
function settlePastSchedules() {
  const todayStr = getTodayString();
  const past = appState.schedules.filter(s => s.date && s.date < todayStr);
  if (past.length === 0) return null;

  // 計上前の状態を自動バックアップに残す（データ管理画面から戻せるように）
  takeForcedSnapshot('自動計上前');

  past.forEach(onScheduleSettled); // 給与計算の予定なら「計上済み」として記録
  const total = past.reduce((sum, s) => sum + toNumber(s.amount, 0), 0);
  const pastIds = new Set(past.map(s => s.id));
  appState.depositBalance = toNumber(appState.depositBalance, 0) + total;
  appState.schedules = appState.schedules.filter(s => !pastIds.has(s.id));

  return { count: past.length, total };
}

// result：settlePastSchedules() の戻り値、または processDailyTransition() の戻り値
function notifySettlement(result) {
  if (!result) return;
  const settlement = result.salaryAdded !== undefined ? result.settlement : result;
  const messages = [];
  if (result.salaryAdded) {
    const a = result.salaryAdded;
    messages.push(`${formatJpDate(a.date)}の給料（${formatYen(a.amount)}）を予定に追加しました`);
  }
  if (settlement) {
    const sign = settlement.total >= 0 ? '+' : '-';
    messages.push(`過ぎた予定 ${settlement.count}件を預金金額に計上しました（${sign}¥${Math.abs(settlement.total).toLocaleString()}）`);
  }
  messages.forEach((msg, i) => setTimeout(() => showToast(msg), i * 2600));
}

function processDailyTransition() {
  const todayStr = getTodayString();
  const dateChanged = appState.lastProcessDate !== todayStr;
  appState.lastProcessDate = todayStr;
  ensureSalaryInitialized();
  // 何も見つからなかった状態では空データを保存しない（後から復元できる余地を残す）
  if (loadStatus.source === 'none') return null;

  // 毎月1日以降：今月の給料予定を追加 → 過ぎた予定を計上
  const salaryAdded = autoAddSalarySchedule();
  const settlement = settlePastSchedules();

  // 旧キーや自動バックアップから読み込んだ場合は、すぐに新しいキーへ保存する
  if (salaryAdded || settlement || dateChanged || loadStatus.source === 'legacy' || loadStatus.source === 'backup') {
    saveData();
  }
  return (salaryAdded || settlement) ? { salaryAdded, settlement } : null;
}

// アプリを開いたまま日付をまたいだ場合も計上する
let lastCheckedDay = getTodayString();
function checkDayChange() {
  const todayStr = getTodayString();
  if (todayStr === lastCheckedDay) return;
  lastCheckedDay = todayStr;
  const result = processDailyTransition();
  if (location.hash === '#salary') renderSalaryPage(); else renderAll();
  notifySettlement(result);
}

// =====================================================
// 案A：永続ストレージの要求
// =====================================================
let persistState = 'unknown'; // 'granted' | 'denied' | 'unsupported' | 'unknown'

async function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) {
    persistState = 'unsupported';
    return;
  }
  try {
    let granted = await navigator.storage.persisted();
    if (!granted) granted = await navigator.storage.persist();
    persistState = granted ? 'granted' : 'denied';
  } catch (e) {
    console.error('persist error:', e);
    persistState = 'denied';
  }
  renderDataModalStatus();
}

// =====================================================
// 案B：ファイルへの書き出し・読み込み
// =====================================================
function buildExportPayload() {
  return {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    data: appState
  };
}

function buildExportFileName() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `kakeibo-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

function markExported() {
  setMeta({ lastExportAt: new Date().toISOString() });
  renderNotice();
  renderDataModalStatus();
}

function exportToFile() {
  const json = JSON.stringify(buildExportPayload(), null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = buildExportFileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  markExported();
  showToast('バックアップファイルを書き出しました');
}

function canShareFile() {
  try {
    const f = new File(['{}'], 'test.json', { type: 'application/json' });
    return !!(navigator.canShare && navigator.canShare({ files: [f] }));
  } catch (e) {
    return false;
  }
}

async function shareBackupFile() {
  const json = JSON.stringify(buildExportPayload(), null, 2);
  const file = new File([json], buildExportFileName(), { type: 'application/json' });
  try {
    await navigator.share({ files: [file], title: '家計簿バックアップ' });
    markExported();
    showToast('バックアップを共有しました');
  } catch (e) {
    if (e && e.name === 'AbortError') return; // ユーザーがキャンセル
    console.error('share error:', e);
    alert('共有できませんでした。「ファイルに書き出す」を使ってください。');
  }
}

function importFromFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch (e) {
      alert('ファイルを読み込めませんでした。バックアップ用のJSONファイルを選んでください。');
      return;
    }
    const rawState = (parsed && parsed.format === EXPORT_FORMAT) ? parsed.data : parsed;
    const state = normalizeState(rawState);
    if (!state) {
      alert('このファイルには家計簿のデータが含まれていません。');
      return;
    }

    const when = parsed && parsed.exportedAt ? formatDateTime(parsed.exportedAt) : '不明';
    const ok = confirm(
      `バックアップ（書き出し日時：${when}）\n予定 ${state.schedules.length}件・メモ ${state.memos.length}件\n\n現在のデータをこの内容に置き換えます。よろしいですか？\n※現在のデータは自動バックアップに残ります。`
    );
    if (!ok) return;

    takeForcedSnapshot('復元前');
    appState = state;
    loadStatus.source = 'main';
    const settled = settlePastSchedules();
    saveData();
    renderAll();
    closeDataModal();
    showToast('バックアップから復元しました');
    if (settled) setTimeout(() => notifySettlement(settled), 2600);
  };
  reader.onerror = () => alert('ファイルを読み込めませんでした。');
  reader.readAsText(file);
}

function restoreFromBackup(index) {
  const b = getBackups()[index];
  const state = b ? normalizeState(b.data) : null;
  if (!state) {
    alert('このバックアップは読み込めませんでした。');
    return;
  }
  const ok = confirm(
    `${formatDateTime(b.savedAt)} のデータ（予定 ${state.schedules.length}件・メモ ${state.memos.length}件）に戻します。よろしいですか？\n※現在のデータは自動バックアップに残ります。`
  );
  if (!ok) return;

  takeForcedSnapshot('復元前');
  appState = state;
  loadStatus.source = 'main';
  const settled = settlePastSchedules();
  saveData();
  renderAll();
  closeDataModal();
  showToast('自動バックアップから復元しました');
  if (settled) setTimeout(() => notifySettlement(settled), 2600);
}

// =====================================================
// お知らせ・データ管理画面の表示
// =====================================================
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '不明';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function daysSince(iso) {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return Infinity;
  return Math.floor((Date.now() - t) / 86400000);
}

function renderNotice() {
  const el = document.getElementById('dataNotice');
  if (!el) return;

  let message = '';
  let level = 'info';

  if (loadStatus.saveError) {
    level = 'error';
    message = 'データを端末に保存できませんでした。念のため、今すぐバックアップを書き出してください。';
  } else if (loadStatus.corruptSaved && loadStatus.source !== 'main') {
    level = 'error';
    message = loadStatus.source === 'backup'
      ? '保存データが壊れていたため、自動バックアップから復旧しました。内容を確認してください。'
      : '保存データが壊れていたため読み込めませんでした。バックアップファイルがあれば復元できます。';
  } else if (loadStatus.source === 'backup') {
    level = 'warn';
    message = '保存データが見つからなかったため、端末内の自動バックアップから復旧しました。内容を確認してください。';
  } else if (loadStatus.source === 'none' && !hasUserData(appState)) {
    level = 'warn';
    message = '保存データが見つかりませんでした。バックアップファイルがあれば「データ管理」から復元できます。';
  } else if (hasUserData(appState)) {
    const last = getMeta().lastExportAt;
    if (!last) {
      message = 'まだバックアップファイルを書き出していません。データが消えたときに備えて書き出しておきましょう。';
    } else if (daysSince(last) >= EXPORT_REMIND_DAYS) {
      message = `最後のバックアップから${daysSince(last)}日経っています。新しいバックアップを書き出しましょう。`;
    }
  }

  if (!message) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }

  el.hidden = false;
  el.className = `data-notice data-notice--${level}`;
  el.innerHTML = `
    <span class="data-notice-text">${escapeHtml(message)}</span>
    <button type="button" class="btn-modal btn-confirm data-notice-btn" onclick="openDataModal()">データ管理を開く</button>
  `;
}

function renderDataModalStatus() {
  const persistEl = document.getElementById('persistStatus');
  if (persistEl) {
    const labels = {
      granted: '有効（ブラウザによる自動削除の対象外）',
      denied: '未許可（端末の容量が少ないと削除される可能性があります）',
      unsupported: 'このブラウザでは利用できません',
      unknown: '確認中…'
    };
    persistEl.textContent = labels[persistState];
    persistEl.className = `status-value ${persistState === 'granted' ? 'amount-plus' : (persistState === 'denied' ? 'amount-minus' : '')}`;
  }

  const exportEl = document.getElementById('lastExportStatus');
  if (exportEl) {
    const last = getMeta().lastExportAt;
    exportEl.textContent = last ? formatDateTime(last) : 'まだ書き出していません';
  }

  const shareBtn = document.getElementById('shareBackupBtn');
  if (shareBtn) shareBtn.hidden = !canShareFile();

  const listEl = document.getElementById('backupList');
  if (listEl) {
    const backups = getBackups();
    if (backups.length === 0) {
      listEl.innerHTML = '<li class="backup-empty">まだ自動バックアップはありません</li>';
    } else {
      listEl.innerHTML = backups.map((b, i) => {
        const s = normalizeState(b.data);
        const detail = s ? `予定 ${s.schedules.length}件・メモ ${s.memos.length}件` : '読み込み不可';
        const label = b.label ? `（${escapeHtml(b.label)}）` : '';
        return `
          <li class="backup-item">
            <div>
              <div class="backup-date">${escapeHtml(formatDateTime(b.savedAt))}${label}</div>
              <div class="backup-detail">${detail}</div>
            </div>
            <button type="button" class="btn-action btn-promote" onclick="restoreFromBackup(${i})" ${s ? '' : 'disabled'}>この時点に戻す</button>
          </li>`;
      }).join('');
    }
  }
}

window.openDataModal = () => {
  renderDataModalStatus();
  document.getElementById('dataModal').classList.add('active');
};

function closeDataModal() {
  document.getElementById('dataModal').classList.remove('active');
}

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

window.restoreFromBackup = restoreFromBackup;

// --- UI描画処理 ---
function renderAll() {
  renderNotice();
  renderHeader();
  renderTabs();
  renderScheduleTable();
  renderMemoTable();
}

function renderHeader() {
  const totalScheduleAmount = appState.schedules.reduce((sum, s) => sum + (s.amount || 0), 0);
  const totalMemoAmount = appState.memos.reduce((sum, m) => sum + (m.amount || 0), 0);
  
  const totalAssets = appState.depositBalance + totalScheduleAmount + totalMemoAmount;

  document.getElementById('totalAssetsDisplay').textContent = `¥${totalAssets.toLocaleString()}`;

  const depositInput = document.getElementById('depositBalanceInput');
  if (depositInput && document.activeElement !== depositInput) {
    depositInput.value = appState.depositBalance.toLocaleString();
  }

  const todayStr = getTodayString();
  const todaySchedules = appState.schedules.filter(s => s.date === todayStr);

  const listEl = document.getElementById('todayTransactionsList');
  listEl.innerHTML = '';
  if (todaySchedules.length === 0) {
    listEl.innerHTML = `<li style="color: var(--text-muted);">本日の予定取引はありません</li>`;
  } else {
    todaySchedules.forEach(item => {
      const li = document.createElement('li');
      const sign = item.amount >= 0 ? '+' : '';
      const colorClass = item.amount >= 0 ? 'amount-plus' : 'amount-minus';
      li.innerHTML = `${escapeHtml(item.title)} (<span class="${colorClass}">${sign}¥${item.amount.toLocaleString()}</span>)`;
      listEl.appendChild(li);
    });
  }
}

function renderTabs() {
  const header = document.getElementById('tabsHeader');
  header.innerHTML = '';

  appState.tabs.forEach((tab, index) => {
    const tabEl = document.createElement('div');
    tabEl.className = `tab-item ${tab.id === appState.activeTabId ? 'active' : ''}`;
    tabEl.textContent = tab.name;
    tabEl.draggable = true;
    tabEl.dataset.index = index;

    tabEl.addEventListener('click', () => {
      appState.activeTabId = tab.id;
      saveData();
      renderAll();
    });

    tabEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      openTabEditModal(tab.id);
    });

    tabEl.addEventListener('dragstart', handleDragStart);
    tabEl.addEventListener('dragover', handleDragOver);
    tabEl.addEventListener('drop', handleDrop);

    header.appendChild(tabEl);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'add-tab-btn';
  addBtn.textContent = '＋';
  addBtn.title = 'タブを追加';
  addBtn.onclick = addNewTab;
  header.appendChild(addBtn);
}

function renderScheduleTable() {
  const tbody = document.getElementById('scheduleTableBody');
  tbody.innerHTML = '';

  const activeSchedules = appState.schedules
    .filter(s => s.tabId === appState.activeTabId)
    .sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date > b.date ? 1 : -1;
    });

  const tabTotal = activeSchedules.reduce((sum, s) => sum + (s.amount || 0), 0);
  const tabTotalEl = document.getElementById('tabTotalDisplay');
  const sign = tabTotal >= 0 ? '+' : '';
  tabTotalEl.textContent = `${sign}¥${tabTotal.toLocaleString()}`;
  tabTotalEl.className = tabTotal >= 0 ? 'amount-plus' : 'amount-minus';

  const allSortedSchedules = [...appState.schedules].sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date > b.date ? 1 : -1;
  });

  let runningBalance = appState.depositBalance;
  const balanceMap = new Map();

  allSortedSchedules.forEach(s => {
    runningBalance += (s.amount || 0);
    balanceMap.set(s.id, runningBalance);
  });

  activeSchedules.forEach(s => {
    const tr = document.createElement('tr');
    const predictedBalance = balanceMap.get(s.id) || 0;

    tr.innerHTML = `
      <td style="position: relative; text-align: center;">
        <button 
          type="button" 
          class="date-display-btn" 
          onclick="triggerDatePicker('date-picker-${s.id}')"
        >
          ${formatDateToMMDD(s.date)} 📅
        </button>
        <input 
          type="date" 
          id="date-picker-${s.id}" 
          value="${s.date || ''}" 
          class="hidden-date-input" 
          onchange="handleDateChange('${s.id}', this.value)"
        >
      </td>
      <td><input type="text" value="${escapeHtml(s.title)}" onchange="updateSchedule('${s.id}', 'title', this.value)"></td>
      <td><input type="number" value="${s.amount}" onchange="updateSchedule('${s.id}', 'amount', toNumber(this.value))"></td>
      <td style="text-align: right; font-weight: 500;">¥${predictedBalance.toLocaleString()}</td>
      <td><button class="btn-action" onclick="deleteSchedule('${s.id}')">削除</button></td>
    `;
    tbody.appendChild(tr);
  });
}

function renderMemoTable() {
  const tbody = document.getElementById('memoTableBody');
  tbody.innerHTML = '';

  appState.memos.forEach(m => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" value="${escapeHtml(m.title)}" onchange="updateMemo('${m.id}', 'title', this.value)"></td>
      <td><input type="number" value="${m.amount}" onchange="updateMemo('${m.id}', 'amount', toNumber(this.value))"></td>
      <td class="action-cell">
        <button class="btn-action btn-promote" onclick="openPromoteModal('${m.id}')" title="予定へ移動">昇格</button>
        <button class="btn-action" onclick="deleteMemo('${m.id}')">削除</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// --- モーダル・入力系イベント設定 ---
function addNewTab() {
  currentEditTabId = null;
  const headerEl = document.getElementById('tabModalHeader');
  if (headerEl) headerEl.textContent = 'タブの追加';
  
  const input = document.getElementById('tabModalNameInput');
  if (input) input.value = '';
  
  const deleteBtn = document.getElementById('deleteTabBtn');
  if (deleteBtn) deleteBtn.style.display = 'none';
  
  const saveBtn = document.getElementById('saveTabModalBtn');
  if (saveBtn) saveBtn.textContent = '追加';
  
  const modal = document.getElementById('tabModal');
  if (modal) modal.classList.add('active');
  setTimeout(() => input && input.focus(), 100);
}

function openTabEditModal(tabId) {
  const tab = appState.tabs.find(t => t.id === tabId);
  if (!tab) return;

  currentEditTabId = tabId;
  const headerEl = document.getElementById('tabModalHeader');
  if (headerEl) headerEl.textContent = 'タブの編集';
  
  const input = document.getElementById('tabModalNameInput');
  if (input) input.value = tab.name;
  
  const deleteBtn = document.getElementById('deleteTabBtn');
  if (deleteBtn) deleteBtn.style.display = 'inline-block';
  
  const saveBtn = document.getElementById('saveTabModalBtn');
  if (saveBtn) saveBtn.textContent = '保存';
  
  const modal = document.getElementById('tabModal');
  if (modal) modal.classList.add('active');
  setTimeout(() => input && input.select(), 100);
}

function closeTabModal() {
  const modal = document.getElementById('tabModal');
  if (modal) modal.classList.remove('active');
  currentEditTabId = null;
}

function saveTabModal() {
  const input = document.getElementById('tabModalNameInput');
  const newName = input ? input.value.trim() : '';
  
  if (!newName) {
    alert('タブ名を入力してください。');
    return;
  }

  if (currentEditTabId) {
    const tab = appState.tabs.find(t => t.id === currentEditTabId);
    if (tab) {
      tab.name = newName;
    }
  } else {
    const newTab = {
      id: makeId('tab_'),
      name: newName
    };
    appState.tabs.push(newTab);
    appState.activeTabId = newTab.id;
  }

  saveData();
  renderAll();
  closeTabModal();
}

function deleteTab() {
  if (!currentEditTabId) return;

  if (appState.tabs.length <= 1) {
    alert('これ以上タブを削除することはできません。最低1つのタブが必要です。');
    return;
  }

  const tab = appState.tabs.find(t => t.id === currentEditTabId);
  if (!tab) return;

  const confirmDelete = confirm(`タブ「${tab.name}」を削除してもよろしいですか？\n※含まれている予定データも削除されます。`);
  if (!confirmDelete) return;

  appState.schedules = appState.schedules.filter(s => s.tabId !== currentEditTabId);
  appState.tabs = appState.tabs.filter(t => t.id !== currentEditTabId);

  if (appState.activeTabId === currentEditTabId) {
    appState.activeTabId = appState.tabs[0].id;
  }

  saveData();
  renderAll();
  closeTabModal();
}

// --- 昇格モーダル ---
window.openPromoteModal = (id) => {
  const memo = appState.memos.find(m => m.id === id);
  if (!memo) return;

  currentPromoteMemoId = id;
  document.getElementById('modalMemoTitle').textContent = `「${memo.title}」`;
  document.getElementById('modalDateInput').value = getTodayString();
  document.getElementById('promoteModal').classList.add('active');
};

function closePromoteModal() {
  document.getElementById('promoteModal').classList.remove('active');
  currentPromoteMemoId = null;
}

function confirmPromote() {
  if (!currentPromoteMemoId) return;

  const dateValue = document.getElementById('modalDateInput').value;

  const memo = appState.memos.find(m => m.id === currentPromoteMemoId);
  if (memo) {
    appState.schedules.push({
      id: makeId('s_'),
      tabId: appState.activeTabId,
      date: dateValue || '',
      title: memo.title,
      amount: memo.amount
    });
    appState.memos = appState.memos.filter(m => m.id !== currentPromoteMemoId);
    saveData();
    renderAll();
  }

  closePromoteModal();
}

// --- イベントリスナー ---
document.addEventListener('DOMContentLoaded', () => {
  const depositInput = document.getElementById('depositBalanceInput');

  if (depositInput) {
    depositInput.addEventListener('focus', () => {
      depositInput.value = appState.depositBalance;
      depositInput.select();
    });

    depositInput.addEventListener('blur', () => {
      const rawVal = depositInput.value.replace(/,/g, '');
      const numVal = Number(rawVal);
      if (!isNaN(numVal)) {
        appState.depositBalance = numVal;
        saveData();
        renderAll();
      } else {
        depositInput.value = appState.depositBalance.toLocaleString();
      }
    });

    depositInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        depositInput.blur();
      }
    });
  }

  // レコード追加時：日付を空文字に設定
  const addSchedBtn = document.getElementById('addScheduleBtn');
  if (addSchedBtn) {
    addSchedBtn.onclick = () => {
      const newSchedule = {
        id: makeId('s_'),
        tabId: appState.activeTabId,
        date: '',
        title: '',
        amount: 0
      };
      appState.schedules.push(newSchedule);
      saveData();
      renderAll();
    };
  }

  const addMemoBtn = document.getElementById('addMemoBtn');
  if (addMemoBtn) {
    addMemoBtn.onclick = () => {
      const newMemo = {
        id: makeId('m_'),
        title: '',
        amount: 0
      };
      appState.memos.push(newMemo);
      saveData();
      renderAll();
    };
  }

  const closeModalBtn = document.getElementById('closeModalBtn');
  if (closeModalBtn) closeModalBtn.onclick = closePromoteModal;
  
  const confirmPromoteBtn = document.getElementById('confirmPromoteBtn');
  if (confirmPromoteBtn) confirmPromoteBtn.onclick = confirmPromote;

  const closeTabModalBtn = document.getElementById('closeTabModalBtn');
  if (closeTabModalBtn) closeTabModalBtn.onclick = closeTabModal;

  const saveTabModalBtn = document.getElementById('saveTabModalBtn');
  if (saveTabModalBtn) saveTabModalBtn.onclick = saveTabModal;

  const deleteTabBtn = document.getElementById('deleteTabBtn');
  if (deleteTabBtn) deleteTabBtn.onclick = deleteTab;

  // データ管理（バックアップ）
  const openDataModalBtn = document.getElementById('openDataModalBtn');
  if (openDataModalBtn) openDataModalBtn.onclick = openDataModal;

  const closeDataModalBtn = document.getElementById('closeDataModalBtn');
  if (closeDataModalBtn) closeDataModalBtn.onclick = closeDataModal;

  const exportBtn = document.getElementById('exportBackupBtn');
  if (exportBtn) exportBtn.onclick = exportToFile;

  const shareBtn = document.getElementById('shareBackupBtn');
  if (shareBtn) shareBtn.onclick = shareBackupFile;

  const importInput = document.getElementById('importFileInput');
  const importBtn = document.getElementById('importBackupBtn');
  if (importBtn && importInput) {
    importBtn.onclick = () => importInput.click();
    importInput.addEventListener('change', () => {
      importFromFile(importInput.files[0]);
      importInput.value = '';
    });
  }
});

// --- ドラッグ＆ドロップ ---
let dragSrcIndex = null;
function handleDragStart(e) {
  dragSrcIndex = this.dataset.index;
  this.classList.add('dragging');
}
function handleDragOver(e) { e.preventDefault(); }
function handleDrop(e) {
  e.preventDefault();
  const targetIndex = this.dataset.index;
  if (dragSrcIndex !== null && dragSrcIndex !== targetIndex) {
    const movedItem = appState.tabs.splice(dragSrcIndex, 1)[0];
    appState.tabs.splice(targetIndex, 0, movedItem);
    saveData();
    renderAll();
  }
}

// 修正点：未指定時は MM/DD と表示
function formatDateToMMDD(dateStr) {
  if (!dateStr) {
    return 'MM/DD';
  }
  
  const parts = dateStr.replace(/\//g, '-').split('-');
  if (parts.length === 3) {
    const month = String(parts[1]).padStart(2, '0');
    const day = String(parts[2]).padStart(2, '0');
    return `${month}/${day}`;
  }
  
  return dateStr;
}

window.triggerDatePicker = (pickerId) => {
  const picker = document.getElementById(pickerId);
  if (!picker) return;
  if ('showPicker' in HTMLInputElement.prototype) {
    picker.showPicker();
  } else {
    picker.click();
  }
};

window.handleDateChange = (id, value) => {
  const item = appState.schedules.find(s => s.id === id);
  if (item) {
    item.date = value || '';
    saveData();
    renderAll();
  }
};

window.updateSchedule = (id, key, value) => {
  const item = appState.schedules.find(s => s.id === id);
  if (item) {
    item[key] = value;
    saveData();
    renderAll();
  }
};

window.deleteSchedule = (id) => {
  appState.schedules = appState.schedules.filter(s => s.id !== id);
  saveData();
  renderAll();
};

window.updateMemo = (id, key, value) => {
  const item = appState.memos.find(m => m.id === id);
  if (item) {
    item[key] = value;
    saveData();
    renderAll();
  }
};

window.deleteMemo = (id) => {
  appState.memos = appState.memos.filter(m => m.id !== id);
  saveData();
  renderAll();
};

// 初期表示実行
loadData();
renderAll();
notifySettlement(pendingSettlement);
requestPersistentStorage();
initSalaryPage();

// 日付の切り替わりをチェック（アプリに戻ってきたとき＋1分ごと）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkDayChange();
});
setInterval(checkDayChange, 60 * 1000);
