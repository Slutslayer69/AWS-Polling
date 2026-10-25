import { useState, useEffect, useRef } from 'react';
import { generateClient } from 'aws-amplify/data';
import './App.css';

const client = generateClient();

/* ---------- Settings ---------- */
const ADMIN_PIN = '4827';       // set to '' to disable the PIN
const ALLOW_CHANGE = true;      // let people switch their vote
const HOST_URL = 'http://10.236.49.243:5173/'; // used for the QR when running on localhost
const VOTE_DEBOUNCE_MS = 350;   // taps within this window are sent as one write
const SETTLE_MS = 3000;         // keep local numbers this long after a write
const UNDO_MS = 6000;           // how long "Undo" is offered after deleting
const MAX_RETRIES = 3;          // attempts for a failed vote before rolling back

const TEMPLATES = [
  { label: 'Yes / No', a: 'Yes', b: 'No' },
  { label: 'Agree / Disagree', a: 'Agree', b: 'Disagree' },
  { label: 'True / False', a: 'True', b: 'False' },
  { label: 'Like / Dislike', a: 'Like', b: 'Dislike' },
];
const DURATIONS = [
  { label: 'No timer', min: 0 },
  { label: '1 min', min: 1 },
  { label: '5 min', min: 5 },
  { label: '10 min', min: 10 },
  { label: '30 min', min: 30 },
];
const EMPTY_FORM = { q: '', a: '', b: '', mins: 0 };

/* ---------- Clock (uses the web server's time so phones with a wrong clock still agree) ---------- */
let clockOffset = 0;
const nowMs = () => Date.now() + clockOffset;

/* ---------- Helpers ---------- */
const store = (area) => ({
  get: (k) => { try { return window[area].getItem(k); } catch { return null; } },
  set: (k, v) => { try { window[area].setItem(k, v); } catch { /* ignore */ } },
});
const local = store('localStorage');
const session = store('sessionStorage');

const loadJson = (key) => {
  try { return JSON.parse(local.get(key)) || {}; } catch { return {}; }
};

// Amplify often returns { errors } instead of throwing, so check every response
const ok = (res) => {
  if (res && res.errors && res.errors.length) throw new Error(res.errors[0].message || 'Request failed');
  return res;
};
const fatal = (message, extra = {}) => Object.assign(new Error(message), { fatal: true }, extra);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const withRetry = async (fn) => {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (e.fatal || attempt >= MAX_RETRIES) throw e;
      await sleep(600 * attempt);
    }
  }
};

const byNewest = (a, b) =>
  (b.createdAt || '').localeCompare(a.createdAt || '') || a.id.localeCompare(b.id);

const endMs = (p) => (p.endsAt ? new Date(p.endsAt).getTime() : null);
const isPollClosed = (p) => {
  const end = endMs(p);
  return !!p.isClosed || (end !== null && end <= nowMs());
};

const pad = (n) => String(n).padStart(2, '0');
const fmtCountdown = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};

