const STATUS_LABELS = {
  present: 'Present',
  half: 'Half day',
  paid: 'Paid leave',
  unpaid: 'Unpaid leave',
};

const grid = document.querySelector('#calendar-grid');
const monthLabel = document.querySelector('#month-label');
const dialog = document.querySelector('#day-dialog');
const bulkDialog = document.querySelector('#bulk-dialog');
const attendanceForm = document.querySelector('#day-form');
const liveMessage = document.querySelector('#live-message');
const employeeSelect = document.querySelector('#active-employee');
const employeeForm = document.querySelector('#employee-form');
const payTypeInput = document.querySelector('#pay-type');
const themeToggles = document.querySelectorAll('[data-theme-toggle]');
const loginView = document.querySelector('#login-view');
const appView = document.querySelector('#app-view');

let currentUser = null;
let csrf = '';
let employees = [];
let selectedEmployeeId = '';
let entries = {};
let history = [];
let currency = 'INR';
let editingEmployeeId = '';
let creatingEmployee = false;
let activeDate = '';
let visibleDate = new Date();
let selectedDates = new Set();
let selectionMode = false;
let pendingBulkDates = null;
let bulkConfirmationSignature = '';
let payrollData = null;
let closureData = [];
let payrollConfirmResolve = null;
let activeWorkspaceView = 'attendance';

function setWorkspaceView(view) {
  const owner = currentUser?.role === 'owner';
  activeWorkspaceView = owner ? view : 'attendance';
  document.querySelectorAll('[data-workspace-page]').forEach((page) => {
    page.classList.toggle('hidden', page.dataset.workspacePage !== activeWorkspaceView);
  });
  document.querySelectorAll('[data-view-button]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.viewButton === activeWorkspaceView));
  });
  document.querySelector('.context-worker').classList.toggle('hidden', activeWorkspaceView === 'payroll');
  const titles = {
    attendance: ['Attendance & wages', owner
      ? 'Review the calendar and update attendance for any worker.'
      : 'Mark your attendance for any day. Your entries are recorded immediately.'],
    payroll: ['Payroll summary', 'Review, export, or print this month’s wages and deductions.'],
    management: ['Pay & shop settings', 'Manage your team, pay adjustments, and shop closures.'],
  };
  const [title, description] = titles[activeWorkspaceView];
  document.querySelector('#page-title').textContent = title;
  document.querySelector('#intro-copy').textContent = description;
}

function setTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  themeToggles.forEach((toggle) => {
    toggle.setAttribute('aria-pressed', String(dark));
    toggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    toggle.querySelector('.theme-label').textContent = dark ? 'Light mode' : 'Dark mode';
    toggle.querySelector('[aria-hidden="true"]').textContent = dark ? '☀' : '☾';
  });
  const color = dark ? '#171922' : '#f7f8fc';
  document.querySelector('meta[name="theme-color"]').content = color;
  localStorage.setItem('daymark-theme', dark ? 'dark' : 'light');
}
function defaultUnpaidDeduction(employee) {
  if (!employee || employee.payType !== 'monthly') return 0;
  const divisor = Math.max(1, daysInMonth(visibleDate) - employee.allowanceThisMonth);
  return Number((employee.rate / divisor).toFixed(2));
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function daysInMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function formatMoney(amount) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
}

function selectedEmployee() {
  return employees.find((employee) => employee.id === selectedEmployeeId) ?? null;
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.body) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET' && csrf) headers.set('X-CSRF-Token', csrf);
  const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
  const payload = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    if (response.status === 401 && url !== '/api/login') showLogin();
    const error = new Error(payload.error || 'Request failed.');
    error.code = payload.code;
    throw error;
  }
  return payload;
}

function confirmPayrollChange(message) {
  const confirmDialog = document.querySelector('#payroll-confirm-dialog');
  document.querySelector('#payroll-confirm-message').textContent = message;
  confirmDialog.showModal();
  return new Promise((resolve) => {
    payrollConfirmResolve = resolve;
  });
}

function resolvePayrollConfirmation(confirmed) {
  if (!payrollConfirmResolve) return;
  const resolve = payrollConfirmResolve;
  payrollConfirmResolve = null;
  document.querySelector('#payroll-confirm-dialog').close();
  resolve(confirmed);
}

async function apiWithPayrollConfirmation(url, body, method = 'POST') {
  const send = (confirmed = false) => api(url, {
    method,
    ...(body === null ? {} : {
      body: JSON.stringify({ ...body, ...(confirmed ? { confirmFinalizedMonth: true } : {}) }),
    }),
  });
  try {
    return await send();
  } catch (error) {
    if (error.code !== 'MONTH_FINALIZED') throw error;
    const confirmed = await confirmPayrollChange(`${error.message} Continue?`);
    if (!confirmed) throw new Error('Change cancelled.');
    return send(true);
  }
}

function showMessage(element, message, isError = true) {
  element.textContent = message;
  element.classList.toggle('success-message', !isError && Boolean(message));
}

function showLogin(message = '', isError = true) {
  currentUser = null;
  csrf = '';
  activeWorkspaceView = 'attendance';
  selectedDates.clear();
  selectionMode = false;
  appView.classList.add('hidden');
  loginView.classList.remove('hidden');
  showMessage(document.querySelector('#login-message'), message, isError);
}

