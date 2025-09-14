// ===== Time helpers =====
function parseLocalDateTime(inputValue) {
    // Safe parse "YYYY-MM-DDTHH:MM" as LOCAL time (no timezone surprises)
    if (!inputValue) return null;
    const [d, t = "00:00"] = inputValue.split("T");
    const [Y, M, D] = d.split("-").map(Number);
    const [h, m] = t.split(":").map(Number);
    return new Date(Y, (M - 1), D, h, m, 0, 0); // local date
  }
  
  function toLocalInputValue(date) {
    if (!date) return "";
    const pad = (n) => String(n).padStart(2, "0");
    const Y = date.getFullYear();
    const M = pad(date.getMonth() + 1);
    const D = pad(date.getDate());
    const h = pad(date.getHours());
    const m = pad(date.getMinutes());
    return `${Y}-${M}-${D}T${h}:${m}`;
  }
  
  function minutesBetween(a, b) {
    return Math.round((b.getTime() - a.getTime()) / 60000);
  }
  
  function addMinutes(date, mins) {
    return new Date(date.getTime() + mins * 60000);
  }
  
  function toISOWithTZ(date) {
    // Calendar accepts dateTime + timeZone; we still send ISO for consistency
    return date.toISOString();
  }
  
// ===== Helpers =====
const $ = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, "0");
function buildLocalDate(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [Y, M, D] = dateStr.split("-").map(Number);
  const [h, m]   = timeStr.split(":").map(Number);
  return new Date(Y, M - 1, D, h, m, 0, 0);
}
function toISO(d) { return d.toISOString(); }
function addMinutes(d, mins) { return new Date(d.getTime() + mins * 60000); }
function minutesBetween(a, b) { return Math.round((b - a) / 60000); }
function toTimeStr(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

// ===== Elements =====
const titleEl     = $('title');
const dateEl      = $('date');
const startEl     = $('startTime');
const endEl       = $('endTime');
const durationEl  = $('duration');
const notesEl     = $('notes');
const statusEl    = $('status');

// New elements
const sectionInput = $('sectionInput');
const sectionList  = $('sectionList');
const paletteEl    = $('colorPalette');
const colorIdEl    = $('colorId');

// ===== Defaults (date/time) =====
(function initDefaults(){
  const now = new Date();
  const today = `${now.getFullYear()}-${pad2(now.getMonth()+1)}-${pad2(now.getDate())}`;
  dateEl.value = today;
  const rounded = new Date(Math.ceil(now.getTime() / (5*60000)) * (5*60000));
  startEl.value = toTimeStr(rounded);
  const mins = parseInt(durationEl.value || '60', 10);
  endEl.value = toTimeStr(addMinutes(rounded, Number.isFinite(mins) && mins > 0 ? mins : 60));
})();

// ===== Time sync =====
let syncing = false;
function syncFromDuration() {
  if (syncing) return; syncing = true;
  try {
    const start = buildLocalDate(dateEl.value, startEl.value);
    const mins = parseInt(durationEl.value || '', 10);
    if (start && Number.isFinite(mins) && mins > 0) endEl.value = toTimeStr(addMinutes(start, mins));
  } finally { syncing = false; }
}
function syncFromEnd() {
  if (syncing) return; syncing = true;
  try {
    const start = buildLocalDate(dateEl.value, startEl.value);
    const end   = buildLocalDate(dateEl.value, endEl.value);
    if (start && end && end > start) durationEl.value = Math.max(1, minutesBetween(start, end));
  } finally { syncing = false; }
}
function ensureEndAfterStartOnDateChange() {
  const start = buildLocalDate(dateEl.value, startEl.value);
  const end   = buildLocalDate(dateEl.value, endEl.value);
  if (start && end && end <= start) {
    const mins = parseInt(durationEl.value || '60', 10);
    endEl.value = toTimeStr(addMinutes(start, Number.isFinite(mins) && mins > 0 ? mins : 60));
  }
}
durationEl.addEventListener('input', syncFromDuration);
endEl.addEventListener('input', syncFromEnd);
startEl.addEventListener('input', syncFromDuration);
dateEl.addEventListener('input', ensureEndAfterStartOnDateChange);

// ===== Sections & Colors (persist in chrome.storage.sync) =====
async function loadSectionState() {
  const data = await chrome.storage.sync.get(['sections', 'sectionColorMap', 'defaultColorId']);
  const sections = Array.isArray(data.sections) ? data.sections : [];
  const map = data.sectionColorMap || {};
  const defaultColorId = data.defaultColorId || '9'; // a nice blue

  // Populate datalist
  sectionList.innerHTML = '';
  sections.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    sectionList.appendChild(opt);
  });

  // Initialize color selection
  setSelectedColor(data.defaultColorId || '9');

  // If user types/selects a known section later, we’ll auto-apply its saved color.
  return { sections, map, defaultColorId };
}

