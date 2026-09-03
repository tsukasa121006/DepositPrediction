// --- アプリケーションデータ管理 ---
let appState = {
  depositBalance: 1000000,
  lastProcessDate: '',
  tabs: [
    { id: 'tab_normal', name: '通常' },
    { id: 'tab_furima', name: 'フリマ' }
  ],
  activeTabId: 'tab_normal',
  schedules: [],
  memos: []
};

let currentPromoteMemoId = null;
let currentEditTabId = null;

// 初期化ロード
function loadData() {
  const saved = localStorage.getItem('acc_sim_data');
  if (saved) {
    try {
      appState = JSON.parse(saved);
      if (appState.depositBalance === undefined) {
        appState.depositBalance = appState.totalBalance || 1000000;
      }
      if (!appState.schedules) appState.schedules = [];
      if (!appState.memos) appState.memos = [];
    } catch (e) {
      console.error('Data load error:', e);
    }
  } else {
    const today = getTodayString();
    appState.schedules = [
      { id: 's1', tabId: 'tab_normal', date: today, title: '給料', amount: 250000 },
      { id: 's2', tabId: 'tab_normal', date: '2026-10-05', title: '家賃', amount: -80000 }
    ];
    appState.memos = [
      { id: 'm1', title: '立替金返金', amount: 5000 }
    ];
    appState.lastProcessDate = today;
    saveData();
  }
  processDailyTransition();
}

function saveData() {
  localStorage.setItem('acc_sim_data', JSON.stringify(appState));
}

function getTodayString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// --- 日次自動更新ロジック ---
function processDailyTransition() {
  const todayStr = getTodayString();
  appState.lastProcessDate = todayStr;
  saveData();
}

// --- UI描画処理 ---
function renderAll() {
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
      li.innerHTML = `${item.title} (<span class="${colorClass}">${sign}¥${item.amount.toLocaleString()}</span>)`;
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
      <td><input type="text" value="${s.title}" onchange="updateSchedule('${s.id}', 'title', this.value)"></td>
      <td><input type="number" value="${s.amount}" onchange="updateSchedule('${s.id}', 'amount', Number(this.value))"></td>
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
      <td><input type="text" value="${m.title}" onchange="updateMemo('${m.id}', 'title', this.value)"></td>
      <td><input type="number" value="${m.amount}" onchange="updateMemo('${m.id}', 'amount', Number(this.value))"></td>
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
      id: 'tab_' + Date.now(),
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
      id: 's_' + Date.now(),
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
        id: 's_' + Date.now(),
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
        id: 'm_' + Date.now(),
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