function renderEmployees() {
  employeeSelect.replaceChildren();
  const adjustmentEmployee = document.querySelector('#adjustment-employee');
  adjustmentEmployee.replaceChildren();
  for (const employee of employees) {
    const option = document.createElement('option');
    option.value = employee.id;
    option.textContent = employee.name;
    employeeSelect.append(option);
    const adjustmentOption = option.cloneNode(true);
    adjustmentEmployee.append(adjustmentOption);
  }
  employeeSelect.value = selectedEmployeeId;
  adjustmentEmployee.value = selectedEmployeeId || employees[0]?.id || '';
  employeeSelect.disabled = employees.length < 2;
  adjustmentEmployee.disabled = employees.length === 0;
}

function renderRole() {
  const owner = currentUser?.role === 'owner';
  document.body.dataset.role = owner ? 'owner' : 'worker';
  document.querySelectorAll('.owner-only').forEach((element) => {
    element.classList.toggle('hidden', !owner);
  });
  document.querySelector('#current-user').textContent = `${currentUser.name} · ${owner ? 'Owner' : 'Worker'}`;
  setWorkspaceView(activeWorkspaceView);
  document.querySelector('#worker-password').required = !editingEmployeeId;
  document.querySelector('#worker-password-label').textContent = editingEmployeeId
    ? 'New password (optional)'
    : 'Temporary password';
}

function updateBulkControls() {
  const owner = currentUser?.role === 'owner';
  const selectButton = document.querySelector('#select-days-button');
  const cancelButton = document.querySelector('#cancel-selection-button');
  const applyButton = document.querySelector('#apply-selected-button');
  selectButton.classList.toggle('hidden', !owner || selectionMode);
  cancelButton.classList.toggle('hidden', !owner || !selectionMode);
  applyButton.classList.toggle('hidden', !owner || !selectionMode || selectedDates.size === 0);
  applyButton.textContent = `Mark selected (${selectedDates.size})`;
  document.querySelector('#selection-hint').classList.toggle('hidden', !selectionMode);
  document.querySelector('#bulk-range-button').disabled = !owner || !selectedEmployee();
}

function updatePayTypeLabel() {
  document.querySelector('#rate-label').textContent = payTypeInput.value === 'monthly' ? 'Monthly wage' : 'Daily rate';
  const symbol = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    maximumFractionDigits: 0,
  }).formatToParts(0).find((part) => part.type === 'currency')?.value ?? currency;
  document.querySelector('#currency-prefix').textContent = symbol;
  document.querySelectorAll('.payroll-currency-prefix').forEach((prefix) => {
    prefix.textContent = symbol;
  });
}

function renderEmployeeForm() {
  const employee = selectedEmployee();
  employeeForm.reset();
  document.querySelector('#leave-allowance').value = employee?.allowanceThisMonth ?? 2;
  document.querySelector('#base-leave-allowance').value = employee?.monthlyLeaveAllowance ?? 2;
  document.querySelector('#current-allowance-label').textContent =
    `Allowance for ${new Intl.DateTimeFormat(undefined, { month: 'long' }).format(visibleDate)}`;
  if (employee && !creatingEmployee) {
    document.querySelector('#employee-name').value = employee.name;
    document.querySelector('#worker-username').value = employee.username ?? '';
    document.querySelector('#pay-type').value = employee.payType;
    document.querySelector('#pay-rate').value = employee.rate;
    document.querySelector('#employee-submit').textContent = 'Save worker details';
    document.querySelector('#employee-cancel').classList.remove('hidden');
    editingEmployeeId = employee.id;
  } else {
    editingEmployeeId = '';
    document.querySelector('#employee-submit').textContent = 'Add worker account';
    document.querySelector('#employee-cancel').classList.toggle('hidden', employees.length === 0);
  }
  document.querySelector('#worker-password').required = !editingEmployeeId;
  document.querySelector('#worker-password-label').textContent = editingEmployeeId
    ? 'New password (optional)'
    : 'Temporary password';
  updatePayTypeLabel();
}

function renderCalendar() {
  const employee = selectedEmployee();
  const closuresByDate = new Map(closureData.map((closure) => [closure.date, closure]));
  const year = visibleDate.getFullYear();
  const month = visibleDate.getMonth();
  monthLabel.textContent = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(visibleDate);
  grid.replaceChildren();
  for (const weekday of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
    const heading = document.createElement('div');
    heading.className = 'weekday';
    heading.setAttribute('role', 'columnheader');
    heading.textContent = weekday;
    grid.append(heading);
  }
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  const today = dateKey(new Date());
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = dateKey(date);
    const entry = entries[key];
    const closure = closuresByDate.get(key);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'day-cell';
    button.setAttribute('role', 'gridcell');
    button.setAttribute('aria-label', `${new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(date)}${entry ? `, ${STATUS_LABELS[entry.status]}` : ', unmarked'}`);
    if (date.getMonth() !== month) button.classList.add('outside-month');
    if (key === today) button.classList.add('today');
    if (selectedDates.has(key)) button.classList.add('selected-day');
    const number = document.createElement('span');
    number.className = 'day-number';
    number.textContent = date.getDate();
    button.append(number);
    if (entry) {
      const badge = document.createElement('span');
      badge.className = `day-status status-${entry.status}`;
      badge.textContent = STATUS_LABELS[entry.status];
      badge.title = `Recorded by ${entry.recordedBy}`;
      button.append(badge);
    }
    if (closure) {
      const badge = document.createElement('span');
      badge.className = 'day-status status-closure';
      badge.textContent = closure.type === 'weekly_off' ? 'Weekly off' : 'Shop holiday';
      badge.title = `${closure.label} · ${closure.payTreatment} closure`;
      button.append(badge);
      button.title = `${closure.label} (${closure.payTreatment} closure)`;
    }
    button.disabled = !employee || date.getMonth() !== month || Boolean(closure);
    button.addEventListener('click', () => {
      if (selectionMode) {
        if (selectedDates.has(key)) selectedDates.delete(key);
        else selectedDates.add(key);
        updateBulkControls();
        renderCalendar();
        return;
      }
      openDayDialog(key);
    });
    grid.append(button);
  }
  renderSummary();
  updateBulkControls();
}

