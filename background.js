
// OAuth
function toBase64Url(str) {
  // UTF-8 safe Base64URL (no padding)
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function rfc2822Date(d = new Date()) {
  // E.g., "Fri, 12 Sep 2025 12:34:56 -0700"
  const day = d.toUTCString().slice(0, 3);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mon = d.toUTCString().slice(8, 11);
  const yyyy = d.getUTCFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const tz = (d.getTimezoneOffset() / -60);
  const sign = tz >= 0 ? '+' : '-';
  const tzh = String(Math.floor(Math.abs(tz))).padStart(2, '0');
  const tzm = String(Math.abs(d.getTimezoneOffset()) % 60).padStart(2, '0');
  return `${day}, ${dd} ${mon} ${yyyy} ${hh}:${mm}:${ss} ${sign}${tzh}${tzm}`;
}

function buildMime({ from, to, subject, text }) {
  // Minimal, standards-friendly plain text message
  return [
    `From: taskadealerts@gmail.com`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${rfc2822Date()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',                                   // blank line before body
    text || ''
  ].join('\r\n');
}

// Get the signed-in user's email to use in From:
async function getUserEmail() {
  return new Promise((resolve) => {
    // Requires "identity" and "identity.email" in manifest permissions
    chrome.identity.getProfileUserInfo?.(info => resolve(info?.email || 'me'));
  });
}
async function removeCachedToken(token) {
  return new Promise((resolve) =>
    chrome.identity.removeCachedAuthToken({ token }, () => resolve())
  );
}
async function getAccessTokenInteractive() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (t) => {
      if (!t) return reject(chrome.runtime.lastError || new Error('No token'));
      resolve(t);
    });
  });
}

async function verifyScopes(token) {
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=' + token);
    const info = await r.json();
    console.log('TOKEN SCOPES:', info.scope);
  } catch (e) {
    console.warn('tokeninfo failed', e);
  }
}

// Gmail: send (gmail.send scope required)
async function gmailSend({ to, subject, text }) {
  const fromEmail = await getUserEmail(); // e.g., "abc@domain.com"
  const mime = buildMime({ from: fromEmail, to, subject, text });
  const raw = toBase64Url(mime);

  let token = await getAccessTokenInteractive();
  // Optional but useful while debugging:
  verifyScopes(token).catch(() => {});

  let res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw })
  });

  let body;
  try { body = await res.json(); } catch { body = { note: 'No JSON body' }; }
  console.log('SEND status', res.status, body);

  // Handle expired/invalid token quickly
  if (res.status === 401) {
    await removeCachedToken(token);
    token = await getAccessTokenInteractive();
    verifyScopes(token).catch(() => {});
    res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw })
    });
    try { body = await res.json(); } catch { body = { note: 'No JSON body' }; }
    console.log('SEND retry status', res.status, body);
  }

  if (!res.ok) {
    // Surface precise causes:
    //  - 403 + insufficientPermissions  -> missing gmail.send (re-consent/admin trust)
    //  - 403 + fromAddressNotOwned      -> alias not verified for abc
    //  - 403 + accessNotConfigured      -> Gmail API not enabled in this project
    //  - 400 + invalidArgument          -> malformed MIME
    throw new Error(`gmail.send ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function sendWelcomeEmail(to) {
  const subject = "Taskade: Notifications enabled";
  const body = `You're subscribed!  
  I'll email you a summary of your unfinished tasks each night.

  Remember: progress is progress, even if it's just one small step.  
  You've got this!\n\nBest Regards, \nTaskade`;
  return gmailSend({ to, subject, text: body });
}

async function sendGoodbyeEmail(to) {
  const subject = "Taskade: Notifications disabled";
  const body = `You've unsubscribed from nightly task reminders.  
  Even without me, remember:  
  Every day is a new opportunity to reset, refocus, and try again.\n\nBest Regards, \nTaskade`;
  return gmailSend({ to, subject, text: body }); 
}
/******************
 * Calendar: create event
 ******************/
async function createCalendarEvent({ title, startISO, endISO, notes, timeZone, colorId, calendarId = 'primary' }) {
  let token = await getAccessTokenInteractive();
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const body = {
    summary: title,
    description: notes || '',
    start: { dateTime: startISO, timeZone: tz },
    end:   { dateTime: endISO,   timeZone: tz },
    ...(colorId ? { colorId: String(colorId) } : {})
  };

  let res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  // retry once if token stale
  if (res.status === 401) {
    await new Promise((r) => chrome.identity.getAuthToken({ interactive: false }, (t) => {
      if (t) chrome.identity.removeCachedAuthToken({ token: t }, r); else r();
    }));
    token = await getAccessTokenInteractive();
    res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`calendar.create ${res.status}: ${text}`);
  }
  return res.json();
}

