// Valorisation monétaire de la consommation.
// Module pur (pas de dépendance Homey) : il ne fait que des calculs sur les index
// remontés par le compteur et les tarifs saisis dans les réglages de l'appareil.

// Mode standard: les 10 index fournisseur EASF01..EASF10, avec un prix par index.
// Clés d'index 'f01'..'f10', réglages 'price_index_01'..'price_index_10'.
// Indépendant du nom de l'offre (NGTF): fonctionne pour toute offre fournisseur, y compris
// celles qui ont plus de deux périodes (Zen Week-End, Zen Flex, Heures Super Creuses...).
const SUPPLIER_INDEX_COUNT = 10;
const pad2 = n => String(n).padStart(2, '0');
const supplierIndexKey = n => `f${pad2(n)}`;
const supplierIndexPriceSetting = n => `price_index_${pad2(n)}`;
const SUPPLIER_INDEX_NUMBERS = Array.from({ length: SUPPLIER_INDEX_COUNT }, (_, i) => i + 1);

// true si au moins un prix par index fournisseur est renseigné
function hasSupplierIndexPrices(settings) {
  return SUPPLIER_INDEX_NUMBERS.some(n => toPositiveNumber(settings[supplierIndexPriceSetting(n)]) > 0);
}

// Association option tarifaire -> registres d'index utilisés et réglage de prix correspondant.
// Les clés d'index correspondent à celles construites dans device.js à partir des attributs
// du cluster Metering (voir lib/lixeeMeteringCluster.js).
const BUCKETS_BY_OPTION = {
  BASE: [
    { index: 'total', setting: 'price_base' },
  ],
  HPHC: [
    { index: 'hp', setting: 'price_hp' },
    { index: 'hc', setting: 'price_hc' },
  ],
  // 'HC..' est normalisé en 'HPHC' par _updatePriceOptionIfChanged, on le garde par sécurité
  'HC..': [
    { index: 'hp', setting: 'price_hp' },
    { index: 'hc', setting: 'price_hc' },
  ],
  TEMPO: [
    { index: 'hp', setting: 'price_tempo_blue_hp' },
    { index: 'hc', setting: 'price_tempo_blue_hc' },
    { index: 'hpw', setting: 'price_tempo_white_hp' },
    { index: 'hcw', setting: 'price_tempo_white_hc' },
    { index: 'hpr', setting: 'price_tempo_red_hp' },
    { index: 'hcr', setting: 'price_tempo_red_hc' },
  ],
  BBR: [
    { index: 'hp', setting: 'price_tempo_blue_hp' },
    { index: 'hc', setting: 'price_tempo_blue_hc' },
    { index: 'hpw', setting: 'price_tempo_white_hp' },
    { index: 'hcw', setting: 'price_tempo_white_hc' },
    { index: 'hpr', setting: 'price_tempo_red_hp' },
    { index: 'hcr', setting: 'price_tempo_red_hc' },
  ],
  // HYPOTHÈSE: en EJP le ZLinky expose les index EJP HN / EJP PM sur les mêmes registres
  // 0x0100 / 0x0102 que HC / HP. À corriger si le compteur remonte autre chose.
  'EJP.': [
    { index: 'hc', setting: 'price_ejp_normal' },
    { index: 'hp', setting: 'price_ejp_peak' },
  ],
  // Certains compteurs annoncent 'EJP' sans le point
  EJP: [
    { index: 'hc', setting: 'price_ejp_normal' },
    { index: 'hp', setting: 'price_ejp_peak' },
  ],
  // Pseudo-option utilisée en mode standard dès qu'un prix par index est renseigné
  STANDARD: SUPPLIER_INDEX_NUMBERS.map(n => ({
    index: supplierIndexKey(n),
    setting: supplierIndexPriceSetting(n),
  })),
};

// Convertit une valeur de réglage en nombre positif, 0 si absente ou invalide
function toPositiveNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

// Clé de jour local au format 'YYYY-MM-DD' (locale en-CA = ISO)
function localDayKey(date, timezone) {
  try {
    return date.toLocaleDateString('en-CA', { timeZone: timezone });
  } catch (e) {
    // Fuseau inconnu: on retombe sur le fuseau du système
    return date.toLocaleDateString('en-CA');
  }
}

// Part journalière de l'abonnement: montant mensuel / nombre de jours du mois de dayKey
function dailySubscriptionCost(monthlyPrice, dayKey) {
  const monthly = toPositiveNumber(monthlyPrice);
  if (monthly === 0) return 0;

  const [year, month] = String(dayKey).split('-')
    .map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return 0;

  // Le jour 0 du mois suivant = dernier jour du mois courant
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return monthly / daysInMonth;
}

// Recale la baseline (index en Wh au dernier passage de minuit) sur les index courants:
// - clé absente de la baseline (option tarifaire qui change, premier relevé) -> on l'initialise
// - index courant inférieur à la baseline (remise à zéro du compteur) -> on repart de l'index courant
// Renvoie une nouvelle baseline; l'ancienne n'est pas modifiée.
function reconcileBaseline(baseline, indexes) {
  const next = { ...(baseline || {}) };
  Object.keys(indexes).forEach(key => {
    const current = indexes[key];
    if (!Number.isFinite(current)) return;
    if (!Number.isFinite(next[key]) || current < next[key]) {
      next[key] = current;
    }
  });
  return next;
}