function renderSummary() {
  const employee = selectedEmployee();
  const values = Object.values(entries);
  const fullDays = values.filter((entry) => entry.status === 'present').length;
  const halfDays = values.filter((entry) => entry.status === 'half').length;
  const paid = values.filter((entry) => entry.status === 'paid').length;
  const unpaidDeduction = values.reduce((sum, entry) =>
    entry.status === 'unpaid' ? sum + (entry.deductionAmount ?? 0) : sum, 0);
  document.querySelector('#present-count').textContent = fullDays;
  document.querySelector('#half-count').textContent = halfDays;
  document.querySelector('#unpaid-count').textContent = values.filter((entry) => entry.status === 'unpaid').length;
  document.querySelector('#paid-used').textContent = paid;
  document.querySelector('#paid-total').textContent = employee?.allowanceThisMonth ?? 0;
  document.querySelector('#paid-remaining').textContent = employee
    ? `${Math.max(0, employee.allowanceThisMonth - paid)} left this month`
    : 'No worker selected';
  const payrollEmployee = payrollData?.employees.find((item) => item.employeeId === employee?.id);
  const wages = !employee ? null : payrollEmployee?.finalPay ?? (employee.payType === 'daily'
    ? (fullDays + halfDays * 0.5) * employee.rate
    : Math.max(0, employee.rate - unpaidDeduction));
  document.querySelector('#wage-total').textContent = wages === null ? '—' : formatMoney(wages);
  document.querySelector('#wage-period').textContent = employee?.payType === 'monthly'
    ? (payrollEmployee ? 'net pay estimate' : (unpaidDeduction ? `${formatMoney(unpaidDeduction)} deducted` : 'fixed monthly wage'))
    : 'days worked';
}

function formatDateLabel(date) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(`${date}T12:00:00`));
}

function appendPayrollRecord(list, description, meta, action = null, inactive = false) {
  const item = document.createElement('li');
  item.className = 'payroll-record';
  const content = document.createElement('div');
  content.className = 'payroll-record-content';
  const main = document.createElement('strong');
  main.textContent = description;
  const sub = document.createElement('small');
  sub.textContent = meta;
  content.append(main, sub);
  item.append(content);
  if (action) item.append(action);
  if (inactive) item.classList.add('record-inactive');
  list.append(item);
}

