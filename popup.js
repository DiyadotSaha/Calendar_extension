console.log('[popup] script loaded');
document.addEventListener('DOMContentLoaded', () => {
  console.log('[popup] DOM ready');
});

/******************
 * Helpers
 ******************/
const $ = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, "0");

function buildLocalDate(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [Y, M, D] = dateStr.split("-").map(Number);
  const [h, m] = timeStr.split(":").map(Number);
  return new Date(Y, M - 1, D, h, m, 0, 0); // local time
}
function toISO(d) { return d.toISOString(); }
function addMinutes(d, mins) { return new Date(d.getTime() + mins * 60000); }
function minutesBetween(a, b) { return Math.round((b - a) / 60000); }
function toTimeStr(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

const todoStatusEl = document.getElementById('todoStatus');
function flashTodo(msg, cls = 'ok') {
  if (!todoStatusEl) return;
  todoStatusEl.className = `hint ${cls}`; // cls can be 'ok' or 'err'
  todoStatusEl.textContent = msg;
  // Optional auto-clear after a few seconds:
  // setTimeout(() => { todoStatusEl.textContent = ''; todoStatusEl.className = 'hint'; }, 4000);
}
function notifyOnTodos(msg, cls = 'ok') {
  // Ensure the To-Dos tab is visible and show the message there
  showTab('todos');
  flashTodo(msg, cls);
}
function isEventGone(resp) {
  if (!resp) return false;
  if (resp.code === 404 || resp.code === 410) return true;

  const s = typeof resp.error === 'string'
    ? resp.error
    : JSON.stringify(resp.error || resp || '');

  // put the regex in a const to avoid any parser confusion
  const goneRe = /(?:\b404\b|\b410\b|"reason"\s*:\s*"(?:notFound|deleted)")/i;
  return goneRe.test(s);
}



/******************
 * Elements (Schedule tab)
 ******************/
const titleEl     = $('title');
const dateEl      = $('date');
const startEl     = $('startTime');
const endEl       = $('endTime');
const durationEl  = $('duration');
const notesEl     = $('notes');
const statusEl    = $('status');

// Optional: Section + color (if present in HTML)
const sectionInput = $('sectionInput');
const sectionList  = $('sectionList');
const paletteEl    = $('colorPalette');
const colorIdEl    = $('colorId');

let fpStart, fpEnd, fpDate;

document.addEventListener('DOMContentLoaded', () => {
  if (window.flatpickr) {
    fpDate = flatpickr('#date', {
      dateFormat: 'Y-m-d',
      altInput: true,        
      altFormat: 'm-d-Y',   
      defaultDate: new Date()
    });

    fpStart = flatpickr('#startTime', {
      enableTime: true,
      noCalendar: true,
      minuteIncrement: 5,
      time_24hr: false,
      dateFormat: 'H:i',     // underlying
      altInput: true,
      altFormat: 'h:i K'
    });

    fpEnd = flatpickr('#endTime', {
      enableTime: true,
      noCalendar: true,
      minuteIncrement: 5,
      time_24hr: false,
      dateFormat: 'H:i',
      altInput: true,
      altFormat: 'h:i K'
    });
  }
});



/******************
 * Defaults for Schedule tab
 ******************/
(function initScheduleDefaults(){
  if (dateEl) {
    const now = new Date();
    const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    //if (!dateEl.value) dateEl.value = today;
    fpDate?.setDate(new Date(), true);

  }

  if (startEl && endEl && durationEl) {
    const now = new Date();
    const rounded = new Date(Math.ceil(now.getTime() / (5 * 60000)) * (5 * 60000));
    if (!startEl.value) startEl.value = toTimeStr(rounded);
    const mins = parseInt(durationEl.value || '60', 10);
    const end = addMinutes(rounded, Number.isFinite(mins) && mins > 0 ? mins : 60);
    if (!endEl.value) endEl.value = toTimeStr(end);
  }
})();

/******************
 * Time syncing
 ******************/
let syncing = false;

function syncFromDuration() {
  if (syncing) return; syncing = true;
  try {
    const start = buildLocalDate(dateEl.value, startEl.value);
    const mins = parseInt(durationEl.value || '', 10);
    if (start && Number.isFinite(mins) && mins > 0) {
      const end = addMinutes(start, mins);
      if (fpEnd) fpEnd.setDate(end, true);     // updates both real + alt input
      else endEl.value = toTimeStr(end);
    }
  } finally { syncing = false; }
}

function syncFromEnd() {
  if (syncing) return; syncing = true;
  try {
    const start = buildLocalDate(dateEl.value, startEl.value);
    const end   = buildLocalDate(dateEl.value, endEl.value);
    if (start && end && end > start) {
      durationEl.value = Math.max(1, minutesBetween(start, end));
    }
  } finally { syncing = false; }
}

function ensureEndAfterStartOnDateChange() {
  const start = buildLocalDate(dateEl.value, startEl.value);
  const end   = buildLocalDate(dateEl.value, endEl.value);
  if (start && end && end <= start) {
    const mins = parseInt(durationEl.value || '60', 10);
    const next = addMinutes(start, Number.isFinite(mins) && mins > 0 ? mins : 60);
    if (fpEnd) fpEnd.setDate(next, true);
    else endEl.value = toTimeStr(next);
  }
}

durationEl?.addEventListener('input', syncFromDuration);
endEl?.addEventListener('input', syncFromEnd);
startEl?.addEventListener('input', syncFromDuration);
dateEl?.addEventListener('input', ensureEndAfterStartOnDateChange);

/******************
 * Sections & Colors (chrome.storage.sync)
 ******************/
let sectionsCache = [];
let sectionColorMap = {};
let defaultColorId = '11'; // nice blue

async function loadSectionState() {
  if (!sectionInput || !sectionList) return;

  const { sections, sectionColorMap: map, defaultColorId: defId } =
    await chrome.storage.sync.get(['sections', 'sectionColorMap', 'defaultColorId']);

  // caches
  const LIMIT = (typeof SECTION_LIMIT === 'number' ? SECTION_LIMIT : 8);
  sectionsCache = Array.isArray(sections) ? [...new Set(sections)] : [];
  sectionsCache = sectionsCache.slice(0, LIMIT); // MRU cap
  sectionColorMap = map || {};
  defaultColorId  = defId || '11';

  // Rebuild datalist via your helper
  if (typeof renderSectionDatalist === 'function') {
    renderSectionDatalist();
  } else {
    // Fallback (shouldn’t run if you added the helper)
    sectionList.innerHTML = '';
    sectionsCache.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      sectionList.appendChild(opt);
    });
  }

  // Initialize palette selection (prefer current section, else default)
  if (paletteEl && colorIdEl) {
    const current = (sectionInput.value || '').trim();
    const cid = current ? (sectionColorMap[current] || defaultColorId) : defaultColorId;
    setSelectedColor(cid);
  }

  // If you have chips, refresh them too
  if (typeof renderSectionChips === 'function') {
    renderSectionChips();
  }
}


