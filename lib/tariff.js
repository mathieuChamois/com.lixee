// Valorisation monétaire de la consommation.
// Module pur (pas de dépendance Homey) : il ne fait que des calculs sur les index
// remontés par le compteur et les tarifs saisis dans les réglages de l'appareil.

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
// Renvoie null si le tarif applicable n'est pas déterminable ou pas renseigné.
function currentKwhPrice(priceOption, period, todayColor, settings) {
  let setting = null;

  switch (priceOption) {
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

module.exports = {
  BUCKETS_BY_OPTION,
  localDayKey,
  dailySubscriptionCost,
  reconcileBaseline,
  computeEnergyCost,
  currentKwhPrice,
};