function renderPayroll() {
  const rows = document.querySelector('#payroll-rows');
  rows.replaceChildren();
  const adjustmentList = document.querySelector('#adjustment-list');
  const closureList = document.querySelector('#closure-list');
  const activityList = document.querySelector('#payroll-activity-list');
  adjustmentList.replaceChildren();
  closureList.replaceChildren();
  activityList.replaceChildren();
  if (!payrollData) return;

  const { first, last } = currentMonthBounds();
  const closureDate = document.querySelector('#closure-date');
  closureDate.min = first;
  closureDate.max = last;
  if (!closureDate.value || closureDate.value < first || closureDate.value > last) {
    const today = dateKey(new Date());
    closureDate.value = today >= first && today <= last ? today : first;
  }

  for (const employee of payrollData.employees) {
    const row = document.createElement('tr');
    const cells = [
      employee.employeeName,
      `${employee.presentDays} full + ${employee.halfDays} half`,
      String(employee.paidLeaveDays),
      String(employee.unpaidLeaveDays),
      `${employee.paidClosureDays} paid / ${employee.unpaidClosureDays} unpaid`,
      formatMoney(employee.grossWage),
      `${formatMoney(employee.unpaidLeaveDeduction)} / ${formatMoney(employee.closureDeduction)}`,
      formatMoney(employee.advances),
      formatMoney(employee.bonuses),
      formatMoney(employee.otherDeductions),
      formatMoney(employee.totalDeductions),
      formatMoney(employee.finalPay),
    ];
    for (const value of cells) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    rows.append(row);
  }
  if (!payrollData.employees.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 12;
    cell.textContent = 'Add a worker to see this month’s payroll summary.';
    row.append(cell);
    rows.append(row);
  }

  const employeeNames = new Map(payrollData.employees.map((employee) => [employee.employeeId, employee.employeeName]));
  for (const adjustment of payrollData.adjustments) {
    const voided = Boolean(adjustment.voidedAt);
    const typeLabel = adjustment.type === 'advance' ? 'Advance' : adjustment.type === 'bonus' ? 'Bonus' : 'Other deduction';
    const description = `${employeeNames.get(adjustment.employeeId) ?? 'Worker'} · ${typeLabel}: ${formatMoney(adjustment.amount)}${adjustment.note ? ` · ${adjustment.note}` : ''}`;
    const meta = `Added by ${adjustment.actor} · ${formatDateLabel(adjustment.createdAt.slice(0, 10))}${voided ? ` · voided by ${adjustment.voidedBy}` : ''}`;
    let action = null;
    if (!voided) {
      action = document.createElement('button');
      action.type = 'button';
      action.className = 'cancel-button record-action';
      action.textContent = 'Void';
      action.addEventListener('click', async () => {
        if (!window.confirm(`Void this ${typeLabel.toLowerCase()}? The audit record will remain.`)) return;
        try {
          await apiWithPayrollConfirmation(`/api/payroll/adjustments/${encodeURIComponent(adjustment.id)}`, {}, 'DELETE');
          await refreshMonthData();
        } catch (error) {
          if (error.message !== 'Change cancelled.') liveMessage.textContent = error.message;
        }
      });
    }
    appendPayrollRecord(adjustmentList, description, meta, action, voided);
  }
  if (!payrollData.adjustments.length) appendPayrollRecord(adjustmentList, 'No adjustments this month.', '');

  for (const closure of payrollData.closures) {
    const typeLabel = closure.type === 'weekly_off' ? 'Weekly off' : 'Holiday';
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'cancel-button record-action';
    action.textContent = 'Remove';
    action.addEventListener('click', async () => {
      if (!window.confirm(`Remove ${closure.label} on ${formatDateLabel(closure.date)}?`)) return;
      try {
        await apiWithPayrollConfirmation(`/api/closures/${encodeURIComponent(closure.id)}`, {}, 'DELETE');
        await refreshMonthData();
      } catch (error) {
        if (error.message !== 'Change cancelled.') liveMessage.textContent = error.message;
      }
    });
    appendPayrollRecord(
      closureList,
      `${closure.label} · ${formatDateLabel(closure.date)} · ${typeLabel} (${closure.payTreatment})`,
      `Added by ${closure.actor} · ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(closure.createdAt))}`,
      action,
    );
  }
  if (!payrollData.closures.length) appendPayrollRecord(closureList, 'No shop closures this month.', '');

  for (const activity of payrollData.activity) {
    const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(activity.timestamp));
    appendPayrollRecord(activityList, activity.description, `${activity.actor} · ${time}`);
  }
  if (!payrollData.activity.length) appendPayrollRecord(activityList, 'No payroll activity this month.', '');

  const status = document.querySelector('#payroll-period-status');
  const finalizeButton = document.querySelector('#finalize-payroll-button');
  const warning = document.querySelector('#payroll-warning');
  if (!payrollData.finalizedAt) {
    status.textContent = `${payrollData.month} · Review wage totals. Finalizing saves who reviewed the report and when.`;
    finalizeButton.textContent = 'Finalize month';
    warning.classList.add('hidden');
  } else {
    const finalizedTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      .format(new Date(payrollData.finalizedAt));
    status.textContent = `${payrollData.month} · Finalized by ${payrollData.finalizedBy} on ${finalizedTime}.`;
    finalizeButton.textContent = 'Finalize again';
    if (payrollData.lastChangeAt) {
      const changedTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        .format(new Date(payrollData.lastChangeAt));
      warning.textContent = `This finalized month was changed by ${payrollData.lastChangeBy} on ${changedTime}. Review the report and finalize it again.`;
      warning.classList.remove('hidden');
    } else {
      warning.classList.add('hidden');
    }
  }
}

function renderHistory() {
  const list = document.querySelector('#history-list');
  list.replaceChildren();
  document.querySelector('#history-count').textContent = `${history.length} ${history.length === 1 ? 'change' : 'changes'}`;
  if (!history.length) {
    const empty = document.createElement('li');
    empty.className = 'history-empty';
    empty.textContent = 'Attendance changes will appear here.';
    list.append(empty);
    return;
  }
  for (const event of history) {
    const item = document.createElement('li');
    item.className = 'history-item';
    const change = document.createElement('p');
    change.className = 'history-change';
    const worker = document.createElement('strong');
    worker.textContent = event.employeeName;
    const oldStatus = document.createElement('strong');
    oldStatus.textContent = STATUS_LABELS[event.previousStatus] || 'Unmarked';
    const newStatus = document.createElement('strong');
    newStatus.textContent = STATUS_LABELS[event.status] || 'Unmarked';
    const formattedDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(`${event.date}T12:00:00`));
    change.append(worker, ` · ${formattedDate}: `, oldStatus, ' → ', newStatus);
    if (event.previousDeductionAmount !== event.deductionAmount &&
        (event.previousDeductionAmount > 0 || event.deductionAmount > 0)) {
      change.append(` · deduction ${formatMoney(event.previousDeductionAmount)} → ${formatMoney(event.deductionAmount)}`);
    }
    const meta = document.createElement('div');
    meta.className = 'history-meta';
    const actor = document.createElement('span');
    actor.textContent = `By ${event.actor} (${event.role})`;
    const timestamp = document.createElement('time');
    timestamp.dateTime = event.timestamp;
    timestamp.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(event.timestamp));
    meta.append(actor, timestamp);
    item.append(change, meta);
    list.append(item);
  }
}