const SECTION_LIMIT = 8;

function renderSectionDatalist() {
  if (!sectionList) return;
  sectionList.innerHTML = '';
  sectionsCache.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    sectionList.appendChild(opt);
  });
}

function syncSectionUI() {
  renderSectionDatalist();
  if (typeof renderSectionChips === 'function') renderSectionChips();
}

/** Move name to the front, de-dup, cap to 8, persist, re-render */
function touchSectionMRU(name) {
  const n = (name || '').trim();
  if (!n) return;
  sectionsCache = [n, ...sectionsCache.filter(x => x !== n)].slice(0, SECTION_LIMIT);
  chrome.storage.sync.set({ sections: sectionsCache });
  syncSectionUI();
}


function setSelectedColor(id) {
  if (!paletteEl || !colorIdEl) return;
  [...paletteEl.querySelectorAll('button')].forEach(btn => {
    btn.setAttribute('aria-selected', btn.dataset.colorid === String(id) ? 'true' : 'false');
  });
  colorIdEl.value = String(id);
}
paletteEl?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-colorid]');
  if (!btn) return;
  setSelectedColor(btn.dataset.colorid);

  // If a section name is present, bind this color to that section
  if (sectionInput) {
    const name = (sectionInput.value || '').trim();
    if (name) {
      sectionColorMap[name] = colorIdEl.value;
      chrome.storage.sync.set({ sectionColorMap }); // persist mapping
      touchSectionMRU(name); // ← updates, persists, and re-renders the 8 suggestions
    } else {
      // No section typed -> set default color
      defaultColorId = colorIdEl.value;
      chrome.storage.sync.set({ defaultColorId });
    }
  }
  
});
sectionInput?.addEventListener('input', () => {
  const name = (sectionInput.value || '').trim();
  const cid = name ? (sectionColorMap[name] || defaultColorId) : defaultColorId;
  setSelectedColor(cid);
});
loadSectionState();

