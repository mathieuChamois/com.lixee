'use strict';

// Programme tarifaire (mode standard): à quelle heure le compteur passe sur quel index fournisseur.
//
// Deux sources, par ordre de priorité:
// 1. PJOURF+1 (0xFF66 / 0x0227), « profil du prochain jour » transmis par le Linky quand le
//    fournisseur l'a programmé: jusqu'à 11 blocs « HHMMSSSS » séparés par des espaces, HHMM
//    l'heure de début, SSSS l'action en hexadécimal dont les 4 bits de poids faible sont le
//    numéro d'index fournisseur; « NONUTILE » pour un bloc vide.
// 2. Apprentissage: chaque journée observée en continu (de minuit à minuit) est mémorisée par
//    jour de la semaine et sert de programme pour le même jour la semaine suivante.
//
// Module pur: aucune dépendance Homey. Les horaires sont en minutes depuis minuit (heure locale).

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Au-delà de cet écart entre deux relevés, la journée n'est plus considérée comme observée
// en continu et n'est pas apprise
const MAX_GAP_MS = 15 * 60 * 1000;

const pad2 = n => String(n).padStart(2, '0');
const formatMinutes = m => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;

// Date locale, jour de la semaine et minutes depuis minuit dans le fuseau du Homey
function localClock(date, timezone) {
  const opts = { timeZone: timezone };
  let dayKey;
  let weekday;
  let hour;
  let minute;
  try {
    dayKey = date.toLocaleDateString('en-CA', opts);
    weekday = date.toLocaleDateString('en-US', { ...opts, weekday: 'short' });
    const parts = date.toLocaleTimeString('en-GB', { ...opts, hour: '2-digit', minute: '2-digit', hour12: false }).split(':');
    hour = Number(parts[0]) % 24;
    minute = Number(parts[1]);
  } catch (e) {
    dayKey = date.toLocaleDateString('en-CA');
    weekday = WEEKDAYS[date.getDay()];
    hour = date.getHours();
    minute = date.getMinutes();
  }
  return { dayKey, weekday, minutes: hour * 60 + minute };
}

// Jour suivant d'une clé 'YYYY-MM-DD' et son jour de la semaine
function nextDay(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return { dayKey: next.toISOString().slice(0, 10), weekday: WEEKDAYS[next.getUTCDay()] };
}

// Décode PJOURF+1. Renvoie [{ minutes, index }] trié, ou null si rien d'exploitable.
function parseNextDayProfile(raw) {
  const blocks = String(raw ?? '').replace(/\0/g, ' ').trim().split(/\s+/);
  const entries = [];
  for (const block of blocks) {
    if (!/^\d{4}[0-9A-Fa-f]{4}$/.test(block)) continue; // NONUTILE ou bloc invalide
    const hh = Number(block.slice(0, 2));
    const mm = Number(block.slice(2, 4));
    const index = parseInt(block.slice(4, 8), 16) & 0x0F;
    if (hh > 23 || mm > 59 || index < 1 || index > 10) continue;
    entries.push({ minutes: hh * 60 + mm, index });
  }
  if (!entries.length) return null;
  entries.sort((a, b) => a.minutes - b.minutes);
  return compact(entries);
}

// Supprime les changements qui ne changent rien (même index que le créneau précédent)
function compact(entries) {
  const out = [];
  for (const e of entries) {
    if (!out.length || out[out.length - 1].index !== e.index) out.push({ minutes: e.minutes, index: e.index });
  }
  return out;
}

// Enregistre un relevé (index fournisseur en cours) et fait avancer l'apprentissage.
// state = { day: { key, weekday, continuous, entries }, lastTs, learned: { Mon: [...] }, profiles: { 'YYYY-MM-DD': [...] } }
// Renvoie { state, changed } sans modifier l'état reçu.
function observe(state, nowMs, clock, index) {
  const prev = state || {};
  const next = {
    day: prev.day ? { ...prev.day, entries: [...prev.day.entries] } : null,
    lastTs: prev.lastTs,
    learned: { ...(prev.learned || {}) },
    profiles: { ...(prev.profiles || {}) },
  };
  let changed = false;
  const gapOk = Number.isFinite(prev.lastTs) && nowMs - prev.lastTs <= MAX_GAP_MS;

  if (!next.day || next.day.key !== clock.dayKey) {
    // Journée terminée observée sans interruption: elle devient le programme de ce jour de semaine
    if (next.day && next.day.continuous && gapOk && next.day.entries.length) {
      next.learned[next.day.weekday] = compact(next.day.entries);
    }
    // La nouvelle journée est continue si l'on suivait déjà le compteur juste avant minuit
    const continuous = Boolean(next.day) && gapOk;
    next.day = {
      key: clock.dayKey,
      weekday: clock.weekday,
      continuous,
      entries: [{ minutes: continuous ? 0 : clock.minutes, index }],
    };
    // Profils PJOURF+1 périmés (jours passés)
    Object.keys(next.profiles).forEach(k => { if (k < clock.dayKey) delete next.profiles[k]; });
    changed = true;
  } else {
    if (!gapOk) next.day.continuous = false;
    const last = next.day.entries[next.day.entries.length - 1];
    if (last.index !== index) {
      next.day.entries.push({ minutes: clock.minutes, index });
      changed = true;
    }
  }
  if (prev.day && prev.day.continuous !== next.day.continuous) changed = true;
  next.lastTs = nowMs;
  return { state: next, changed };
}

// Programme connu pour une date: PJOURF+1 reçu pour cette date, sinon jour de semaine appris
function scheduleFor(state, dayKey, weekday, useLearned = true) {
  if (!state) return null;
  if (state.profiles && state.profiles[dayKey]) return { entries: state.profiles[dayKey], source: 'linky' };
  if (useLearned && state.learned && state.learned[weekday]) return { entries: state.learned[weekday], source: 'appris' };
  return null;
}

// Prochain changement d'index après « maintenant », aujourd'hui puis demain.
// Renvoie { inMinutes, minutes, index, tomorrow } ou null.
function nextChange(today, tomorrow, nowMinutes, currentIndex) {
  if (today) {
    for (const e of today.entries) {
      if (e.minutes > nowMinutes && e.index !== currentIndex) {
        return { inMinutes: e.minutes - nowMinutes, minutes: e.minutes, index: e.index, tomorrow: false };
      }
    }
  }
  // Rien d'autre prévu aujourd'hui: premier créneau de demain sur un autre index
  if (tomorrow) {
    for (const e of tomorrow.entries) {
      if (e.index !== currentIndex) {
        return { inMinutes: 1440 - nowMinutes + e.minutes, minutes: e.minutes, index: e.index, tomorrow: true };
      }
    }
  }
  return null;
}

// Texte d'un programme: « 00:00 HC SEMAINE · 07:00 HP SEMAINE · … »
function formatSchedule(entries, labels) {
  return entries
    .map(e => `${formatMinutes(e.minutes)} ${(labels && labels[e.index]) || `Index ${pad2(e.index)}`}`)
    .join(' · ');
}

module.exports = {
  localClock,
  nextDay,
  parseNextDayProfile,
  observe,
  scheduleFor,
  nextChange,
  formatSchedule,
  formatMinutes,
  WEEKDAYS,
};