// track current mapping in memory (updated on changes)
let sectionsCache = [];
let sectionColorMap = {};
let defaultColorId = '9';

function setSelectedColor(id) {
  // update palette UI and hidden input
  [...paletteEl.querySelectorAll('button')].forEach(btn => {
    btn.setAttribute('aria-selected', btn.dataset.colorid === String(id) ? 'true' : 'false');
  });
  colorIdEl.value = String(id);
}

// Handle palette clicks
paletteEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-colorid]');
  if (!btn) return;
  setSelectedColor(btn.dataset.colorid);

  // If a section is filled, update its color mapping immediately
  const name = (sectionInput.value || '').trim();
  if (name) {
    sectionColorMap[name] = colorIdEl.value;
    if (!sectionsCache.includes(name)) sectionsCache.push(name);
    chrome.storage.sync.set({ sections: sectionsCache, sectionColorMap });
    // also refresh datalist if this is a new section
    if (![...sectionList.options].some(o => o.value === name)) {
      const opt = document.createElement('option'); opt.value = name; sectionList.appendChild(opt);
    }
  } else {
    // No section typed -> treat as default color for new sections
    defaultColorId = colorIdEl.value;
    chrome.storage.sync.set({ defaultColorId });
  }
});

// When the user types/picks a section, load its saved color (or default)
sectionInput.addEventListener('input', () => {
  const name = (sectionInput.value || '').trim();
  if (!name) { setSelectedColor(defaultColorId); return; }
  const cid = sectionColorMap[name] || defaultColorId;
  setSelectedColor(cid);
});

// Load sections on open
loadSectionState().then(({ sections, map, defaultColorId: def }) => {
  sectionsCache = sections;
  sectionColorMap = map;
  defaultColorId = def;
});

// ===== Create event =====
$('create').addEventListener('click', async () => {
  statusEl.textContent = '';

  const title = titleEl.value.trim();
  if (!title) { statusEl.textContent = 'Title is required.'; return; }

  const start = buildLocalDate(dateEl.value, startEl.value);
  if (!start) { statusEl.textContent = 'Please select a Date and Start time.'; return; }

  let end   = buildLocalDate(dateEl.value, endEl.value);
  let mins  = parseInt(durationEl.value || '', 10);

  if (!(end && end > start) && Number.isFinite(mins) && mins > 0) {
    end = addMinutes(start, mins);
    endEl.value = toTimeStr(end);
  }
  if (end && end > start) {
    mins = minutesBetween(start, end);
    durationEl.value = mins;
  }
  if (!end || !(end > start)) {
    statusEl.textContent = 'End time must be after Start time.';
    return;
  }

  // Resolve section & colorId to send
  const sectionName = (sectionInput.value || '').trim();
  let colorIdToUse = colorIdEl.value || '';
  if (sectionName) {
    // ensure section is tracked & color saved
    if (!sectionsCache.includes(sectionName)) sectionsCache.push(sectionName);
    sectionColorMap[sectionName] = colorIdToUse || sectionColorMap[sectionName] || defaultColorId;
    await chrome.storage.sync.set({ sections: sectionsCache, sectionColorMap });
    colorIdToUse = sectionColorMap[sectionName];
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
        notes: notesEl.value.trim(),
        timeZone: tz,
        colorId: colorIdToUse || undefined, // only include if set
        section: sectionName || ''
      }
    },
    (resp) => {
      statusEl.textContent = resp?.ok ? '✅ Event created!' : `❌ ${resp?.error || 'Failed to create event'}`;
      if (resp?.ok) {
        titleEl.value = '';
        notesEl.value = '';
      }
    }
  );
});
