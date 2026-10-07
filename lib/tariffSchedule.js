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

// Durée en minutes de chaque créneau d'un programme (le dernier court jusqu'à minuit)
function slotDurations(entries) {
  return entries.map((e, i) => ({
    index: e.index,
    minutes: (i + 1 < entries.length ? entries[i + 1].minutes : 1440) - (i === 0 ? 0 : e.minutes),
  }));
}

// Niveau tarifaire d'un index, pour nommer les créneaux simplement:
// - prix renseignés sur deux niveaux exactement: le moins cher est « HC », l'autre « HP »
//   (quel que soit le libellé du compteur: « HP MERCREDI » facturé au prix HC est bien « HC »);
// - un seul niveau ou plus de deux: le prix lui-même (« 0,1792 € »);
// - prix non saisi: d'après le libellé du compteur (« HC SEMAINE » -> « HC »), sinon le libellé.
// priceOf(index) renvoie le prix de l'index ou null. Renvoie index -> { key, name, sort, cheap }.
function tariffLevels(labels, priceOf) {
  const known = p => Number.isFinite(p) && p > 0;
  const prices = [...new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(priceOf).filter(known))].sort((a, b) => a - b);
  return index => {
    const price = priceOf(index);
    if (known(price)) {
      if (prices.length === 2) {
        const cheap = price === prices[0];
        return { key: cheap ? 'HC' : 'HP', name: cheap ? 'HC' : 'HP', sort: cheap ? 0 : 1, cheap };
      }
      return { key: `p${price}`, name: `${price.toFixed(4).replace('.', ',')} €`, sort: price, cheap: price === prices[0] };
    }
    const label = (labels && labels[index]) || `Index ${pad2(index)}`;
    const prefix = /^(HC|HP)\b/i.exec(label);
    if (prefix) {
      const name = prefix[1].toUpperCase();
      return { key: name, name, sort: name === 'HC' ? 0 : 1, cheap: name === 'HC' };
    }
    return { key: `i${index}`, name: label, sort: 100 + index, cheap: false };
  };
}

const formatDuration = minutes => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h} h${m ? ` ${pad2(m)}` : ''}`;
};

// Résumé court d'un programme pour une tuile mobile (environ 16 caractères):
// « HC 8 h · 4 chgts » = durée en heures creuses et nombre de changements de niveau tarifaire;
// « HC 24 h » pour une journée entière au tarif bas; « 8 h à 0,1792 € » quand l'offre a plus de
// deux prix; « 4 changements » quand rien ne permet de distinguer les niveaux.
function summarizeSchedule(entries, labels, priceOf) {
  const levelOf = tariffLevels(labels, priceOf);
  const slots = slotDurations(entries).map(s => ({ ...s, level: levelOf(s.index) }));
  let changes = 0;
  for (let i = 1; i < slots.length; i++) if (slots[i].level.key !== slots[i - 1].level.key) changes++;
  const cheap = slots.filter(s => s.level.cheap);
  if (!cheap.length) return `${changes} changement${changes > 1 ? 's' : ''}`;
  const name = cheap[0].level.name;
  const minutes = cheap.reduce((t, s) => t + s.minutes, 0);
  const head = name === 'HC' ? `HC ${formatDuration(minutes)}` : `${formatDuration(minutes)} à ${name}`;
  return changes ? `${head} · ${changes} chgt${changes > 1 ? 's' : ''}` : head;
}

// Programme d'une journée en deux lignes courtes, une par niveau tarifaire (l'app mobile
// n'affiche que les deux premières lignes d'un réglage en lecture seule):
// « HC : 23:36–05:36, 15:06–17:06 » / « HP : 05:36–15:06, 17:06–23:36 ».
// Le créneau qui finit à minuit et celui qui commence à 00:00 au même niveau sont fusionnés.
function describeDay(entries, labels, priceOf) {
  const levelOf = tariffLevels(labels, priceOf);
  const groups = new Map();
  entries.forEach((e, i) => {
    const start = i === 0 ? 0 : e.minutes;
    const end = i + 1 < entries.length ? entries[i + 1].minutes : 1440;
    const level = levelOf(e.index);
    if (!groups.has(level.key)) groups.set(level.key, { ...level, windows: [] });
    const windows = groups.get(level.key).windows;
    const last = windows[windows.length - 1];
    if (last && last.end === start) last.end = end;
    else windows.push({ start, end });
  });
  return [...groups.values()]
    .sort((a, b) => a.sort - b.sort)
    .map(g => {
      let w = g.windows;
      if (w.length === 1 && w[0].start === 0 && w[0].end === 1440) return `${g.name} : toute la journée`;
      // Fusion du créneau de fin de soirée avec celui du début de journée (passage de minuit)
      if (w.length > 1 && w[0].start === 0 && w[w.length - 1].end === 1440) {
        w = [{ start: w[w.length - 1].start, end: w[0].end }, ...w.slice(1, -1)];
      }
      return `${g.name} : ${w.map(x => `${formatMinutes(x.start)}–${formatMinutes(x.end % 1440)}`).join(', ')}`;
    })
    .join('\n');
}

module.exports = {
  describeDay,
  tariffLevels,
  summarizeSchedule,
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
