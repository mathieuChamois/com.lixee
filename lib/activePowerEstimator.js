'use strict';

// Estimation de la puissance active à partir de l'index d'énergie active (EAST, en Wh).
//
// Le Linky ne transmet pas de puissance active instantanée: seulement la puissance apparente
// (SINSTS, en VA) et un point de courbe de charge active moyenné sur 30 minutes (CCASN).
// L'index EAST, lui, compte l'énergie active au Wh près: sa pente donne la puissance active.
//
// Fenêtre adaptative: on remonte jusqu'à l'échantillon le plus récent qui donne au moins
// `targetWh` d'écart (précision ~5 % avec un index au Wh), sans descendre sous `minSeconds`
// ni dépasser `maxSeconds`. À forte charge la valeur réagit en ~30 s, à faible charge elle
// est lissée sur quelques minutes.
class ActivePowerEstimator {

  constructor({
    minSeconds = 30,
    maxSeconds = 300,
    targetWh = 20,
    gapSeconds = 900,
  } = {}) {
    this.minMs = minSeconds * 1000;
    this.maxMs = maxSeconds * 1000;
    this.targetWh = targetWh;
    this.gapMs = gapSeconds * 1000;
    this.samples = [];
    this.estimate = null;
  }

  // Ajoute un relevé et renvoie la puissance active estimée en W (null tant que la fenêtre
  // minimale n'est pas atteinte).
  push(timestampMs, wh) {
    // Index nul ou invalide: trame TIC pas encore reçue, on l'ignore
    if (!Number.isFinite(timestampMs) || !Number.isFinite(wh) || wh <= 0) return this.estimate;

    let last = this.samples[this.samples.length - 1];
    // Saut invraisemblable (plus de 72 kW en moyenne depuis le relevé précédent): relevé aberrant
    const implausible = last && timestampMs > last.t
      && (wh - last.wh) * 3600000 / (timestampMs - last.t) > 72000;
    // Index en recul, saut dans le temps (redémarrage, coupure) ou aberrant: on repart de zéro
    if (last && (implausible || wh < last.wh || timestampMs - last.t > this.gapMs || timestampMs < last.t)) {
      this.samples = [];
      this.estimate = null;
      last = null;
    }
    if (!last || timestampMs !== last.t) {
      this.samples.push({ t: timestampMs, wh });
    }

    // On garde un échantillon juste au-delà de la fenêtre maximale pour pouvoir la couvrir
    while (this.samples.length > 2 && timestampMs - this.samples[1].t >= this.maxMs) {
      this.samples.shift();
    }

    const now = this.samples[this.samples.length - 1];
    let ref = null;
    for (let i = this.samples.length - 2; i >= 0; i--) {
      const s = this.samples[i];
      const dt = now.t - s.t;
      if (dt < this.minMs) continue;
      ref = s;
      if (now.wh - s.wh >= this.targetWh) break;
    }
    if (!ref) return this.estimate;

    const dtMs = now.t - ref.t;
    this.estimate = Math.round(((now.wh - ref.wh) * 3600000) / dtMs);
    return this.estimate;
  }

}

module.exports = ActivePowerEstimator;