async function refreshMonthData() {
  const employee = selectedEmployee();
  if (!employee) {
    entries = {};
    history = [];
    payrollData = currentUser?.role === 'owner' ? { employees: [], adjustments: [], closures: [], activity: [] } : null;
    closureData = [];
    renderCalendar();
    renderHistory();
    renderPayroll();
    return;
  }
  const params = new URLSearchParams({ month: monthKey(visibleDate) });
  const historyParams = new URLSearchParams({ month: monthKey(visibleDate) });
  if (currentUser.role === 'owner') params.set('employeeId', employee.id);
  historyParams.set('employeeId', employee.id);
  const [attendance, audit, shop, payroll, closures] = await Promise.all([
    api(`/api/attendance?${params}`),
    api(`/api/history?${historyParams}`),
    api(`/api/shop?month=${encodeURIComponent(monthKey(visibleDate))}`),
    currentUser.role === 'owner'
      ? api(`/api/payroll?month=${encodeURIComponent(monthKey(visibleDate))}`)
      : Promise.resolve(null),
    currentUser.role === 'worker'
      ? api(`/api/closures?month=${encodeURIComponent(monthKey(visibleDate))}`)
      : Promise.resolve(null),
  ]);
  entries = Object.fromEntries(attendance.entries.map((entry) => [entry.date, entry]));
  history = audit.history;
  payrollData = payroll;
  closureData = payroll?.closures ?? closures?.closures ?? [];
  currency = shop.currency;
  const latestEmployee = shop.employees.find((item) => item.id === employee.id);
  if (latestEmployee) Object.assign(employee, latestEmployee);
  if (currentUser.role === 'owner') renderEmployeeForm();
  updatePayTypeLabel();
  renderCalendar();
  renderHistory();
  if (currentUser.role === 'owner') renderPayroll();
}

async function refreshApp() {
  const month = monthKey(visibleDate);
  const shop = await api(`/api/shop?month=${encodeURIComponent(month)}`);
  employees = shop.employees;
  currency = shop.currency;
  if (currentUser.role === 'worker') selectedEmployeeId = employees[0]?.id ?? '';
  else if (!employees.some((employee) => employee.id === selectedEmployeeId)) selectedEmployeeId = employees[0]?.id ?? '';
  renderEmployees();
  renderRole();
  if (currentUser.role === 'owner') renderEmployeeForm();
  await refreshMonthData();
}

async function startApp() {
  const me = await api('/api/me');
  if (!me.authenticated) {
    showLogin();
    return;
  }
  csrf = me.csrfToken;
  currentUser = me;
  loginView.classList.add('hidden');
  appView.classList.remove('hidden');
  await refreshApp();
}