/******************
 * Create Calendar Event -> also add to Today's To-Dos
 ******************/
function keyForDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `todos_${yyyy}-${mm}-${dd}`;
}

/******************
 * Create Calendar Event -> also add to the Event-Day To-Dos
 ******************/
const createBtn = $('create');
createBtn?.addEventListener('click', async () => {
  statusEl.textContent = '';

  const title = (titleEl?.value || '').trim();
  if (!title) { statusEl.textContent = 'Title is required.'; return; }

  const start = buildLocalDate(dateEl?.value, startEl?.value);
  if (!start) { statusEl.textContent = 'Please select a Date and Start time.'; return; }

  let end  = buildLocalDate(dateEl?.value, endEl?.value);
  let mins = parseInt(durationEl?.value || '', 10);

  // Derive end from duration if needed
  if (!(end && end > start) && Number.isFinite(mins) && mins > 0) {
    end = addMinutes(start, mins);
    // If using Flatpickr with altInput, update via setDate; else fallback
    if (typeof fpEnd?.setDate === 'function') fpEnd.setDate(end, true);
    else if (endEl) endEl.value = toTimeStr(end);
  }
  // Keep duration in sync if end is valid
  if (end && end > start) {
    mins = minutesBetween(start, end);
    if (durationEl) durationEl.value = mins;
  }
  if (!end || !(end > start)) {
    statusEl.textContent = 'End time must be after Start time.';
    return;
  }

  // Resolve colorId from section or default to '7' if no section
  let colorIdToUse = colorIdEl?.value || '';
  const sectionName = (sectionInput?.value || '').trim();
  if (sectionName) {
    if (!sectionsCache.includes(sectionName)) sectionsCache.push(sectionName);
    sectionColorMap[sectionName] =
      colorIdToUse || sectionColorMap[sectionName] || defaultColorId || '7';
    await chrome.storage.sync.set({ sections: sectionsCache, sectionColorMap });
    colorIdToUse = sectionColorMap[sectionName];

    // MRU bump (non-blocking is fine)
    touchSectionMRU?.(sectionName);
  } else {
    colorIdToUse = '7';
  }

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const startISO = toISO(start);
  const endISO   = toISO(end);

  statusEl.textContent = 'Creating event…';

  chrome.runtime.sendMessage(
    {
      type: 'CREATE_EVENT',
      payload: {
        title,
        startISO,
        endISO,
        notes: (notesEl?.value || '').trim(),
        timeZone: tz,
        colorId: colorIdToUse || undefined,
        section: sectionName || ''
      }
    },
    async (resp) => {
      statusEl.textContent = resp?.ok ? 'Event successfully created!' : `${resp?.error || 'Failed to create event'}`;
      if (!resp?.ok) return;

      // --- Add to the EVENT-DAY to-dos (not always "today") ---
      const event = resp.data;
      const eventId = event.id;
      const listKey = keyForDate(start); // store under event date

      const data = await chrome.storage.sync.get([listKey]);
      const items = Array.isArray(data[listKey]) ? data[listKey] : [];
      items.push({
        title,
        done: false,
        ts: Date.now(),
        eventId,
        originalColorId: colorIdToUse || ''
      });
      await chrome.storage.sync.set({ [listKey]: items });

      // Refresh UI only if the event is for today
      if (listKey === todayKey()) {
        renderTodos(items);
        notifyOnTodos?.('Added to today’s list');
      } else {
        // Optional heads-up
        const shownDate = dateEl?.value || '';
        notifyOnTodos?.(`Added to ${shownDate} to-dos`);
      }

      // Clear inputs
      if (titleEl) titleEl.value = '';
      if (notesEl) notesEl.value = '';
    }
  );
});


/******************
 * Tabs (Schedule | Today)
 ******************/
const tabBtnSchedule = $('tabbtn-schedule');
const tabBtnTodos    = $('tabbtn-todos');
const tabSchedule    = $('tab-schedule');
const tabTodos       = $('tab-todos');

function showTab(name) {
  const isSched = name === 'schedule';
  tabBtnSchedule?.setAttribute('aria-selected', String(isSched));
  tabBtnTodos?.setAttribute('aria-selected', String(!isSched));
  if (tabSchedule) tabSchedule.hidden = !isSched;
  if (tabTodos)    tabTodos.hidden    = isSched;
}
tabBtnSchedule?.addEventListener('click', () => showTab('schedule'));
tabBtnTodos?.addEventListener('click', () => showTab('todos'));
showTab('schedule'); // default tab