/******************
 * Calendar: toggle done (prefix check & grey, non-blocking)
 ******************/
async function toggleEventDone({ eventId, done, originalTitle, originalColorId, calendarId = 'primary' }) {
  let token = await getAccessTokenInteractive();

  const patchBody = done
    ? { summary: `✓ ${originalTitle}`, colorId: '8', transparency: 'transparent' }
    : {
        summary: originalTitle,
        ...(originalColorId ? { colorId: String(originalColorId) } : { colorId: null }),
        transparency: 'opaque'
      };

  let res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(patchBody)
    }
  );

  if (res.status === 401) {
    await new Promise((r) => chrome.identity.getAuthToken({ interactive: false }, (t) => {
      if (t) chrome.identity.removeCachedAuthToken({ token: t }, r); else r();
    }));
    token = await getAccessTokenInteractive();
    res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(patchBody)
      }
    );
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`calendar.patch ${res.status}: ${text}`);
  }
  return res.json();
}
//delete functionality 
// Calendar: delete event
async function deleteCalendarEvent({ eventId, calendarId = 'primary' }) {
  if (!eventId) return { deleted: false, notFound: true };

  let token = await getAccessTokenInteractive();
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;

  let res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  // retry once on stale token
  if (res.status === 401) {
    await new Promise((r) => chrome.identity.getAuthToken({ interactive: false }, (t) => {
      if (t) chrome.identity.removeCachedAuthToken({ token: t }, r); else r();
    }));
    token = await getAccessTokenInteractive();
    res = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
  }

  // Google Calendar returns 204 No Content on success
  if (res.status === 204) return { deleted: true };
  if (res.status === 404) return { deleted: false, notFound: true };

  const text = await res.text().catch(() => '');
  throw new Error(`calendar.delete ${res.status}: ${text}`);
}


/******************
 * Manual “email unfinished now”
 ******************/
async function emailUnfinishedNow() {
  const { notifyEnabled = false, notifyEmail = '' } =
    await chrome.storage.sync.get(['notifyEnabled', 'notifyEmail']);
  if (!notifyEnabled || !notifyEmail) return;

  const all = await chrome.storage.sync.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith('todos_'));
  const unfinished = [];
  for (const k of keys) {
    const items = Array.isArray(all[k]) ? all[k] : [];
    for (const it of items) if (!it.done && it.title) unfinished.push(`• ${it.title}`);
  }
  if (!unfinished.length) return;

  await gmailSend({
    to: notifyEmail,
    subject: `Unfinished tasks (${new Date().toLocaleString()})`,
    text: unfinished.join('\n')
  });
}