function openDayDialog(date) {
  activeDate = date;
  const employee = selectedEmployee();
  if (!employee) return;
  const displayDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${date}T12:00:00`));
  document.querySelector('#dialog-title').textContent = `${employee.name} · ${displayDate}`;
  const current = entries[date]?.status ?? '';
  const selected = attendanceForm.querySelector(`input[name="status"][value="${current}"]`);
  (selected ?? attendanceForm.querySelector('input[name="status"][value=""]')).checked = true;
  document.querySelector('#dialog-error').textContent = '';
  updateSingleDeductionControl(current);
  dialog.showModal();
}

function updateSingleDeductionControl(status) {
  const employee = selectedEmployee();
  const control = document.querySelector('#single-deduction-control');
  const visible = currentUser?.role === 'owner' && employee?.payType === 'monthly' && status === 'unpaid';
  control.classList.toggle('hidden', !visible);
  if (!visible) return;
  const existing = entries[activeDate]?.deductionAmount;
  const amount = existing ?? defaultUnpaidDeduction(employee);
  document.querySelector('#single-deduction').value = amount.toFixed(2);
  document.querySelector('#single-currency-prefix').textContent = document.querySelector('#currency-prefix').textContent;
  document.querySelector('#single-deduction-hint').textContent =
    `Default: monthly wage ÷ (${daysInMonth(visibleDate)} days − ${employee.allowanceThisMonth} paid-leave days).`;
}

function currentMonthBounds() {
  const year = visibleDate.getFullYear();
  const month = String(visibleDate.getMonth() + 1).padStart(2, '0');
  const lastDay = String(daysInMonth(visibleDate)).padStart(2, '0');
  return { first: `${year}-${month}-01`, last: `${year}-${month}-${lastDay}` };
}

function openBulkDialog(dates = null) {
  if (currentUser?.role !== 'owner' || !selectedEmployee()) return;
  pendingBulkDates = dates ? [...dates].sort() : null;
  bulkConfirmationSignature = '';
  const { first, last } = currentMonthBounds();
  const rangeFields = document.querySelector('.bulk-date-fields');
  const selectionSummary = document.querySelector('#bulk-selected-summary');
  rangeFields.classList.toggle('hidden', Boolean(dates));
  selectionSummary.classList.toggle('hidden', !dates);
  document.querySelector('#bulk-start').disabled = Boolean(dates);
  document.querySelector('#bulk-end').disabled = Boolean(dates);
  if (dates) {
    selectionSummary.textContent = `${pendingBulkDates.length} selected ${pendingBulkDates.length === 1 ? 'day' : 'days'}: ${pendingBulkDates.join(', ')}`;
  } else {
    document.querySelector('#bulk-start').value = first;
    document.querySelector('#bulk-end').value = last;
    document.querySelector('#bulk-start').min = first;
    document.querySelector('#bulk-start').max = last;
    document.querySelector('#bulk-end').min = first;
    document.querySelector('#bulk-end').max = last;
  }
  document.querySelector('#bulk-title').textContent = dates ? 'Mark selected days' : 'Mark a date range';
  document.querySelector('#bulk-warning').classList.add('hidden');
  document.querySelector('#bulk-warning').textContent = '';
  document.querySelector('#bulk-apply-button').textContent = 'Apply status';
  document.querySelector('#bulk-status').value = 'present';
  updateBulkDeductionControl();
  bulkDialog.showModal();
}

function updateBulkDeductionControl() {
  const employee = selectedEmployee();
  const status = document.querySelector('#bulk-status').value;
  const visible = employee?.payType === 'monthly' && status === 'unpaid';
  const control = document.querySelector('#bulk-deduction-control');
  control.classList.toggle('hidden', !visible);
  if (!visible) return;
  const amount = defaultUnpaidDeduction(employee);
  document.querySelector('#bulk-deduction').value = amount.toFixed(2);
  document.querySelector('#bulk-currency-prefix').textContent = document.querySelector('#currency-prefix').textContent;
  document.querySelector('#bulk-deduction-hint').textContent =
    `Default per day: monthly wage ÷ (${daysInMonth(visibleDate)} days − ${employee.allowanceThisMonth} paid-leave days).`;
}

function getBulkDates() {
  if (pendingBulkDates) return pendingBulkDates;
  const startValue = document.querySelector('#bulk-start').value;
  const endValue = document.querySelector('#bulk-end').value;
  const { first, last } = currentMonthBounds();
  if (!startValue || !endValue || startValue < first || startValue > last || endValue < first || endValue > last) {
    throw new Error('Choose start and end dates within the displayed month.');
  }
  if (startValue > endValue) throw new Error('The start date must be on or before the end date.');
  const result = [];
  const date = new Date(`${startValue}T12:00:00`);
  const end = new Date(`${endValue}T12:00:00`);
  while (date <= end) {
    result.push(dateKey(date));
    date.setDate(date.getDate() + 1);
  }
  return result;
}

function downloadPayrollCsv() {
  if (!payrollData) return;
  const headers = [
    'Worker', 'Currency', 'Pay type', 'Present days', 'Half days', 'Paid leave', 'Unpaid leave',
    'Paid shop closures', 'Unpaid shop closures', 'Gross wage', 'Unpaid-leave deduction',
    'Closure deduction', 'Advances', 'Bonuses', 'Other deductions', 'Total deductions', 'Final pay',
  ];
  const rows = payrollData.employees.map((employee) => [
    employee.employeeName,
    currency,
    employee.payType,
    employee.presentDays,
    employee.halfDays,
    employee.paidLeaveDays,
    employee.unpaidLeaveDays,
    employee.paidClosureDays,
    employee.unpaidClosureDays,
    employee.grossWage,
    employee.unpaidLeaveDeduction,
    employee.closureDeduction,
    employee.advances,
    employee.bonuses,
    employee.otherDeductions,
    employee.totalDeductions,
    employee.finalPay,
  ]);
  const escape = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const content = [headers, ...rows].map((row) => row.map(escape).join(',')).join('\r\n');
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `daymark-payroll-${payrollData.month}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.querySelector('#login-message');
  showMessage(message, '');
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: document.querySelector('#login-username').value.trim(),
        password: document.querySelector('#login-password').value,
      }),
    });
    document.querySelector('#login-password').value = '';
    await startApp();
  } catch (error) {
    showMessage(message, error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
    showLogin('You have signed out.', false);
  } catch (error) {
    liveMessage.textContent = error.message;
  }
});

document.querySelectorAll('[data-view-button]').forEach((button) => {
  button.addEventListener('click', () => setWorkspaceView(button.dataset.viewButton));
});