/******************
 * Today To-Dos  (date-scoped, midnight reset handled in background.js)
 ******************/
const todoInput = $('todoInput');
const todoList  = $('todoList');
const todoEmpty = $('todoEmpty');
const btnClearCompleted = $('clearCompleted');

// ---- Notify controls (declare them HERE, not earlier) ----
const notifyEnabledEl = document.getElementById('notifyEnabled');
const notifyEmailEl   = document.getElementById('notifyEmail');

function todayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `todos_${yyyy}-${mm}-${dd}`;
}

async function loadTodos() {
  if (!todoList) return;
  const key = todayKey();
  const data = await chrome.storage.sync.get([key]);
  const items = Array.isArray(data[key]) ? data[key] : [];
  renderTodos(items);
}
async function saveTodos(items) {
  const key = todayKey();
  await chrome.storage.sync.set({ [key]: items });
}

// ----- Notify settings persistence (functions can be here) -----
async function loadNotifySettings() {
  const { notifyEnabled = false, notifyEmail = '' } =
    await chrome.storage.sync.get(['notifyEnabled', 'notifyEmail']);
  if (notifyEnabledEl) notifyEnabledEl.checked = !!notifyEnabled;
  if (notifyEmailEl)   notifyEmailEl.value = notifyEmail || '';
}
function validEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

async function saveNotifySettings() {
  const enabled = !!notifyEnabledEl?.checked;
  const email   = (notifyEmailEl?.value || "").trim();
  const status  = document.getElementById("notifyStatus");

  // Optimistically save UI state
  await chrome.storage.sync.set({ notifyEnabled: enabled, notifyEmail: email });

  if (!enabled) {
    // Turning OFF — ask background to unregister and email a goodbye
    chrome.runtime.sendMessage({ type: "NOTIFY_TOGGLE", enabled: false, email }, (resp) => {
      if (resp?.ok) {
        if (status) { status.textContent = "☑︎ Email unregistered."; status.className = "hint ok"; }
      } else {
        if (status) { status.textContent = `Could not unregister: ${resp?.error || "Unknown error"}`; status.className = "hint err"; }
      }
    });
    return;
  }

  // Turning ON — validate email then register + send welcome
  if (!email || !validEmail(email)) {
    if (status) { status.textContent = "Please enter a valid email."; status.className = "hint err"; }
    return;
  }

  chrome.runtime.sendMessage({ type: "NOTIFY_TOGGLE", enabled: true, email }, (resp) => {
    if (resp?.ok) {
      if (status) { status.textContent = "Email registered — nightly summaries enabled."; status.className = "hint ok"; }
    } else {
      if (status) { status.textContent = `Could not register: ${resp?.error || "Unknown error"}`; status.className = "hint err"; }
    }
  });
}

async function sendWelcomeEmail(to) {
  const subject = "📬 Notifications Enabled";
  const body = `You've successfully registered for notifications.
You'll receive an email at midnight with your unfinished tasks.`;

  await gmailSend({ to, subject, text: body });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'CREATE_EVENT': {
          const data = await createCalendarEvent(msg.payload);
          sendResponse({ ok: true, data });
          break;
        }
        case 'TOGGLE_DONE': {
          const data = await toggleEventDone(msg.payload);
          sendResponse({ ok: true, data });
          break;
        }
        case 'EMAIL_UNFINISHED_NOW': {
          await emailUnfinishedNow();
          sendResponse({ ok: true });
          break;
        }
        case 'SEND_WELCOME_EMAIL': { // <-- important
          const { notifyEnabled = false, notifyEmail = '' } =
            await chrome.storage.sync.get(['notifyEnabled', 'notifyEmail']);
          const email = (msg.email || '').trim();
          if (!notifyEnabled || !email || email !== (notifyEmail || '').trim()) {
            sendResponse({ ok: false, error: 'Notifications not enabled for this email.' });
            break;
          }
          const { _welcomeSentFor = '' } = await chrome.storage.sync.get(['_welcomeSentFor']);
          if (_welcomeSentFor === email) { sendResponse({ ok: true }); break; }
          await sendWelcomeEmail(email);
          sendResponse({ ok: true });
          break;
        }
        default:
          // Don’t reply with "unknown" if another listener might handle it.
          // But if this is your only router, keep the line below.
          sendResponse({ ok: false, error: 'Unknown message' });
      }
    } catch (e) {
      console.error('[background] router error:', e);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // keep channel open for async
});