// Coût de l'énergie consommée depuis la baseline, pour l'option tarifaire donnée.
// Renvoie { cost, kwh, hasPrice }: hasPrice vaut false si aucun tarif n'est renseigné
// pour cette option (auquel cas cost vaut 0 et n'a pas de sens).
function computeEnergyCost(priceOption, baseline, indexes, settings) {
  const buckets = BUCKETS_BY_OPTION[priceOption];
  if (!buckets) return { cost: 0, kwh: 0, hasPrice: false };

  let cost = 0;
  let kwh = 0;
  let hasPrice = false;

  buckets.forEach(({ index, setting }) => {
    const price = toPositiveNumber(settings[setting]);
    if (price > 0) hasPrice = true;

    const current = indexes[index];
    const start = baseline[index];
    if (!Number.isFinite(current) || !Number.isFinite(start)) return;

    const deltaKwh = Math.max(0, current - start) / 1000;
    kwh += deltaKwh;
    cost += deltaKwh * price;
  });

  return { cost, kwh, hasPrice };
}

// Prix du kWh en vigueur à l'instant T, déduit de l'option tarifaire, de la période
// (price_period_capability) et de la couleur du jour (today_color_capability).
// En mode standard (priceOption 'STANDARD'), le prix est celui de l'index NTARF en cours.
// Renvoie null si le tarif applicable n'est pas déterminable ou pas renseigné.
function currentKwhPrice(priceOption, period, todayColor, settings, tariffIndex) {
  let setting = null;

  switch (priceOption) {
    case 'STANDARD': {
      const n = Number(tariffIndex);
      if (Number.isInteger(n) && n >= 1 && n <= SUPPLIER_INDEX_COUNT) {
        setting = supplierIndexPriceSetting(n);
      }
      break;
    }
    case 'BASE':
      setting = 'price_base';
      break;
    case 'HPHC':
    case 'HC..':
      if (period === 'HC..') setting = 'price_hc';
      else if (period === 'HP..') setting = 'price_hp';
      break;
    case 'TEMPO':
    case 'BBR': {
      const colorSuffix = { BLEU: 'blue', BLAN: 'white', ROUG: 'red' }[todayColor];
      if (!colorSuffix) break;
      if (period === 'HC..') setting = `price_tempo_${colorSuffix}_hc`;
      else if (period === 'HP..') setting = `price_tempo_${colorSuffix}_hp`;
      break;
    }
    case 'EJP.':
    case 'EJP':
      // Même hypothèse de mapping que BUCKETS_BY_OPTION
      if (period === 'HC..' || period === 'HN..') setting = 'price_ejp_normal';
      else if (period === 'HP..' || period === 'PM..') setting = 'price_ejp_peak';
      break;
    default:
      setting = null;
  }

  if (!setting) return null;
  const price = toPositiveNumber(settings[setting]);
  return price > 0 ? price : null;
}

// Cumul mensuel. monthState = { month: 'YYYY-MM', closed: coût des journées closes du mois }.
// Appelé au passage de minuit avec le coût de la journée qui se termine.
// Renvoie { state, lastMonthCost }: lastMonthCost est le total du mois écoulé quand le nouveau
// jour appartient à un autre mois, null sinon.
function closeDayIntoMonth(monthState, closedDayKey, closingCost, newDayKey) {
  const closedMonth = String(closedDayKey).slice(0, 7);
  const newMonth = String(newDayKey).slice(0, 7);
  const base = monthState && monthState.month === closedMonth ? monthState.closed : 0;
  const closed = (Number.isFinite(base) ? base : 0)
    + (Number.isFinite(closingCost) ? closingCost : 0);

  if (newMonth !== closedMonth) {
    return {
      state: { month: newMonth, closed: 0 },
      lastMonthCost: Math.round(closed * 100) / 100,
    };
  }
  return { state: { month: closedMonth, closed }, lastMonthCost: null };
}

// Coût du mois en cours = journées closes du mois + coût du jour. null si rien à afficher.
function monthToDateCost(monthState, dayKey, todayCost) {
  const month = String(dayKey).slice(0, 7);
  const closed = monthState && monthState.month === month && Number.isFinite(monthState.closed)
    ? monthState.closed : 0;
  const today = Number.isFinite(todayCost) ? todayCost : 0;
  if (!Number.isFinite(todayCost) && closed === 0) return null;
  return Math.round((closed + today) * 100) / 100;
}

// Texte du réglage en lecture seule listant les index vus et signalant ceux sans prix.
// labels = { 6: 'HP MERCREDI', ... }
function supplierLabelsText(labels, settings) {
  return Object.keys(labels || {})
    .map(Number)
    .filter(n => Number.isInteger(n))
    .sort((a, b) => a - b)
    .map(n => {
      const priced = toPositiveNumber(settings[supplierIndexPriceSetting(n)]) > 0;
      return `Index ${pad2(n)} : ${labels[n]}${priced ? '' : ' (prix non saisi)'}`;
    })
    .join('\n');
}

module.exports = {
  closeDayIntoMonth,
  monthToDateCost,
  supplierLabelsText,
  SUPPLIER_INDEX_NUMBERS,
  supplierIndexKey,
  supplierIndexPriceSetting,
  hasSupplierIndexPrices,
  BUCKETS_BY_OPTION,
  localDayKey,
  dailySubscriptionCost,
  reconcileBaseline,
  computeEnergyCost,
  currentKwhPrice,
};