document.querySelector('#previous-month').addEventListener('click', async () => {
  visibleDate = new Date(visibleDate.getFullYear(), visibleDate.getMonth() - 1, 1);
  selectedDates.clear();
  selectionMode = false;
  try { await refreshApp(); } catch (error) { liveMessage.textContent = error.message; }
});
document.querySelector('#next-month').addEventListener('click', async () => {
  visibleDate = new Date(visibleDate.getFullYear(), visibleDate.getMonth() + 1, 1);
  selectedDates.clear();
  selectionMode = false;
  try { await refreshApp(); } catch (error) { liveMessage.textContent = error.message; }
});
document.querySelector('#today-button').addEventListener('click', async () => {
  visibleDate = new Date();
  selectedDates.clear();
  selectionMode = false;
  try { await refreshApp(); } catch (error) { liveMessage.textContent = error.message; }
});
document.querySelector('#close-dialog').addEventListener('click', () => dialog.close());
document.querySelector('#cancel-dialog').addEventListener('click', () => dialog.close());
attendanceForm.querySelectorAll('input[name="status"]').forEach((input) => {
  input.addEventListener('change', () => updateSingleDeductionControl(input.value));
});
attendanceForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const employee = selectedEmployee();
  if (!employee) return;
  const status = new FormData(attendanceForm).get('status');
  const deductionInput = document.querySelector('#single-deduction');
  const deductionAmount = currentUser.role === 'owner' && employee.payType === 'monthly' && status === 'unpaid' && deductionInput.value !== ''
    ? Number(deductionInput.value)
    : undefined;
  if (deductionAmount !== undefined && (!Number.isFinite(deductionAmount) || deductionAmount < 0)) {
    document.querySelector('#dialog-error').textContent = 'Enter a valid non-negative deduction amount.';
    return;
  }
  const button = document.querySelector('#save-status');
  button.disabled = true;
  try {
    await apiWithPayrollConfirmation('/api/attendance', {
        employeeId: employee.id,
        date: activeDate,
        status,
        ...(deductionAmount === undefined ? {} : { deductionAmount }),
    }, 'PUT');
    dialog.close();
    await refreshMonthData();
    liveMessage.textContent = `${employee.name}'s attendance updated.`;
  } catch (error) {
    document.querySelector('#dialog-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#select-days-button').addEventListener('click', () => {
  selectedDates.clear();
  selectionMode = true;
  updateBulkControls();
  renderCalendar();
});
document.querySelector('#cancel-selection-button').addEventListener('click', () => {
  selectedDates.clear();
  selectionMode = false;
  updateBulkControls();
  renderCalendar();
});
document.querySelector('#apply-selected-button').addEventListener('click', () => {
  if (selectedDates.size) openBulkDialog([...selectedDates]);
});
document.querySelector('#bulk-range-button').addEventListener('click', () => openBulkDialog());
document.querySelector('#close-bulk-dialog').addEventListener('click', () => bulkDialog.close());
document.querySelector('#cancel-bulk-dialog').addEventListener('click', () => bulkDialog.close());
document.querySelector('#bulk-status').addEventListener('change', updateBulkDeductionControl);
document.querySelector('#bulk-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const employee = selectedEmployee();
  if (!employee || currentUser?.role !== 'owner') return;
  const warning = document.querySelector('#bulk-warning');
  const applyButton = document.querySelector('#bulk-apply-button');
  try {
    const dates = getBulkDates();
    if (!dates.length) throw new Error('Select at least one date.');
    const status = document.querySelector('#bulk-status').value;
    const deductionInput = document.querySelector('#bulk-deduction');
    const deductionAmount = employee.payType === 'monthly' && status === 'unpaid' && deductionInput.value !== ''
      ? Number(deductionInput.value)
      : undefined;
    if (deductionAmount !== undefined && (!Number.isFinite(deductionAmount) || deductionAmount < 0)) {
      throw new Error('Enter a valid non-negative deduction amount.');
    }
    const signature = JSON.stringify([dates, status, deductionAmount ?? null]);
    const existingCount = dates.filter((date) => entries[date]).length;
    if (existingCount && bulkConfirmationSignature !== signature) {
      bulkConfirmationSignature = signature;
      warning.textContent = `${existingCount} selected ${existingCount === 1 ? 'day already has' : 'days already have'} attendance. Apply again to replace ${existingCount === 1 ? 'it' : 'them'}.`;
      warning.classList.remove('hidden');
      applyButton.textContent = 'Confirm replacement';
      return;
    }
    warning.classList.add('hidden');
    applyButton.disabled = true;
    const result = await apiWithPayrollConfirmation('/api/attendance/bulk', {
        employeeId: employee.id,
        dates,
        status,
        ...(deductionAmount === undefined ? {} : { deductionAmount }),
    }, 'PUT');
    bulkDialog.close();
    if (pendingBulkDates) {
      selectedDates.clear();
      selectionMode = false;
    }
    bulkConfirmationSignature = '';
    await refreshMonthData();
    liveMessage.textContent = `Updated ${result.changedCount} ${result.changedCount === 1 ? 'day' : 'days'} for ${employee.name}.`;
  } catch (error) {
    warning.textContent = error.message;
    warning.classList.remove('hidden');
  } finally {
    applyButton.disabled = false;
  }
});

employeeSelect.addEventListener('change', async () => {
  selectedEmployeeId = employeeSelect.value;
  selectedDates.clear();
  selectionMode = false;
  creatingEmployee = false;
  try {
    await refreshMonthData();
    renderEmployeeForm();
    updateBulkControls();
  } catch (error) {
    liveMessage.textContent = error.message;
  }
});

employeeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.querySelector('#employee-submit');
  const message = document.querySelector('#employee-message');
  const wasEditing = Boolean(editingEmployeeId);
  button.disabled = true;
  showMessage(message, '');
  const payload = {
    name: document.querySelector('#employee-name').value.trim(),
    username: document.querySelector('#worker-username').value.trim(),
    password: document.querySelector('#worker-password').value,
    payType: payTypeInput.value,
    rate: Number(document.querySelector('#pay-rate').value),
    monthlyLeaveAllowance: Number(document.querySelector('#base-leave-allowance').value),
    allowanceThisMonth: Number(document.querySelector('#leave-allowance').value),
    month: monthKey(visibleDate),
  };
  try {
    const employee = editingEmployeeId
      ? await apiWithPayrollConfirmation(`/api/workers/${encodeURIComponent(editingEmployeeId)}`, payload, 'PATCH')
      : await apiWithPayrollConfirmation('/api/workers', payload);
    selectedEmployeeId = employee.id;
    document.querySelector('#worker-password').value = '';
    creatingEmployee = false;
    await refreshApp();
    showMessage(message, wasEditing ? 'Worker account updated.' : 'Worker account created.', false);
  } catch (error) {
    showMessage(message, error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#employee-cancel').addEventListener('click', () => {
  editingEmployeeId = '';
  creatingEmployee = true;
  renderEmployeeForm();
});

document.querySelector('#adjustment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.querySelector('#adjustment-message');
  showMessage(message, '');
  const payload = {
    month: monthKey(visibleDate),
    employeeId: document.querySelector('#adjustment-employee').value,
    type: document.querySelector('#adjustment-type').value,
    amount: Number(document.querySelector('#adjustment-amount').value),
    note: document.querySelector('#adjustment-note').value.trim(),
  };
  try {
    await apiWithPayrollConfirmation('/api/payroll/adjustments', payload);
    document.querySelector('#adjustment-amount').value = '';
    document.querySelector('#adjustment-note').value = '';
    await refreshMonthData();
    showMessage(message, 'Adjustment recorded.', false);
  } catch (error) {
    if (error.message !== 'Change cancelled.') showMessage(message, error.message);
  }
});

document.querySelector('#closure-type').addEventListener('change', (event) => {
  document.querySelector('#closure-repeat-control').classList.toggle('hidden', event.target.value !== 'weekly_off');
});
document.querySelector('#closure-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.querySelector('#closure-message');
  showMessage(message, '');
  const payload = {
    date: document.querySelector('#closure-date').value,
    label: document.querySelector('#closure-label').value.trim(),
    type: document.querySelector('#closure-type').value,
    payTreatment: document.querySelector('#closure-pay').value,
    repeatWeekly: document.querySelector('#closure-repeat').checked,
  };
  try {
    const result = await apiWithPayrollConfirmation('/api/closures', payload);
    document.querySelector('#closure-label').value = '';
    document.querySelector('#closure-repeat').checked = false;
    await refreshMonthData();
    showMessage(message, `Closure added for ${result.dates.length} ${result.dates.length === 1 ? 'date' : 'dates'}.`, false);
  } catch (error) {
    if (error.message !== 'Change cancelled.') showMessage(message, error.message);
  }
});

document.querySelector('#finalize-payroll-button').addEventListener('click', async () => {
  const month = monthKey(visibleDate);
  const reviewed = await confirmPayrollChange(
    `Confirm that you reviewed the payroll summary for ${month}. This records the finalization and reviewer. You can still edit later, but edits will be flagged and require you to finalize again.`,
  );
  if (!reviewed) return;
  try {
    await api('/api/payroll/finalize', { method: 'POST', body: JSON.stringify({ month }) });
    await refreshMonthData();
  } catch (error) {
    liveMessage.textContent = error.message;
  }
});

document.querySelector('#export-csv-button').addEventListener('click', downloadPayrollCsv);
document.querySelector('#print-report-button').addEventListener('click', () => {
  document.body.dataset.printView = 'payroll';
  window.print();
});
window.addEventListener('afterprint', () => delete document.body.dataset.printView);
document.querySelector('#payroll-confirm-form').addEventListener('submit', (event) => {
  event.preventDefault();
  resolvePayrollConfirmation(true);
});
document.querySelector('#cancel-payroll-confirm').addEventListener('click', () => resolvePayrollConfirmation(false));
document.querySelector('#close-payroll-confirm').addEventListener('click', () => resolvePayrollConfirmation(false));
document.querySelector('#payroll-confirm-dialog').addEventListener('close', () => {
  if (payrollConfirmResolve) resolvePayrollConfirmation(false);
});

document.querySelector('#currency-select').addEventListener('change', async (event) => {
  try {
    const result = await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ currency: event.target.value }) });
    currency = result.currency;
    updatePayTypeLabel();
    renderSummary();
  } catch (error) {
    liveMessage.textContent = error.message;
  }
});

payTypeInput.addEventListener('change', updatePayTypeLabel);
themeToggles.forEach((toggle) => {
  toggle.addEventListener('click', () => setTheme(document.documentElement.dataset.theme !== 'dark'));
});

document.querySelector('#history-details').addEventListener('toggle', async (event) => {
  if (!event.currentTarget.open || !currentUser) return;
  try { await refreshMonthData(); } catch (error) { liveMessage.textContent = error.message; }
});

setTheme(localStorage.getItem('daymark-theme') === 'dark');
startApp().catch((error) => {
  console.error(error);
  showLogin(error.message);
});