// Add free-text todo via Enter (no calendar link)
function renderTodos(items) {
  if (!todoList) return;

  // Local notifier: prefer notifyOnTodos() if present, else fall back to statusEl.
  const notify = (msg, cls = 'ok') => {
    if (typeof notifyOnTodos === 'function') {
      notifyOnTodos(msg, cls); // pops To-Dos tab + flash
    } else {
      // graceful fallback
      if (typeof showTab === 'function') showTab('todos');
      if (typeof flashTodo === 'function') flashTodo(msg, cls);
      else if (statusEl) {
        statusEl.textContent = msg;
        statusEl.className = `hint ${cls}`;
      }
    }
  };

  // (Re)draw list
  todoList.innerHTML = '';
  const isEmpty = !Array.isArray(items) || items.length === 0;
  if (todoEmpty) todoEmpty.hidden = !isEmpty;
  if (isEmpty) return;

  items.forEach((t, idx) => {
    const row = document.createElement('div');
    row.className = `todo-row ${t.done ? 'done' : ''}`;
    row.setAttribute('role', 'listitem');

    // Checkbox
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!t.done;
    cb.setAttribute('aria-label', t.title || 'Task');

    cb.addEventListener('change', async () => {
      const nextDone = cb.checked;
      const prevDone = !!t.done;

      // optimistic update
      t.done = nextDone;
      await saveTodos(items);

      // reflect on Calendar if linked
      if (t.eventId) {
        chrome.runtime.sendMessage(
          {
            type: 'TOGGLE_DONE',
            payload: {
              eventId: t.eventId,
              done: nextDone,
              originalTitle: t.title,
              originalColorId: t.originalColorId || null
            }
          },
          (resp) => {
            if (!resp?.ok) {
              // rollback on failure
              t.done = prevDone;
              cb.checked = prevDone;
              saveTodos(items).then(() => renderTodos(items));
              notify(`Could not update Calendar: ${resp?.error || 'Unknown error'}`, 'err');
            } else {
              notify(nextDone
                ? 'Marked done (synced to Calendar)'
                : 'Marked not done (synced to Calendar)'
              );
            }
          }
        );
      } else {
        notify(nextDone ? '✓ Marked done (local only)' : '↩️ Marked not done (local only)');
      }
    });

    // Title
    const title = document.createElement('div');
    title.className = 'todo-title';
    title.textContent = t.title;

    // Actions
    const actions = document.createElement('div');
    actions.className = 'todo-actions';

    // Delete button (event-aware)
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Delete';

    del.addEventListener('click', async () => {
      const item = items[idx];

      if (item.eventId) {
        chrome.runtime.sendMessage(
          { type: 'DELETE_EVENT', payload: { eventId: item.eventId } },
          async (resp) => {
            if (resp?.ok || isEventGone(resp)) {
              // Event deleted or already gone — remove locally
              items.splice(idx, 1);
              await saveTodos(items);
              renderTodos(items);
              notify('Task deleted');
            } else {
              notify(`Could not delete Calendar event: ${resp?.error || 'Unknown error'}`, 'err');
            }
          }
        );
      } else {
        // Local-only task
        items.splice(idx, 1);
        await saveTodos(items);
        renderTodos(items);
        notify('Task deleted');
      }
});


    actions.appendChild(del);

    row.appendChild(cb);
    row.appendChild(title);
    row.appendChild(actions);
    todoList.appendChild(row);
  });
}

todoInput?.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const title = todoInput.value.trim();
    if (!title) return;
    const key = todayKey();
    const data = await chrome.storage.sync.get([key]);
    const items = Array.isArray(data[key]) ? data[key] : [];
    items.push({ title, done: false, ts: Date.now() }); // no eventId
    await saveTodos(items);
    todoInput.value = '';
    renderTodos(items);
  }
});

btnClearCompleted?.addEventListener('click', async () => {
  const key = todayKey();
  const data = await chrome.storage.sync.get([key]);
  const items = Array.isArray(data[key]) ? data[key] : [];

  // End-of-day rule: DO NOT delete Calendar events here.
  // We only clear completed local tasks for the next day.
  const remaining = items.filter(t => !t.done);
  await saveTodos(remaining);
  renderTodos(remaining);

  notifyOnTodos('Cleared completed tasks for tomorrow.');
});

// Notify listeners
notifyEnabledEl?.addEventListener('change', saveNotifySettings);
notifyEmailEl?.addEventListener('change', saveNotifySettings);
notifyEmailEl?.addEventListener('blur',   saveNotifySettings);

// Initial loads
loadTodos();
loadNotifySettings();