const timeAgo = (iso) => {
  if (!iso) return '';
  const s = Math.max(0, Math.floor((nowMs() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

const resultText = (p) => {
  const t = p.votesA + p.votesB;
  if (!t) return 'Closed with no votes.';
  if (p.votesA === p.votesB) return `It's a tie, ${p.votesA} votes each.`;
  const aWins = p.votesA > p.votesB;
  const pct = Math.round((Math.max(p.votesA, p.votesB) / t) * 100);
  return `${aWins ? p.optionA : p.optionB} won with ${pct}% of ${t} ${t === 1 ? 'vote' : 'votes'}.`;
};

const csvCell = (v) => `"${String(v).replace(/"/g, '""')}"`;

// Works on plain http:// links too, where navigator.clipboard is unavailable
const copyText = async (text) => {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const done = document.execCommand('copy');
    document.body.removeChild(ta);
    return done;
  } catch { return false; }
};

/* ---------- Option panel ---------- */
function Option({ side, label, votes, percent, leading, final, mine, disabled, onVote }) {
  return (
    <div className={`option ${side}${leading ? ' winner' : ''}${mine ? ' mine' : ''}`}>
      <button className="vote-btn" onClick={onVote} disabled={disabled} aria-pressed={mine}>
        {mine ? '✓ ' : ''}{label}
      </button>
      <div className="stats">
        <span className="percent">{percent}%</span>
        <span className="votes">{votes} {votes === 1 ? 'vote' : 'votes'}</span>
      </div>
      <div className="track">
        <div className="fill" style={{ width: `${percent}%` }}></div>
      </div>
      <div className="tags">
        {leading && <span className="lead-tag">{final ? 'Winner' : 'Leading'}</span>}
        {mine && <span className="lead-tag mine-tag">Your vote</span>}
      </div>
    </div>
  );
}

export default function App() {
  const [polls, setPolls] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [online, setOnline] = useState(true);
  const [extOk, setExtOk] = useState(null); // null = unknown, true/false = schema has timer fields
  const [myVotes, setMyVotes] = useState(() => loadJson('poll_votes_v1'));
  const [sync, setSync] = useState({});
  const [filter, setFilter] = useState('all');
  const [theme, setTheme] = useState(() => {
    const saved = local.get('poll_theme');
    if (saved) return saved;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });
  const [toast, setToast] = useState(null);
  const [present, setPresent] = useState(false);
  const [editor, setEditor] = useState(null); // null | { mode: 'create' } | { mode: 'edit', id }
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [qrFailed, setQrFailed] = useState(false);
  const [hostOverride, setHostOverride] = useState(() => local.get('poll_host') || '');
  const [pin, setPin] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [lockUntil, setLockUntil] = useState(0);
  const [unlocked, setUnlocked] = useState(
    () => !ADMIN_PIN || session.get('poll_admin') === 'ok'
  );
  const [, setTick] = useState(0);

  /* Refs keep voting smooth (they never trigger re-renders) */
  const intentRef = useRef(loadJson('poll_votes_v1'));   // what this device wants to be voted for
  const committed = useRef(loadJson('poll_votes_v1'));   // what the server already has from this device
  const epochsRef = useRef(loadJson('poll_epochs_v1'));  // reset counter each vote was cast under
  const overrides = useRef({});                          // pollId -> { votesA, votesB, until }
  const timers = useRef({});                             // pollId -> debounce timer
  const writing = useRef(new Set());                     // pollIds with a write in flight
  const deletedIds = useRef(new Set());                  // pollIds hidden while a delete settles
  const pendingDeletes = useRef({});                     // pollId -> { timer, poll }
  const knownIds = useRef(null);                         // for "new poll" alerts
  const syncTimers = useRef({});
  const toastTimer = useRef(null);
  const isAdminRef = useRef(false);

  const adminRequested = new URLSearchParams(window.location.search).get('admin') === 'true';
  const isAdmin = adminRequested && unlocked;

  const joinUrl = hostOverride
    || (window.location.hostname === 'localhost' ? HOST_URL : window.location.origin);
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(joinUrl)}&margin=10`;

  const notify = (msg, action = null, ms = 2800) => {
    setToast({ msg, action });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  };

  const markSync = (id, value) => {
    clearTimeout(syncTimers.current[id]);
    setSync((s) => {
      const next = { ...s };
      if (value) next[id] = value; else delete next[id];
      return next;
    });
    if (value === 'saved') syncTimers.current[id] = setTimeout(() => markSync(id, null), 2000);
  };

  const saveIntent = (next) => {
    intentRef.current = next;
    local.set('poll_votes_v1', JSON.stringify(next));
    setMyVotes(next);
  };

  const saveEpoch = (id, value) => {
    epochsRef.current = { ...epochsRef.current, [id]: value };
    local.set('poll_epochs_v1', JSON.stringify(epochsRef.current));
  };

  const clearLocalVote = (id) => {
    clearTimeout(timers.current[id]);
    timers.current[id] = null;
    const i = { ...intentRef.current }; delete i[id]; saveIntent(i);
    const c = { ...committed.current }; delete c[id]; committed.current = c;
    delete overrides.current[id];
  };

  /* ---------- Vote writing (debounced: one write per burst of taps) ---------- */
  const commitVote = async (id) => {
    timers.current[id] = null;
    const want = intentRef.current[id];
    const had = committed.current[id];

    if (want === had) {                      // net change is zero, nothing to send
      if (overrides.current[id]) overrides.current[id].until = nowMs() + SETTLE_MS;
      markSync(id, null);
      return;
    }
    if (writing.current.has(id)) {           // a write is in flight, queue behind it
      timers.current[id] = setTimeout(() => commitVote(id), 200);
      return;
    }

    writing.current.add(id);
    markSync(id, 'saving');
    const dA = (want === 'A' ? 1 : 0) - (had === 'A' ? 1 : 0);
    const dB = (want === 'B' ? 1 : 0) - (had === 'B' ? 1 : 0);

    try {
      await withRetry(async () => {
        // Re-read right before writing so votes cast by others are not overwritten
        const { data: fresh } = ok(await client.models.Poll.get({ id }));
        if (!fresh) throw fatal('This poll was removed.');
        if (isPollClosed(fresh)) throw fatal('This poll has closed.');
        const known = epochsRef.current[id];
        if (known !== undefined && known !== (fresh.epoch ?? 0)) {
          throw fatal('Votes were just reset. Please vote again.', { reset: true });
        }
        ok(await client.models.Poll.update({
          id,
          votesA: Math.max(0, fresh.votesA + dA),
          votesB: Math.max(0, fresh.votesB + dB),
        }));
      });
      committed.current = { ...committed.current, [id]: want };
      if (overrides.current[id] && !timers.current[id] && intentRef.current[id] === want) {
        overrides.current[id].until = nowMs() + SETTLE_MS;
      }
      markSync(id, 'saved');
    } catch (error) {
      console.error('Vote Error:', error);
      if (error.reset) {
        clearLocalVote(id);
      } else {
        const restored = { ...intentRef.current };
        if (had) restored[id] = had; else delete restored[id];
        saveIntent(restored);
        delete overrides.current[id];        // show the server's numbers again
      }
      markSync(id, null);
      notify(error.fatal ? error.message : 'Could not save your vote. Check your connection.');
    } finally {
      writing.current.delete(id);
    }
  };

  /* ---------- Deleting (with Undo) ---------- */
  const runDelete = async (id) => {
    const entry = pendingDeletes.current[id];
    if (!entry) return;
    clearTimeout(entry.timer);
    delete pendingDeletes.current[id];
    try {
      ok(await client.models.Poll.delete({ id }));
    } catch (error) {
      console.error('Delete Error:', error);
      deletedIds.current.delete(id);
      setPolls((cur) => (cur.some((p) => p.id === id) ? cur : [...cur, entry.poll].sort(byNewest)));
      notify('Delete failed. The poll is back.');
    }
  };

  const undoDelete = (id) => {
    const entry = pendingDeletes.current[id];
    if (!entry) return;
    clearTimeout(entry.timer);
    delete pendingDeletes.current[id];
    deletedIds.current.delete(id);
    setPolls((cur) => [...cur, entry.poll].sort(byNewest));
    setToast(null);
  };

  const deletePoll = (poll) => {
    deletedIds.current.add(poll.id);
    clearTimeout(timers.current[poll.id]);
    delete overrides.current[poll.id];
    setPolls((cur) => cur.filter((p) => p.id !== poll.id));
    const timer = setTimeout(() => runDelete(poll.id), UNDO_MS);
    pendingDeletes.current[poll.id] = { timer, poll };
    notify('Poll deleted', { label: 'Undo', fn: () => undoDelete(poll.id) }, UNDO_MS);
  };

  /* ---------- Polling (HTTP, firewall-friendly) ---------- */
  useEffect(() => {
    const pendingTimers = timers.current; // copy the ref for the cleanup function

    const fetchPolls = async () => {
      if (document.hidden) return; // pause while the tab is in the background
      try {
        const res = await client.models.Poll.list();
        if (res.errors && res.errors.length && !(res.data || []).length) {
          throw new Error(res.errors[0].message);
        }
        const data = [...(res.data || [])].sort(byNewest);
        if (data.length) setExtOk('isClosed' in data[0]);

        const ids = new Set(data.map((p) => p.id));

        // Forget deletions the server has confirmed
        deletedIds.current.forEach((id) => { if (!ids.has(id)) deletedIds.current.delete(id); });

        // "New poll" alert for people who are already on the page
        if (knownIds.current === null) {
          knownIds.current = new Set(ids);
        } else {
          const added = data.filter((p) => !knownIds.current.has(p.id) && !deletedIds.current.has(p.id));
          added.forEach((p) => knownIds.current.add(p.id));
          if (added.length && !isAdminRef.current) {
            notify(added.length === 1 ? `New poll: ${added[0].question}` : `${added.length} new polls added`);
            if (navigator.vibrate) navigator.vibrate(40);
          }
        }

        // Drop local data for polls that no longer exist
        Object.keys(intentRef.current).forEach((id) => {
          if (!ids.has(id) && !writing.current.has(id)) clearLocalVote(id);
        });

        // If the admin reset a poll, let this device vote on it again
        data.forEach((p) => {
          const known = epochsRef.current[p.id];
          const current = p.epoch ?? 0;
          if (known === undefined || known === current) return;
          saveEpoch(p.id, current);
          if (intentRef.current[p.id]) {
            clearLocalVote(p.id);
            notify(`Votes were reset on "${p.question}". You can vote again.`);
          }
        });

        // Keep local vote numbers while they are still settling
        const now = nowMs();
        const visible = data.filter((p) => !deletedIds.current.has(p.id));
        const merged = visible.map((p) => {
          const ov = overrides.current[p.id];
          if (!ov) return p;
          if (now > ov.until) { delete overrides.current[p.id]; return p; }
          return { ...p, votesA: ov.votesA, votesB: ov.votesB };
        });

        setPolls(merged);
        setOnline(true);
        setLoaded(true);
      } catch (error) {
        console.error('Fetch Error:', error);
        setOnline(false);
      }
    };

    // Send any pending vote or delete right away if the page is closed
    const flush = () => {
      Object.keys(timers.current).forEach((id) => {
        if (timers.current[id]) {
          clearTimeout(timers.current[id]);
          commitVote(id);
        }
      });
      Object.keys(pendingDeletes.current).forEach((id) => runDelete(id));
    };

    fetchPolls();
    const interval = setInterval(fetchPolls, 1500);
    document.addEventListener('visibilitychange', fetchPolls);
    window.addEventListener('pagehide', flush);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', fetchPolls);
      window.removeEventListener('pagehide', flush);
      Object.values(pendingTimers).forEach((t) => t && clearTimeout(t));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Small effects ---------- */
  useEffect(() => { isAdminRef.current = isAdmin; }, [isAdmin]);
  useEffect(() => { local.set('poll_theme', theme); }, [theme]);

  // Sync our clock with the web server's clock (keeps countdowns identical on every phone)
  useEffect(() => {
    fetch(window.location.href, { method: 'HEAD', cache: 'no-store' })
      .then((r) => {
        const d = r.headers.get('date');
        const t = d ? new Date(d).getTime() : NaN;
        if (!Number.isNaN(t)) clockOffset = t - Date.now();
      })
      .catch(() => { /* keep the local clock */ });
  }, []);

  // Tick once a second while a countdown is running, otherwise every 30 seconds
  const hasLiveTimer = polls.some((p) => {
    const end = endMs(p);
    return !p.isClosed && end !== null && end > nowMs();
  });
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), hasLiveTimer ? 1000 : 30000);
    return () => clearInterval(t);
  }, [hasLiveTimer]);

  useEffect(() => {
    if (!present) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setPresent(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [present]);

  /* ---------- Voting ---------- */
  const handleVote = (poll, option) => {
    const id = poll.id;
    if (isPollClosed(poll)) return notify('This poll has closed.');
    const current = intentRef.current[id];
    if (current === option) return;
    if (current && !ALLOW_CHANGE) return notify('You already voted on this poll.');

    if (epochsRef.current[id] === undefined) saveEpoch(id, poll.epoch ?? 0);

    const delta = (side) => (option === side ? 1 : 0) - (current === side ? 1 : 0);
    const base = overrides.current[id] || { votesA: poll.votesA, votesB: poll.votesB };
    const next = {
      votesA: Math.max(0, base.votesA + delta('A')),
      votesB: Math.max(0, base.votesB + delta('B')),
    };

    // Hold these numbers on screen until the write is done and the server has caught up
    overrides.current[id] = { ...next, until: nowMs() + 60000 };
    saveIntent({ ...intentRef.current, [id]: option });
    setPolls((cur) => cur.map((p) => (p.id === id ? { ...p, ...next } : p)));
    markSync(id, 'saving');
    if (navigator.vibrate) navigator.vibrate(25);

    clearTimeout(timers.current[id]);
    timers.current[id] = setTimeout(() => commitVote(id), VOTE_DEBOUNCE_MS);
  };

  /* ---------- Admin: create / edit / duplicate ---------- */
  // Tries the timer fields first; falls back to a plain poll if the schema has not been updated
  const createRecord = async (q, a, b, minutes) => {
    const base = { question: q, optionA: a, optionB: b, votesA: 0, votesB: 0 };
    if (extOk !== false) {
      try {
        const full = { ...base, isClosed: false, epoch: 0 };
        if (minutes) full.endsAt = new Date(nowMs() + minutes * 60000).toISOString();
        ok(await client.models.Poll.create(full));
        setExtOk(true);
        return { timerApplied: !!minutes };
      } catch (e) {
        console.warn('Create with timer fields failed, trying a plain poll', e);
      }
    }
    ok(await client.models.Poll.create(base));
    setExtOk(false); // reached only when the plain create worked, so the schema is the cause
    return { timerApplied: false, fallback: true };
  };

  const closeEditor = () => {
    setEditor(null);
    setForm(EMPTY_FORM);
    setFormError('');
  };

  const openCreate = () => {
    if (editor && editor.mode === 'create') return closeEditor();
    setEditor({ mode: 'create' });
    setForm(EMPTY_FORM);
    setFormError('');
  };

  const startEdit = (poll) => {
    setEditor({ mode: 'edit', id: poll.id });
    setForm({ q: poll.question, a: poll.optionA, b: poll.optionB, mins: 0 });
    setFormError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const submitForm = async () => {
    if (submitting || !editor) return;
    const q = form.q.trim(), a = form.a.trim(), b = form.b.trim();
    if (q.length < 3) return setFormError('The question needs at least 3 characters.');
    if (q.length > 140) return setFormError('The question is limited to 140 characters.');
    if (!a || !b) return setFormError('Both options are required.');
    if (a.length > 40 || b.length > 40) return setFormError('Options are limited to 40 characters.');
    if (a.toLowerCase() === b.toLowerCase()) return setFormError('The two options must be different.');
    setFormError('');
    setSubmitting(true);
    try {
      if (editor.mode === 'edit') {
        setPolls((cur) => cur.map((p) => (p.id === editor.id ? { ...p, question: q, optionA: a, optionB: b } : p)));
        ok(await client.models.Poll.update({ id: editor.id, question: q, optionA: a, optionB: b }));
        notify('Poll updated');
      } else {
        const result = await createRecord(q, a, b, form.mins);
        notify(result.fallback && form.mins
          ? 'Poll created without a timer. Update the schema to enable timers.'
          : 'Poll created');
      }
      closeEditor();
    } catch (error) {
      console.error('Save Poll Error:', error);
      setFormError('Could not save the poll. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const createDemoPoll = async () => {
    try {
      await createRecord('Which Cloud Provider is best for Serverless?', 'AWS', 'Azure', 0);
      notify('Demo poll added');
    } catch (error) {
      console.error('Create Poll Error:', error);
      notify('Could not add the demo poll.');
    }
  };

  const duplicatePoll = async (poll) => {
    try {
      await createRecord(poll.question, poll.optionA, poll.optionB, 0);
      notify('Poll duplicated with zero votes');
    } catch (error) {
      console.error('Duplicate Error:', error);
      notify('Could not duplicate the poll.');
    }
  };

  /* ---------- Admin: votes, timers, closing ---------- */
  const resetVotes = async (poll) => {
    if (!window.confirm('Reset all votes on this poll to zero? Everyone will be able to vote again.')) return;
    const id = poll.id;
    clearTimeout(timers.current[id]);
    overrides.current[id] = { votesA: 0, votesB: 0, until: nowMs() + SETTLE_MS };
    const patch = { id, votesA: 0, votesB: 0 };
    if (extOk === true) patch.epoch = (poll.epoch ?? 0) + 1;
    clearLocalVote(id);
    overrides.current[id] = { votesA: 0, votesB: 0, until: nowMs() + SETTLE_MS };
    if (patch.epoch !== undefined) saveEpoch(id, patch.epoch);
    setPolls((cur) => cur.map((p) => (p.id === id ? { ...p, votesA: 0, votesB: 0, epoch: patch.epoch ?? p.epoch } : p)));
    try {
      ok(await client.models.Poll.update(patch));
      notify('Votes reset');
    } catch (error) {
      console.error('Reset Error:', error);
      delete overrides.current[id];
      notify('Reset failed. Try again.');
    }
  };

  const patchPoll = async (poll, patch, message) => {
    setPolls((cur) => cur.map((p) => (p.id === poll.id ? { ...p, ...patch } : p)));
    try {
      ok(await client.models.Poll.update({ id: poll.id, ...patch }));
      if (message) notify(message);
    } catch (error) {
      console.error('Update Error:', error);
      notify('Could not update the poll.');
    }
  };

  const closeNow = (poll) => patchPoll(poll, { isClosed: true }, 'Poll closed');
  const reopen = (poll) => patchPoll(poll, { isClosed: false, endsAt: null }, 'Poll reopened');
  const clearTimer = (poll) => patchPoll(poll, { endsAt: null }, 'Timer removed');
  const addTime = (poll, min) => {
    const end = endMs(poll);
    const base = end && end > nowMs() ? end : nowMs();
    patchPoll(poll, { isClosed: false, endsAt: new Date(base + min * 60000).toISOString() }, `Timer set: ${min} min added`);
  };

  /* ---------- Sharing, export, admin access ---------- */
  const shareLink = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Live Poll', url: joinUrl });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    notify((await copyText(joinUrl)) ? 'Link copied' : 'Could not copy. Select the link manually.');
  };

  const changeLink = () => {
    const v = window.prompt('Link shown in the QR code (leave empty to reset):', joinUrl);
    if (v === null) return;
    const t = v.trim();
    if (t && !/^https?:\/\//i.test(t)) return notify('The link must start with http:// or https://');
    local.set('poll_host', t);
    setHostOverride(t);
    setQrFailed(false);
    notify(t ? 'QR link updated' : 'QR link reset');
  };

  const exportCsv = () => {
    const rows = [['Question', 'Option A', 'Votes A', 'Option B', 'Votes B', 'Total', '% A', '% B', 'Status', 'Ends at']];
    polls.forEach((p) => {
      const t = p.votesA + p.votesB;
      rows.push([
        p.question, p.optionA, p.votesA, p.optionB, p.votesB, t,
        t ? Math.round((p.votesA / t) * 100) : 0,
        t ? Math.round((p.votesB / t) * 100) : 0,
        isPollClosed(p) ? 'Closed' : 'Open',
        p.endsAt || '',
      ]);
    });
    const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `poll-results-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const tryUnlock = () => {
    if (nowMs() < lockUntil) return notify('Too many attempts. Wait 30 seconds.');
    if (pin === ADMIN_PIN) {
      session.set('poll_admin', 'ok');
      setUnlocked(true);
      setPin('');
      setAttempts(0);
      return;
    }
    const n = attempts + 1;
    setPin('');
    if (n >= 5) {
      setLockUntil(nowMs() + 30000);
      setAttempts(0);
      notify('Too many attempts. Locked for 30 seconds.');
    } else {
      setAttempts(n);
      notify(`Incorrect PIN (${5 - n} left)`);
    }
  };

  const lockAdmin = () => {
    session.set('poll_admin', '');
    setUnlocked(false);
    setPresent(false);
    closeEditor();
  };

  /* ---------- Derived values ---------- */
  const grandTotal = polls.reduce((sum, p) => sum + p.votesA + p.votesB, 0);
  const openPolls = polls.filter((p) => !isPollClosed(p));
  const votedOpen = openPolls.filter((p) => myVotes[p.id]).length;
  const counts = {
    all: polls.length,
    todo: openPolls.filter((p) => !myVotes[p.id]).length,
    done: polls.filter((p) => myVotes[p.id]).length,
    closed: polls.length - openPolls.length,
  };
  const visiblePolls = polls.filter((p) => {
    if (filter === 'todo') return !isPollClosed(p) && !myVotes[p.id];
    if (filter === 'done') return !!myVotes[p.id];
    if (filter === 'closed') return isPollClosed(p);
    return true;
  });
  const filterLabels = [
    ['all', 'All'], ['todo', 'To vote'], ['done', 'Voted'], ['closed', 'Closed'],
  ];

  return (
    <div className={`app${present ? ' present' : ''}`} data-theme={theme}>
      <div className="container">

        {/* Header */}
        <header className="header">
          <h1 className="title">Live Polling</h1>
          <div className="header-right">
            <div className={`status${online ? '' : ' offline'}`} role="status">
              <span className="status-dot"></span>
              {online ? 'Live' : 'Reconnecting'}
            </div>
            <button
              className="icon-btn"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="Toggle light or dark theme"
            >
              {theme === 'dark' ? '☀' : '☾'}
            </button>
          </div>
        </header>

        {!online && (
          <div className="banner" role="alert">
            Connection lost. The app keeps retrying automatically, and your votes are kept safe.
          </div>
        )}

        {/* QR Code Invite Card */}
        <section className="card qr-card">
          <div className="qr-text">
            <h2>Invite the audience</h2>
            <p>Scan the code to join the live session and vote from your phone.</p>
            <div className="url-chip">{joinUrl}</div>
            <div className="row">
              <button className="btn-ghost" onClick={shareLink}>Share link</button>
              {isAdmin && (
                <button className="btn-ghost" onClick={() => setPresent(!present)}>
                  {present ? 'Exit present mode' : 'Present mode'}
                </button>
              )}
            </div>
          </div>
          <div className="qr-box">
            {qrFailed ? (
              <div className="qr-fallback">QR unavailable. Share the link above instead.</div>
            ) : (
              <img src={qrImageUrl} alt="QR code to join the poll" onError={() => setQrFailed(true)} />
            )}
          </div>
        </section>

        {/* PIN gate */}
        {adminRequested && !unlocked && (
          <section className="card pin-card">
            <h2>Admin access</h2>
            <form className="row" onSubmit={(e) => { e.preventDefault(); tryUnlock(); }}>
              <input
                className="input"
                type="password"
                inputMode="numeric"
                placeholder="Enter PIN"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                autoComplete="off"
              />
              <button className="btn-primary" type="submit">Unlock</button>
            </form>
          </section>
        )}

        {/* Admin Controls */}
        {isAdmin && !present && (
          <section className="admin-bar">
            <div className="admin-head">
              <span className="admin-label">Admin mode</span>
              <span className="admin-stats">
                {polls.length} {polls.length === 1 ? 'poll' : 'polls'} · {openPolls.length} open · {grandTotal} votes
              </span>
            </div>
            <div className="row">
              <button className="btn-primary" onClick={openCreate}>
                {editor && editor.mode === 'create' ? 'Close form' : '+ New poll'}
              </button>
              <button className="btn-ghost" onClick={createDemoPoll}>Add demo poll</button>
              <button className="btn-ghost" onClick={exportCsv} disabled={!polls.length}>Export CSV</button>
              <button className="btn-ghost" onClick={changeLink}>Change link</button>
              {ADMIN_PIN && <button className="btn-ghost" onClick={lockAdmin}>Lock</button>}
            </div>
            {extOk === false && (
              <p className="info-note">
                Timers, closing polls and vote resets for everyone need a one-time schema update (isClosed, endsAt, epoch).
              </p>
            )}
          </section>
        )}

        {/* Create / edit form */}
        {isAdmin && editor && !present && (
          <section className="card form-card">
            <h2 className="form-title">{editor.mode === 'edit' ? 'Edit poll' : 'New poll'}</h2>
            <form onSubmit={(e) => { e.preventDefault(); submitForm(); }}>
              {editor.mode === 'create' && (
                <div className="chips" aria-label="Quick templates">
                  {TEMPLATES.map((t) => (
                    <button
                      type="button"
                      key={t.label}
                      className="chip"
                      onClick={() => setForm({ ...form, a: t.a, b: t.b })}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}

              <label className="field">
                <span>Question <em className="counter">{form.q.length}/140</em></span>
                <input className="input" maxLength={140} value={form.q}
                  onChange={(e) => setForm({ ...form, q: e.target.value })}
                  placeholder="What should we vote on?" />
              </label>

              <div className="two-col">
                <label className="field">
                  <span>Option A <em className="counter">{form.a.length}/40</em></span>
                  <input className="input" maxLength={40} value={form.a}
                    onChange={(e) => setForm({ ...form, a: e.target.value })} placeholder="Yes" />
                </label>
                <label className="field">
                  <span>Option B <em className="counter">{form.b.length}/40</em></span>
                  <input className="input" maxLength={40} value={form.b}
                    onChange={(e) => setForm({ ...form, b: e.target.value })} placeholder="No" />
                </label>
              </div>

              {editor.mode === 'create' && extOk !== false && (
                <div className="field">
                  <span>Timer</span>
                  <div className="chips">
                    {DURATIONS.map((d) => (
                      <button
                        type="button"
                        key={d.min}
                        className={`chip${form.mins === d.min ? ' active' : ''}`}
                        onClick={() => setForm({ ...form, mins: d.min })}
                      >
                        {d.label}
                      </button>
                    ))}
                    <input
                      className="input mini"
                      type="number"
                      min="1"
                      max="1440"
                      placeholder="Custom min"
                      value={DURATIONS.some((d) => d.min === form.mins) ? '' : form.mins}
                      onChange={(e) => {
                        const n = Math.min(1440, Math.max(0, parseInt(e.target.value, 10) || 0));
                        setForm({ ...form, mins: n });
                      }}
                    />
                  </div>
                </div>
              )}

              {formError && <p className="form-error" role="alert">{formError}</p>}
              <div className="row form-actions">
                <button className="btn-primary" type="submit" disabled={submitting}>
                  {submitting ? 'Saving…' : editor.mode === 'edit' ? 'Save changes' : 'Publish poll'}
                </button>
                <button className="btn-ghost" type="button" onClick={closeEditor}>Cancel</button>
              </div>
            </form>
          </section>
        )}

        {/* Summary and filters */}
        {loaded && polls.length > 0 && (
          <div className="summary">
            {polls.length} {polls.length === 1 ? 'poll' : 'polls'} · {openPolls.length} open · {grandTotal} total {grandTotal === 1 ? 'vote' : 'votes'}
            {openPolls.length > 0 && (
              <div className="progress-line">You have voted on {votedOpen} of {openPolls.length} open {openPolls.length === 1 ? 'poll' : 'polls'}.</div>
            )}
          </div>
        )}

        {loaded && polls.length > 1 && (
          <div className="chips filters" role="tablist" aria-label="Filter polls">
            {filterLabels.map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={filter === key}
                className={`chip${filter === key ? ' active' : ''}`}
                onClick={() => setFilter(key)}
              >
                {label} <span className="chip-count">{counts[key]}</span>
              </button>
            ))}
          </div>
        )}

        {/* Loading skeletons */}
        {!loaded && (
          <>
            <div className="card skeleton"></div>
            <div className="card skeleton"></div>
          </>
        )}

        {/* Empty states */}
        {loaded && polls.length === 0 && (
          <div className="card empty">
            <strong>No polls yet</strong>
            <p>
              {isAdmin
                ? 'Create your first poll with the button above.'
                : 'Hang tight. The host has not started a poll yet, and this page updates by itself.'}
            </p>
          </div>
        )}
        {loaded && polls.length > 0 && visiblePolls.length === 0 && (
          <div className="card empty">
            <strong>Nothing here</strong>
            <p>No polls match this filter.</p>
            <button className="btn-ghost" onClick={() => setFilter('all')}>Show all polls</button>
          </div>
        )}

        {/* Poll Cards */}
        {visiblePolls.map((poll) => {
          const totalVotes = poll.votesA + poll.votesB;
          const percentA = totalVotes === 0 ? 50 : Math.round((poll.votesA / totalVotes) * 100);
          const percentB = totalVotes === 0 ? 50 : Math.round((poll.votesB / totalVotes) * 100);
          const closed = isPollClosed(poll);
          const end = endMs(poll);
          const remaining = !poll.isClosed && end !== null ? end - nowMs() : null;
          const leadA = totalVotes > 0 && poll.votesA > poll.votesB;
          const leadB = totalVotes > 0 && poll.votesB > poll.votesA;
          const mine = myVotes[poll.id];
          const locked = closed || (mine && !ALLOW_CHANGE);

          return (
            <article key={poll.id} className={`card${closed ? ' closed' : ''}`}>
              <div className="poll-head">
                <h2 className="question">{poll.question}</h2>
                {closed && <span className="chip-static closed-chip">Closed</span>}
                {!closed && remaining !== null && remaining > 0 && (
                  <span className={`chip-static timer-chip${remaining <= 10000 ? ' urgent' : ''}`}>
                    {fmtCountdown(remaining)} left
                  </span>
                )}
              </div>

              {closed && <div className="result-banner">{resultText(poll)}</div>}

              <div className="options">
                <Option side="a" label={poll.optionA} votes={poll.votesA} percent={percentA}
                  leading={leadA} final={closed} mine={mine === 'A'} disabled={locked}
                  onVote={() => handleVote(poll, 'A')} />
                <Option side="b" label={poll.optionB} votes={poll.votesB} percent={percentB}
                  leading={leadB} final={closed} mine={mine === 'B'} disabled={locked}
                  onVote={() => handleVote(poll, 'B')} />
              </div>

              <div className="sync-line" aria-live="polite">
                {sync[poll.id] === 'saving' && 'Saving your vote…'}
                {sync[poll.id] === 'saved' && 'Vote saved ✓'}
              </div>

              <div className="total">
                Total responses: {totalVotes}
                {poll.createdAt ? ` · created ${timeAgo(poll.createdAt)}` : ''}
              </div>
              {!closed && !mine && <div className="hint">Tap an option to cast your vote.</div>}
              {!closed && mine && ALLOW_CHANGE && <div className="hint">Tap the other option to change your vote.</div>}

              {isAdmin && !present && (
                <details className="manage">
                  <summary>Manage poll</summary>
                  <div className="poll-actions">
                    <button className="btn-ghost" onClick={() => startEdit(poll)}>Edit</button>
                    <button className="btn-ghost" onClick={() => duplicatePoll(poll)}>Duplicate</button>
                    <button className="btn-ghost" onClick={() => resetVotes(poll)}>Reset votes</button>
                    {extOk === true && (
                      closed ? (
                        <button className="btn-ghost" onClick={() => reopen(poll)}>Reopen</button>
                      ) : (
                        <>
                          <button className="btn-ghost" onClick={() => closeNow(poll)}>Close now</button>
                          <button className="btn-ghost" onClick={() => addTime(poll, 1)}>+1 min</button>
                          <button className="btn-ghost" onClick={() => addTime(poll, 5)}>+5 min</button>
                          {poll.endsAt && <button className="btn-ghost" onClick={() => clearTimer(poll)}>Remove timer</button>}
                        </>
                      )
                    )}
                    <button className="btn-danger" onClick={() => deletePoll(poll)}>Delete</button>
                  </div>
                </details>
              )}
            </article>
          );
        })}
      </div>

      {toast && (
        <div className="toast" role="status">
          <span>{toast.msg}</span>
          {toast.action && (
            <button className="toast-btn" onClick={toast.action.fn}>{toast.action.label}</button>
          )}
        </div>
      )}
    </div>
  );
}