// Message router
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'CREATE_EVENT': {
          const data = await createCalendarEvent(msg.payload);
          sendResponse({ ok: true, data });
          break;
        }

        case 'DELETE_EVENT': {
          try {
            const data = await deleteCalendarEvent(msg.payload || {});
            if (data.deleted) {
              sendResponse({ ok: true });
            } else if (data.notFound) {
              sendResponse({ ok: false, code: 404, error: 'Event not found' });
            } else {
              sendResponse({ ok: false, error: 'Delete failed' });
            }
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
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
        // New ON/OFF toggle for nightly emails
        case 'NOTIFY_TOGGLE': {
          const enabled = !!msg.enabled;
          const email = (msg.email || '').trim();

          if (enabled) {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
              sendResponse({ ok: false, error: 'Invalid email' });
              break;
            }
            await chrome.storage.sync.set({
              notifyEnabled: true,
              notifyEmail: email,
            });
            // Best-effort welcome email; success not required to “register”
            try { await sendWelcomeEmail(email); } catch (_) {}
            sendResponse({ ok: true });
          } else {
            const { notifyEmail = '' } = await chrome.storage.sync.get(['notifyEmail']);
            await chrome.storage.sync.set({ notifyEnabled: false });
            // Best-effort goodbye email
            if (notifyEmail) { try { await sendGoodbyeEmail(notifyEmail); } catch (_) {} }
            sendResponse({ ok: true });
          }
          break;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown message' });
      }
    } catch (e) {
      console.error('[background] router error:', e);
      sendResponse({ ok: false, error: e.message });
    }
  })();

  // Keep channel open for async handlers
  return true;
});

/******************
 * Daily digest at local midnight + reliable cleanup
 ******************/
function nextLocalMidnight() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(0, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function scheduleDailyAlarm() {
  const next = nextLocalMidnight();
  chrome.alarms.create('dailyDigest', { when: next.getTime() }); // one-shot
  console.log('[background] alarm set for', next.toString());
}

// Utility: today's key (local)
function todayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `todos_${yyyy}-${mm}-${dd}`;
}

chrome.runtime.onInstalled.addListener(scheduleDailyAlarm);
chrome.runtime.onStartup.addListener(scheduleDailyAlarm);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'dailyDigest') return;

  try {
    // Reschedule the NEXT run immediately to avoid drift
    scheduleDailyAlarm();

    const { notifyEnabled = false, notifyEmail = '' } =
      await chrome.storage.sync.get(['notifyEnabled', 'notifyEmail']);

    // Gather unfinished items from ALL prior days (not today)
    const all = await chrome.storage.sync.get(null);
    const tKey = todayKey();
    const todoKeys = Object.keys(all).filter(k => k.startsWith('todos_'));

    // Build digest lines from all unfinished tasks not in today's (new) list
    const unfinished = [];
    for (const key of todoKeys) {
      if (key === tKey) continue; // skip the new day
      const items = Array.isArray(all[key]) ? all[key] : [];
      for (const it of items) {
        if (!it?.done && it?.title) unfinished.push(`• ${it.title}`);
      }
    }

    // Send email if enabled & we have something to report
    if (notifyEnabled && notifyEmail && unfinished.length) {
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');

      const subject = `Taskade: Unfinished tasks for ${yyyy}-${mm}-${dd}`;
      const body = [
        `Here are tasks that carried over:`,
        '',
        ...unfinished,
        "\nIt's okay you didn't finish everything today.",
        "Tomorrow is a new day. Taskade will wipe the slate clean so you can start fresh.",
        'Best regards,',
        'Taskade'
      ].join('\n');

      try {
        await gmailSend({ to: notifyEmail, subject, text: body });
        console.log('[background] digest email sent');
      } catch (e) {
        console.warn('[background] digest email failed:', e);
      }
    } else {
      console.log('[background] digest: skipped (disabled or nothing to send)');
    }

    // Cleanup: remove ALL prior-day lists unconditionally
    const keysToRemove = todoKeys.filter(k => k !== tKey);
    if (keysToRemove.length) {
      await chrome.storage.sync.remove(keysToRemove);
      console.log('[background] cleared previous days', keysToRemove);
    }
  } catch (e) {
    console.error('[background] alarm handler error:', e);
    // Even on error, try to ensure we reschedule next run
    try { scheduleDailyAlarm(); } catch {}
  }
});