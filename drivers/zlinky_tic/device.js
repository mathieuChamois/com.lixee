const { ZigBeeDevice } = require('homey-zigbeedriver');
const {
  debug,
  CLUSTER
} = require('zigbee-clusters');
const LixeePrivateCluster = require('../../lib/lixeePrivateCluster');
const MeterIdentificationCluster = require('../../lib/meterIdentificationCluster');
require('../../lib/lixeeElectricalMeasurementCluster');
require('../../lib/lixeeMeteringCluster');
const Tariff = require('../../lib/tariff');
const ActivePowerEstimator = require('../../lib/activePowerEstimator');
const Schedule = require('../../lib/tariffSchedule');
const RawAttributes = require('../../lib/rawAttributes');
const { Log } = require('homey-log');
// node-fetch v3 est ESM, on passe par un import dynamique compatible CommonJS
const fetch = (...args) => import('node-fetch')
  .then(({ default: fetchFn }) => fetchFn(...args));

var lastLogDate;

const Homey = require('homey');
const HomeyModule = require('homey');

var message;
var state;
var hpLastValue = 0;
var hcLastValue = 0;
var hpBlueLastValue = 0;
var hcBlueLastValue = 0;
var hpWhiteLastValue = 0;
var hcWhiteLastValue = 0;
var hpRedLastValue = 0;
var hcRedLastValue = 0;

// Cache global pour l'API couleur Tempo (au plus 1 appel toutes les 30 minutes)
// On sépare les caches pour today et tomorrow afin d'éviter les collisions
// Structure: {
//   today:    { timestamp: number, couleur: 'BLEU'|'BLAN'|'ROUG'|'----'|null },
//   tomorrow: { timestamp: number, couleur: 'BLEU'|'BLAN'|'ROUG'|'----'|null }
// }
const tempoApiCache = {
  today: {
    timestamp: 0,
    couleur: null
  },
  tomorrow: {
    timestamp: 0,
    couleur: null
  }
};

// Capability bouton exposée comme action de maintenance (réglages de l'appareil)
const RESET_DAILY_COST_BUTTON = 'button.reset_daily_cost';

// Homey affiche les capabilities dans l'ordre du tableau stocké sur l'appareil, et addCapability
// ajoute toujours en fin de tableau: cette liste est la référence unique de l'ordre d'affichage.
// Elle est appliquée par _applyCapabilityLayout(), qui ne recrée que ce qui est mal placé.
// meter_power et measure_power restent en tête: sur les appareils déjà appairés elles y sont déjà,
// elles ne sont donc jamais recréées et conservent leur historique Insights.
const CAPABILITY_ORDER = [
  'meter_power',
  'measure_power',
  'meter_power.imported',
  'meter_power.exported',
  'full_hour_capability',
  'empty_hour_capability',
  'full_hour_blue_capability',
  'empty_hour_blue_capability',
  'full_hour_white_capability',
  'empty_hour_white_capability',
  'full_hour_red_capability',
  'empty_hour_red_capability',
  'price_option_capability',
  'serial_number_capability',
  'price_period_capability',
  'today_color_capability',
  'tomorrow_color_capability',
  // Les métriques de coût viennent toujours juste après la couleur de demain
  'measure_daily_cost_capability',
  'measure_yesterday_cost_capability',
  'measure_current_kwh_price_capability',
  'subscribe_intensity_capability',
  'alarm_subscribe_power_capability',
  'apparent_power_instant_inject_capability',
  'mode_capability',
  'phase_capability',
  'produce_capability',
  'active_power_capability',
  'rms_current_capability',
  'rms_voltage_capability',
  'maximal_intensity_capability',
  'phase_1_apparent_power_capability',
  'phase_2_apparent_power_capability',
  'phase_3_apparent_power_capability',
  'clock_full_hour_empty_hour_capability',
  // Tuiles ajoutées après la 1.5.0: placées à la fin pour qu'une mise à jour ne recrée pas
  // (et ne vide pas l'historique Insights) des tuiles existantes
  'supplier_tariff_capability',
  'next_tariff_change_capability',
  'tomorrow_schedule_capability',
  'measure_month_cost_capability',
  'measure_last_month_cost_capability',
  'subscribed_power_capability',
  'max_apparent_power_today_capability',
  'max_apparent_power_yesterday_capability',
  'estimated_active_power_capability',
  'debug_capability',
  RESET_DAILY_COST_BUTTON
];

// Repli triphasé -> monophasé décidé à partir des mesures, mémorisé pour que l'ordre des
// capabilities reste stable d'un démarrage à l'autre
const PHASE_OVERRIDE_STORE = 'phase_override';

// Options héritées du manifeste du driver: addCapability ne les réinjecte pas, il faut donc les
// reposer quand une capability est (re)créée sur un appareil déjà appairé.
// Doit rester aligné sur "capabilitiesOptions" de driver.compose.json.
const CAPABILITY_OPTIONS = {
  'meter_power': {
    title: {
      en: 'Summation delivered',
      fr: 'Index'
    }
  },
  'meter_power.imported': {
    title: {
      en: 'Imported Energy',
      fr: 'Energie importée'
    }
  },
  'meter_power.exported': {
    title: {
      en: 'Exported Energy',
      fr: 'Energie exportée'
    }
  },
  'measure_power': {
    title: {
      en: 'Apparent power (VA)',
      fr: 'Puissance apparente (VA)'
    },
    decimals: 2
  },
  [RESET_DAILY_COST_BUTTON]: {
    maintenanceAction: true,
    title: {
      en: 'Reset the cost of the day',
      fr: 'Remettre à zéro le coût du jour'
    },
    desc: {
      en: 'Restart the consumption of the day from zero: the reference indexes are set to the current ones. The subscription share of the day remains counted.',
      fr: 'Repart de zéro pour la consommation du jour: les index de référence sont recalés sur les index actuels. La part d\'abonnement du jour reste comptée.'
    }
  }
};

// Options tarifaires nécessitant les index heures pleines / heures creuses
const HP_HC_PRICE_OPTIONS = ['HC..', 'HP..', 'HPHC', 'BBR', 'EJP.'];
// Options tarifaires nécessitant les index par couleur (bleu / blanc / rouge)
const COLORED_PRICE_OPTIONS = ['TEMPO', 'BBR', 'EJP.'];
// Options HP/HC simples (deux index)
const HPHC_OPTIONS = ['HPHC', 'HC..'];

class Device extends ZigBeeDevice {
  async onNodeInit({ zclNode }) {
    this.enableDebug();
    debug(true);
    this.printNode();
    const self = this;

    this.log('demarrage de l\'initialisation du driver');
    await doInit();

    // Bouton de maintenance "Remettre à zéro le coût du jour" (réglages de l'appareil).
    // Enregistré hors de doInit(), qui peut sortir tôt si le compteur ne renvoie pas encore
    // son option tarifaire: le bouton doit rester utilisable dans ce cas.
    this.registerResetDailyCostListener();

    async function doInit() {
      try {
        let {
          priceOption
        } = await zclNode.endpoints[self.getClusterEndpoint(LixeePrivateCluster)]
          .clusters[LixeePrivateCluster.NAME]
          .readAttributes([
            'priceOption'
          ]);

        // Si priceOption est vide/indéfini, on ignore cet intervalle et on attend le prochain
        if (priceOption === undefined || priceOption === null || priceOption === '') {
          self.log('[INFO] priceOption vide, on attend la prochaine fenêtre de rafraîchissement');
          return;
        }

        self.log('[INFO] priceOption est ' + priceOption.toString());

        await self.prepareMode(await self.getMode(zclNode), priceOption);
        await self._logNextDayProfile(zclNode);

        // Passage historique <-> standard (demande au fournisseur) ou changement d'offre en cours
        // de fonctionnement: on relit mode et option toutes les 5 minutes et on refait la mise en
        // page des tuiles si besoin, sans attendre un redémarrage de l'app.
        setInterval(async () => {
          try {
            const { priceOption: rawOption } = await zclNode.endpoints[self.getClusterEndpoint(LixeePrivateCluster)]
              .clusters[LixeePrivateCluster.NAME]
              .readAttributes(['priceOption']);
            if (!rawOption) return;
            const currentMode = await self.getMode(zclNode);
            // Mode absent ou inconnu (lecture partielle): on ne touche à rien
            if (![0, 1, 2, 3, 5, 7].includes(Number(currentMode && currentMode.mode))) return;
            const key = `${currentMode.mode}|${self._normalizePriceOption(rawOption)}`;
            if (key === self._layoutKey) {
              self._pendingLayoutKey = null;
              return;
            }
            // Changement confirmé par deux lectures consécutives avant de refaire la mise en page
            if (self._pendingLayoutKey !== key) {
              self._pendingLayoutKey = key;
              return;
            }
            self._pendingLayoutKey = null;
            self.log(`[LAYOUT] Mode ou option modifié (${self._layoutKey} -> ${key}), mise en page recalculée`);
            priceOption = rawOption;
            self._nextTariffChange = null;
            await self.prepareMode(currentMode, rawOption);
          } catch (e) {
            self.log(`[LAYOUT] Vérification du mode impossible: ${e && e.message ? e.message : e}`);
          }
        }, 5 * 60 * 1000);

        // Enregistre la condition Flow "period_option_is"
        try {
          // Options de saisie semi-automatique pour "target" (périodes)
          const PERIOD_OPTIONS = [
            {
              id: 'TH..',
              name: 'Toutes Heures'
            },
            {
              id: 'HC..',
              name: 'Heures Creuses'
            },
            {
              id: 'HP..',
              name: 'Heures Pleines'
            },
            {
              id: 'HN..',
              name: 'Heures Normales'
            },
            {
              id: 'PM..',
              name: 'Pointe Mobile'
            },
            {
              id: 'HCJB',
              name: 'HC Jour Bleu'
            },
            {
              id: 'HCJW',
              name: 'HC Jour Blanc'
            },
            {
              id: 'HCJR',
              name: 'HC Jour Rouge'
            },
            {
              id: 'HPJB',
              name: 'HP Jour Bleu'
            },
            {
              id: 'HPJW',
              name: 'HP Jour Blanc'
            },
            {
              id: 'HPJR',
              name: 'HP Jour Rouge'
            },
            {
              id: 'UNKN',
              name: 'Inconnu'
            },
          ];

          // Enregistre la condition + l'autocomplete pour l'argument "target"
          // SDK v3: condition cards are obtained via getConditionCard (no device-specific variant)
          const periodOptionIsCard = self.homey.flow.getConditionCard('period_option_is');
          periodOptionIsCard.registerRunListener(async (args, state) => {
            try {
              const current = self.getCapabilityValue('price_period_capability');
              const target = args && args.target ? (args.target.id || args.target) : undefined;
              return current === target;
            } catch (e) {
              self.error(`Condition period_option_is failed: ${e && e.message ? e.message : e}`);
              return false;
            }
          });
          periodOptionIsCard.registerArgumentAutocompleteListener('target', async (query, args) => {
            const q = (query || '').toString()
              .toLowerCase();
            if (!q) return PERIOD_OPTIONS;
            return PERIOD_OPTIONS.filter(opt =>
              opt.id.toLowerCase()
                .includes(q) || (opt.name && opt.name.toLowerCase()
                .includes(q))
            );
          });
        } catch (e) {
          self.error(`Failed to register condition card period_option_is: ${e && e.message ? e.message : e}`);
        }

        // Enregistre la carte de déclenchement Flow "period_option_became"
        try {
          self._periodOptionBecameCard = self.homey.flow.getDeviceTriggerCard('period_option_became');
          // Permettre le filtrage par la cible choisie dans la carte Flow
          self._periodOptionBecameCard.registerRunListener(async (args, state) => {
            try {
              const selected = args && args.target ? (args.target.id || args.target) : undefined;
              if (!selected) return true; // aucun filtre sélectionné
              return state && state.target ? state.target === selected : false;
            } catch (e) {
              self.error(`period_option_became run listener failed: ${e && e.message ? e.message : e}`);
              return false;
            }
          });
          // Autocomplete pour l'argument "target" de la carte trigger
          self._periodOptionBecameCard.registerArgumentAutocompleteListener('target', async (query, args) => {
            const PERIOD_OPTIONS = [
              {
                id: 'TH..',
                name: 'Toutes Heures'
              },
              {
                id: 'HC..',
                name: 'Heures Creuses'
              },
              {
                id: 'HP..',
                name: 'Heures Pleines'
              },
              {
                id: 'HN..',
                name: 'Heures Normales'
              },
              {
                id: 'PM..',
                name: 'Pointe Mobile'
              },
              {
                id: 'HCJB',
                name: 'HC Jour Bleu'
              },
              {
                id: 'HCJW',
                name: 'HC Jour Blanc'
              },
              {
                id: 'HCJR',
                name: 'HC Jour Rouge'
              },
              {
                id: 'HPJB',
                name: 'HP Jour Bleu'
              },
              {
                id: 'HPJW',
                name: 'HP Jour Blanc'
              },
              {
                id: 'HPJR',
                name: 'HP Jour Rouge'
              },
              {
                id: 'UNKN',
                name: 'Inconnu'
              },
            ];
            const q = (query || '').toString()
              .toLowerCase();
            if (!q) return PERIOD_OPTIONS;
            return PERIOD_OPTIONS.filter(opt =>
              opt.id.toLowerCase()
                .includes(q) || (opt.name && opt.name.toLowerCase()
                .includes(q))
            );
          });
        } catch (e) {
          self.error(`Failed to register trigger card period_option_became: ${e && e.message ? e.message : e}`);
        }

        // Carte de déclenchement "le tarif fournisseur change" (mode standard, NTARF)
        try {
          self._supplierTariffChangedCard = self.homey.flow.getDeviceTriggerCard('supplier_tariff_changed');
        } catch (e) {
          self.error(`Failed to register trigger card supplier_tariff_changed: ${e && e.message ? e.message : e}`);
        }

        // Enregistre les cartes de déclenchement Flow pour les couleurs Tempo
        try {
          // Couleur d'aujourd'hui
          self._todayColorBecameCard = self.homey.flow.getDeviceTriggerCard('today_color_became');
          // Couleur de demain
          self._tomorrowColorBecameCard = self.homey.flow.getDeviceTriggerCard('tomorrow_color_became');

          // Options possibles pour la couleur Tempo, alignées avec driver.flow.compose.json & app.json
          const TEMPO_COLOR_OPTIONS = [
            { id: 'BLEU', name: 'Bleu' },
            { id: 'BLAN', name: 'Blanc' },
            { id: 'ROUG', name: 'Rouge' },
            { id: '----', name: 'Non connu' },
          ];

          // --- TODAY COLOR ---
          if (self._todayColorBecameCard) {
            // Run listener pour permettre le filtrage sur la couleur choisie dans la carte Flow
            self._todayColorBecameCard.registerRunListener(async (args, state) => {
              try {
                const selected = args && args.target ? (args.target.id || args.target) : undefined;
                if (!selected) return true; // aucun filtre sélectionné dans la carte
                return state && state.target ? state.target === selected : false;
              } catch (e) {
                self.error(`today_color_became run listener failed: ${e && e.message ? e.message : e}`);
                return false;
              }
            });

            // Autocomplete pour l'argument "target" de la carte today_color_became
            self._todayColorBecameCard.registerArgumentAutocompleteListener('target', async (query, args) => {
              const q = (query || '').toString().toLowerCase();
              if (!q) return TEMPO_COLOR_OPTIONS;
              return TEMPO_COLOR_OPTIONS.filter(opt =>
                opt.id.toLowerCase().includes(q) ||
                (opt.name && opt.name.toLowerCase().includes(q))
              );
            });
          }

          // --- TOMORROW COLOR ---
          if (self._tomorrowColorBecameCard) {
            // Run listener pour permettre le filtrage sur la couleur choisie dans la carte Flow
            self._tomorrowColorBecameCard.registerRunListener(async (args, state) => {
              try {
                const selected = args && args.target ? (args.target.id || args.target) : undefined;
                if (!selected) return true; // aucun filtre sélectionné dans la carte
                return state && state.target ? state.target === selected : false;
              } catch (e) {
                self.error(`tomorrow_color_became run listener failed: ${e && e.message ? e.message : e}`);
                return false;
              }
            });

            // Autocomplete pour l'argument "target" de la carte tomorrow_color_became
            self._tomorrowColorBecameCard.registerArgumentAutocompleteListener('target', async (query, args) => {
              const q = (query || '').toString().toLowerCase();
              if (!q) return TEMPO_COLOR_OPTIONS;
              return TEMPO_COLOR_OPTIONS.filter(opt =>
                opt.id.toLowerCase().includes(q) ||
                (opt.name && opt.name.toLowerCase().includes(q))
              );
            });
          }
        } catch (e) {
          self.error(`Failed to register trigger cards today_color_became / tomorrow_color_became: ${e && e.message ? e.message : e}`);
        }

        // Mémorise les dernières valeurs connues pour la période et les couleurs Tempo
        self._lastPeriod = self.getCapabilityValue('price_period_capability');
        self._lastTodayColor = self.getCapabilityValue('today_color_capability');
        self._lastTomorrowColor = self.getCapabilityValue('tomorrow_color_capability');
        // Timestamp du dernier changement de période effectivement appliqué (en ms, Date.now())
        self._lastPeriodChangeTs = 0;

        // Helper: met à jour la capability de période et déclenche le Flow si elle change
        // Ajout d'un verrou temporel de 20 secondes pour éviter les bascules multiples HP/HC
        self._updatePeriodIfChanged = async (newValue) => {
          try {
            if (!newValue) return;
            const prev = self._lastPeriod;
            if (prev !== newValue) {
              const now = Date.now();
              const lastChange = self._lastPeriodChangeTs || 0;
              const delta = now - lastChange;

              // Si le dernier changement effectif date de moins de 20s, on ignore ce nouveau changement
              if (delta < 20000) {
                self.log(`[PERIOD] Changement ignoré (${prev} -> ${newValue}) car dernier changement il y a ${Math.round(delta / 1000)}s (<20s)`);
                return;
              }

              self._lastPeriod = newValue;
              if (self.hasCapability('price_period_capability')) {
                await self.setCapabilityValue('price_period_capability', newValue);
              }
              self._lastPeriodChangeTs = now;
              if (self._periodOptionBecameCard) {
                await self._periodOptionBecameCard.trigger(self, { target: newValue }, { target: newValue });
                self.log(`Flow trigger 'period_option_became' fired (target=${newValue})`);
              }
            }
          } catch (e) {
            self.error(`update/trigger price_period_capability failed: ${e && e.message ? e.message : e}`);
          }
        };

        // Helpers: mettent à jour les capabilities de couleur Tempo et déclenchent les Flows si besoin
        self._updateTodayColorIfChanged = async (newValue) => {
          try {
            if (newValue === null || newValue === undefined) return;
            const prev = self._lastTodayColor;
            if (prev !== newValue) {
              self.log(`[TODAY] Changement détecté: ${prev} -> ${newValue}`);
              if (self._todayColorBecameCard) {
                await self._todayColorBecameCard
                  .trigger(self, { target: newValue }, { target: newValue })
                  .catch(err => self.error('Error triggering today_color_became card:', err));
              }
              await self.setCapabilityValue('today_color_capability', newValue);
              self._lastTodayColor = newValue;
            }
          } catch (e) {
            self.error(`update/trigger today_color_capability failed: ${e && e.message ? e.message : e}`);
          }
        };

        self._updateTomorrowColorIfChanged = async (newValue) => {
          try {
            if (newValue === null || newValue === undefined) return;
            const prev = self._lastTomorrowColor;
            if (prev !== newValue) {
              self.log(`[TOMORROW] Changement détecté: ${prev} -> ${newValue}`);
              if (self._tomorrowColorBecameCard) {
                await self._tomorrowColorBecameCard
                  .trigger(self, { target: newValue }, { target: newValue })
                  .catch(err => self.error('Error triggering tomorrow_color_became card:', err));
              }
              await self.setCapabilityValue('tomorrow_color_capability', newValue);
              self._lastTomorrowColor = newValue;
            }
          } catch (e) {
            self.error(`update/trigger tomorrow_color_capability failed: ${e && e.message ? e.message : e}`);
          }
        };

        setInterval(async () => {
          try {
            // 0x000D = ISOUSC (A) en historique, PREF (kVA) en standard; 0x000E = PCOUP (kVA).
            // Lecture brute: décodage selon le type envoyé, et statut visible dans Debug.
            let ident;
            try {
              ident = await RawAttributes.readRaw(
                zclNode.endpoints[self.getClusterEndpoint(MeterIdentificationCluster)]
                  .clusters[MeterIdentificationCluster.NAME],
                [0x000D, 0x000E]
              );
            } catch (e) {
              self._diag = { ...(self._diag || {}), pref: 'err', pcoup: 'err' };
              throw e;
            }
            const valueOf = r => (r && r.status === 0 ? r.value : undefined);
            const subscribeIntensity = valueOf(ident[0x000D]);
            const powerThreshold = valueOf(ident[0x000E]);
            self._diag = {
              ...(self._diag || {}),
              pref: RawAttributes.describe(ident[0x000D]),
              pcoup: RawAttributes.describe(ident[0x000E]),
            };

            if (self.getCapabilityValue('mode_capability') === 'standard') {
              const kva = [subscribeIntensity, powerThreshold].map(Number).find(v => Number.isFinite(v) && v > 0);
              if (self.hasCapability('subscribed_power_capability')) {
                await self.setCapabilityValue('subscribed_power_capability', kva ?? null);
              }
            } else if (self.hasCapability('subscribe_intensity_capability') && subscribeIntensity !== undefined) {
              await self.setCapabilityValue('subscribe_intensity_capability', subscribeIntensity);
            }

            self.log(`Cluster meter identification return response correctly`);
          } catch (e) {
            self.log(`Something wrong with zigbee cluster and message : ${e.message}, app will retry later `);
          }
        }, 10000);

        setInterval(async () => {
          try {
            const {
              subscribePowerAlert,
            } = await zclNode.endpoints[self.getClusterEndpoint(LixeePrivateCluster)]
              .clusters[LixeePrivateCluster.NAME]
              .readAttributes([
                'subscribePowerAlert'
              ]);

            const {
              apparentPowerInstInject,
            } = await zclNode.endpoints[self.getClusterEndpoint(LixeePrivateCluster)]
              .clusters[LixeePrivateCluster.NAME]
              .readAttributes([
                'apparentPowerInstInject'
              ]);

            const {
              clockFullHourEmptyHour,
            } = await zclNode.endpoints[self.getClusterEndpoint(LixeePrivateCluster)]
              .clusters[LixeePrivateCluster.NAME]
              .readAttributes([
                'clockFullHourEmptyHour'
              ]);

            let tomorrowRaw = null;
            // En mode standard, on n'actualise la couleur que si registerStatus est lu avec succès
            // Laisser à null pour ne pas écraser l'ancienne valeur en cas d'échec
            let normTomorrow = null;
            let normToday = null;

            // On continue à mettre à jour la capability d'option tarifaire pour compatibilité existante
            await self._updatePriceOptionIfChanged(priceOption);

            // Couleurs Tempo (et API en ligne de secours) uniquement pour un contrat Tempo / BBR:
            // sinon le registre de statuts ne porte aucune couleur et l'heuristique d'inversion
            // d'octets ou l'API produisaient une couleur sans objet.
            const tempoContract = self._isTempoContract(priceOption);

            if (self.getCapabilityValue('mode_capability') === 'standard') {
              // lecture du registre de statuts STGE: couleur du jour (bits 24-25) et de demain
              // (bits 26-27) pour Tempo, dépassement de puissance (bit 7) pour l'alarme
              try {
                const { registerStatus } = await zclNode.endpoints[self.getClusterEndpoint(LixeePrivateCluster)]
                  .clusters[LixeePrivateCluster.NAME]
                  .readAttributes([
                    'registerStatus'
                  ]);
                tomorrowRaw = registerStatus;
                // Parse en entier non signé avant l'extraction de la couleur
                let regDec = self._parseRegisterToUint32(registerStatus);
                self._lastStge = regDec;
                if (tempoContract) {
                  normTomorrow = self._extractTomorrowFromRegister(regDec);
                  normToday = self._extractTodayFromRegister(regDec);
                }

                try {
                  const debugValue = self._buildDebugValue(priceOption, regDec, tempoContract, normToday, normTomorrow);
                  if (self.hasCapability('debug_capability') && self.getCapabilityValue('debug_capability') !== debugValue) {
                    await self.setCapabilityValue('debug_capability', debugValue);
                  }
                } catch (e) {
                  self.log(`[DEBUG CAP] set failed: ${e && e.message ? e.message : e}`);
                }
              } catch (e) {
                // Plus de fallback en mode standard: on log l'erreur et on n'écrase pas la valeur courante
                self.log(`[WARN] registerStatus read failed (standard mode, no fallback): ${e && e.message ? e.message : e}`);
              }
              if (self.hasCapability('apparent_power_instant_inject_capability')) {
                await self.setCapabilityValue('apparent_power_instant_inject_capability', apparentPowerInstInject ? apparentPowerInstInject : 0);
              }
            } else {
              // Mode historique/Tempo: lecture tomorrowColor (texte) puis normalisation
              if (tempoContract) try {
                const { tomorrowColor } = await zclNode.endpoints[self.getClusterEndpoint(LixeePrivateCluster)]
                  .clusters[LixeePrivateCluster.NAME]
                  .readAttributes([
                    'tomorrowColor'
                  ]);
                tomorrowRaw = tomorrowColor;
                normTomorrow = self._normalizeTomorrowColor(tomorrowColor);
                normToday = '----';

              } catch (e) {
                self.log(`[WARN] tomorrowColor read failed (historique): ${e && e.message ? e.message : e}`);
              }
            }

            if (self.hasCapability('clock_full_hour_empty_hour_capability')) {
              await self.setCapabilityValue('clock_full_hour_empty_hour_capability', clockFullHourEmptyHour);
            }
            // N'actualise la capability que si on a une valeur normalisée valide
            // Fallback API Tempo si aujourd'hui ET demain sont inconnus ('----')
            try {
              const todayUnknown = tempoContract && (normToday === null || normToday === '----');
              const tomorrowUnknown = tempoContract && (normTomorrow === null || normTomorrow === '----');
              if (todayUnknown) {
                const apiColor = await self._fetchTempoTodayColor();
                if (apiColor) {
                  self.log(`[TEMPO API] Fallback utilisé, couleur de d'aujourd'hui depuis API: ${apiColor}`);
                  normToday = apiColor;
                } else {
                  self.log('[TEMPO API] Fallback demandé mais aucune couleur valide retournée');
                }
              }

              if (tomorrowUnknown) {
                const apiColor = await self._fetchTempoTomorrowColor();
                if (apiColor) {
                  self.log(`[TEMPO API] Fallback utilisé, couleur de demain depuis API: ${apiColor}`);
                  normTomorrow = apiColor;
                } else {
                  self.log('[TEMPO API] Fallback demandé mais aucune couleur valide retournée');
                }
              }
            } catch (e) {
              self.log(`[TEMPO API] Erreur lors du fallback: ${e && e.message ? e.message : e}`);
            }

            if (normTomorrow !== null && self.hasCapability('tomorrow_color_capability')) {
              self.log(`[TOMORROW] Raw='${tomorrowRaw}' -> Normalized='${normTomorrow}'`);
              await self._updateTomorrowColorIfChanged(normTomorrow);
            }

            if (normToday !== null && self.hasCapability('today_color_capability')) {
              self.log(`[TODAY] Raw='${tomorrowRaw}' -> Normalized='${normToday}'`);
              await self._updateTodayColorIfChanged(normToday);
            }

            // Historique: ADPS (avertissement de dépassement). Standard: bit 7 du registre de
            // statuts STGE (« dépassement de la puissance de référence »), ADPS n'existant pas.
            const overpower = (self.getCapabilityValue('mode_capability') === 'standard')
              ? (Number.isFinite(self._lastStge) ? ((self._lastStge >>> 7) & 1) === 1 : null)
              : (Number.isFinite(Number(subscribePowerAlert)) ? Number(subscribePowerAlert) !== 0 : null);
            await self._updateOverpowerAlarm(overpower);

            self.log(`Cluster lixee private return response correctly`);
          } catch (e) {
            self.log(`Something wrong with zigbee cluster and message : ${e.message}, app will retry later `);
          }
        }, 10000);

        setInterval(async () => {
          try {
            let {
              rmsVoltage,
              rmsCurrent,
              activePower,
              apparentPower,
              maximalIntensity,
              measurementType,
              phase2ApparentPower,
              phase3ApparentPower,
            } = await zclNode.endpoints[self.getClusterEndpoint(CLUSTER.ELECTRICAL_MEASUREMENT)]
              .clusters[CLUSTER.ELECTRICAL_MEASUREMENT.NAME]
              .readAttributes([
                'rmsVoltage',
                'rmsCurrent',
                'activePower',
                'apparentPower',
                'maximalIntensity',
                'measurementType',
                'phase2ApparentPower',
                'phase3ApparentPower'
              ]);

            // 0xFFFF = valeur "non disponible" Zigbee: on ne peut pas conclure à l'absence de mesure
            const phase2Unavailable = (phase2ApparentPower == undefined || phase2ApparentPower == 65535);
            const phase3Unavailable = (phase3ApparentPower == undefined || phase3ApparentPower == 65535);

            if (phase2Unavailable) {
              phase2ApparentPower = 0;
            }

            if (phase3Unavailable) {
              phase3ApparentPower = 0;
            }

            if (self.hasCapability('phase_capability') && self.getCapabilityValue('phase_capability') == 'triphase' && phase2ApparentPower == 0 && phase3ApparentPower == 0 && !phase2Unavailable && !phase3Unavailable) {
              if (self.hasCapability('phase_1_apparent_power_capability')) {
                await self.removeCapability('phase_1_apparent_power_capability')
                  .catch(this.error);
              }

              if (self.hasCapability('phase_2_apparent_power_capability')) {
                await self.removeCapability('phase_2_apparent_power_capability')
                  .catch(this.error);
              }

              if (self.hasCapability('phase_3_apparent_power_capability')) {
                await self.removeCapability('phase_3_apparent_power_capability')
                  .catch(this.error);
              }

              await self.setCapabilityValue('phase_capability', 'monophase');
              // Mémorisé pour que prepareMode ne rajoute pas les capabilities de phase au
              // prochain démarrage: l'ordre des capabilities reste ainsi stable
              await self.setStoreValue(PHASE_OVERRIDE_STORE, 'monophase')
                .catch(self.error);
            } else if (self.getStoreValue(PHASE_OVERRIDE_STORE) === 'monophase'
              && (phase2ApparentPower > 0 || phase3ApparentPower > 0)) {
              // Le compteur mesure à nouveau sur les phases 2 et 3: on annule le repli, les
              // capabilities de phase reviendront au prochain démarrage
              self.log('[INFO] Mesures présentes sur les phases 2 et 3, repli monophasé annulé');
              await self.unsetStoreValue(PHASE_OVERRIDE_STORE)
                .catch(self.error);
            }

            if (self.hasCapability('phase_capability') && self.getCapabilityValue('phase_capability') == 'triphase') {
              await self.setCapabilityValue('phase_1_apparent_power_capability', apparentPower);
              await self.setCapabilityValue('phase_2_apparent_power_capability', phase2ApparentPower ?? 0);
              await self.setCapabilityValue('phase_3_apparent_power_capability', phase3ApparentPower ?? 0);
              await self._applyPowerTitle();
              await self.setCapabilityValue('measure_power', self._powerForHomeyEnergy(parseInt(apparentPower) + parseInt(phase2ApparentPower ?? 0) + parseInt(phase3ApparentPower ?? 0)));
            } else {
              await self._applyPowerTitle();
              await self.setCapabilityValue('measure_power', self._powerForHomeyEnergy(apparentPower));
            }

            if (self.hasCapability('active_power_capability')) {
              await self.setCapabilityValue('active_power_capability', activePower);
            }
            await self.setCapabilityValue('rms_current_capability', rmsCurrent);
            if (self.hasCapability('rms_voltage_capability')) {
              await self.setCapabilityValue('rms_voltage_capability', rmsVoltage);
            }
            if (self.hasCapability('maximal_intensity_capability')) {
              await self.setCapabilityValue('maximal_intensity_capability', maximalIntensity);
            }

            if (self.getCapabilityValue('mode_capability') === 'standard') {
              await self._readMaxApparentPower(zclNode);
            }

            self.log(`Cluster electrical measurement return response correctly`);
          } catch (e) {
            self.log(`Something wrong with zigbee cluster and message : ${e.message}, app will retry later `);
          }
        }, 10000);

        setInterval(async () => {
          try {
            let {
              currentSummationDelivered,
              activeEnergyTotalInjected,
              serialNumber,
            } = await zclNode.endpoints[self.getClusterEndpoint(CLUSTER.METERING)]
              .clusters[CLUSTER.METERING.NAME]
              .readAttributes([
                'currentSummationDelivered',
                'activeEnergyTotalInjected',
                'serialNumber'
              ]);

            await self.setCapabilityValue('serial_number_capability', serialNumber);

            // Index bruts en Wh, collectés au fil des branches pour la valorisation
            // monétaire (voir _updateDailyCost)
            const indexes = { total: Number(currentSummationDelivered) };

            if (self.getCapabilityValue('price_option_capability') === 'BASE') {
              if (currentSummationDelivered != 0) {
                if (currentSummationDelivered != self.getCapabilityValue('meter_power.imported')) {
                  await self._updatePeriodIfChanged('TH..');
                  await self.setCapabilityValue('meter_power', (currentSummationDelivered / 1000));
                  await self.setCapabilityValue('meter_power.imported', (currentSummationDelivered / 1000));
                }
              }
            }

            if (self.getCapabilityValue('price_option_capability') === 'HPHC') {
              let {
                currentSummationDeliveredHC,
                currentSummationDeliveredHP,
              } = await zclNode.endpoints[self.getClusterEndpoint(CLUSTER.METERING)]
                .clusters[CLUSTER.METERING.NAME]
                .readAttributes([
                  'currentSummationDeliveredHC',
                  'currentSummationDeliveredHP',
                ]);

              indexes.hp = Number(currentSummationDeliveredHP);
              indexes.hc = Number(currentSummationDeliveredHC);

              // En mode standard, l'index total vient de EAST (voir _readStandardSupplierIndexes):
              // la somme EASF01 + EASF02 ignore les autres index fournisseur (mercredi, week-end...).
              if (self.getCapabilityValue('mode_capability') !== 'standard') {
                let cumulativeIndex = Math.floor((currentSummationDeliveredHP ?? 0) / 1000) + Math.floor((currentSummationDeliveredHC ?? 0) / 1000);
                await self.setCapabilityValue('meter_power', cumulativeIndex);
                await self.setCapabilityValue('meter_power.imported', cumulativeIndex);
              }

              self.log(`currentSummationDeliveredHP=${currentSummationDeliveredHP} currentSummationDeliveredHC=${currentSummationDeliveredHC}`);
              self.log(`hpLastValue=${hpLastValue} hcLastValue=${hcLastValue}`);
              self.log(`[PERIOD] brut HP(0x0102)=${currentSummationDeliveredHP} Wh (delta ${hpLastValue ? currentSummationDeliveredHP - hpLastValue : 'n/a'}) | HC(0x0100)=${currentSummationDeliveredHC} Wh (delta ${hcLastValue ? currentSummationDeliveredHC - hcLastValue : 'n/a'}) | période actuelle=${self._lastPeriod}${await self._readCurrentTariffLabel(zclNode)}`);

              if (hpLastValue == 0) {
                hpLastValue = currentSummationDeliveredHP;
              }

              if (currentSummationDeliveredHP != hpLastValue) {
                hpLastValue = currentSummationDeliveredHP;
                if (self._periodFromDeltas()) await self._updatePeriodIfChanged('HP..');
              }

              currentSummationDeliveredHP = Math.floor((currentSummationDeliveredHP ?? 0) / 1000);
              if (self.hasCapability('full_hour_capability')) {
                await self.setCapabilityValue('full_hour_capability', currentSummationDeliveredHP);
              }

              if (hcLastValue == 0) {
                hcLastValue = currentSummationDeliveredHC;
              }

              if (currentSummationDeliveredHC != hcLastValue) {
                hcLastValue = currentSummationDeliveredHC;
                if (self._periodFromDeltas()) await self._updatePeriodIfChanged('HC..');
              }

              currentSummationDeliveredHC = Math.floor((currentSummationDeliveredHC ?? 0) / 1000);
              if (self.hasCapability('empty_hour_capability')) {
                await self.setCapabilityValue('empty_hour_capability', currentSummationDeliveredHC);
              }
            }

            if (self.getCapabilityValue('price_option_capability') === 'TEMPO' || self.getCapabilityValue('price_option_capability') === 'BBR' || self.getCapabilityValue('price_option_capability') === 'EJP.') {
              let {
                currentSummationDeliveredHC,
                currentSummationDeliveredHP,
                currentSummationDeliveredHCW,
                currentSummationDeliveredHPW,
                currentSummationDeliveredHCR,
                currentSummationDeliveredHPR,
              } = await zclNode.endpoints[self.getClusterEndpoint(CLUSTER.METERING)]
                .clusters[CLUSTER.METERING.NAME]
                .readAttributes([
                  'currentSummationDeliveredHC',
                  'currentSummationDeliveredHP',
                  'currentSummationDeliveredHCW',
                  'currentSummationDeliveredHPW',
                  'currentSummationDeliveredHCR',
                  'currentSummationDeliveredHPR',
                ]);

              indexes.hp = Number(currentSummationDeliveredHP);
              indexes.hc = Number(currentSummationDeliveredHC);
              indexes.hpw = Number(currentSummationDeliveredHPW);
              indexes.hcw = Number(currentSummationDeliveredHCW);
              indexes.hpr = Number(currentSummationDeliveredHPR);
              indexes.hcr = Number(currentSummationDeliveredHCR);

              await self.setCapabilityValue('meter_power', (currentSummationDelivered / 1000));
              await self.setCapabilityValue('meter_power.imported', (currentSummationDelivered / 1000));

              self.log(`currentSummationDeliveredHP=${currentSummationDeliveredHP} currentSummationDeliveredHC=${currentSummationDeliveredHC}`);
              self.log(`hpLastBlueValue=${hpBlueLastValue} hcBlueLastValue=${hcBlueLastValue}`);
              self.log(`currentSummationDeliveredHP=${currentSummationDeliveredHP} currentSummationDeliveredHC=${currentSummationDeliveredHC}`);
              self.log(`hpLastWhiteValue=${hpWhiteLastValue} hcWhiteLastValue=${hcWhiteLastValue}`);
              self.log(`currentSummationDeliveredHP=${currentSummationDeliveredHP} currentSummationDeliveredHC=${currentSummationDeliveredHC}`);
              self.log(`hpLastRedValue=${hpRedLastValue} hcRedLastValue=${hcRedLastValue}`);
              const rawDelta = (current, last) => (last ? current - last : 'n/a');
              self.log(`[PERIOD] brut HPJB(0x0102)=${currentSummationDeliveredHP} (delta ${rawDelta(currentSummationDeliveredHP, hpBlueLastValue)}) HCJB(0x0100)=${currentSummationDeliveredHC} (delta ${rawDelta(currentSummationDeliveredHC, hcBlueLastValue)}) | HPJW(0x0106)=${currentSummationDeliveredHPW} (delta ${rawDelta(currentSummationDeliveredHPW, hpWhiteLastValue)}) HCJW(0x0104)=${currentSummationDeliveredHCW} (delta ${rawDelta(currentSummationDeliveredHCW, hcWhiteLastValue)}) | HPJR(0x010A)=${currentSummationDeliveredHPR} (delta ${rawDelta(currentSummationDeliveredHPR, hpRedLastValue)}) HCJR(0x0108)=${currentSummationDeliveredHCR} (delta ${rawDelta(currentSummationDeliveredHCR, hcRedLastValue)}) | période actuelle=${self._lastPeriod}${await self._readCurrentTariffLabel(zclNode)}`);

              if (hpBlueLastValue == 0) {
                hpBlueLastValue = currentSummationDeliveredHP;
              }

              // currentSummationDeliveredHP = Jour bleu
              if (currentSummationDeliveredHP != hpBlueLastValue) {
                hpBlueLastValue = currentSummationDeliveredHP;
                await self._updatePeriodIfChanged('HP..');
              }

              currentSummationDeliveredHP = Math.floor((currentSummationDeliveredHP ?? 0) / 1000);
              await self.setCapabilityValue('full_hour_blue_capability', currentSummationDeliveredHP);

              if (hcBlueLastValue == 0) {
                hcBlueLastValue = currentSummationDeliveredHC;
              }

              // currentSummationDeliveredHP = Jour bleu
              if (currentSummationDeliveredHC != hcBlueLastValue) {
                hcBlueLastValue = currentSummationDeliveredHC;
                await self._updatePeriodIfChanged('HC..');
              }

              currentSummationDeliveredHC = Math.floor((currentSummationDeliveredHC ?? 0) / 1000);
              await self.setCapabilityValue('empty_hour_blue_capability', currentSummationDeliveredHC);

              if (hpWhiteLastValue == 0) {
                hpWhiteLastValue = currentSummationDeliveredHPW;
              }

              if (currentSummationDeliveredHPW != hpWhiteLastValue) {
                hpWhiteLastValue = currentSummationDeliveredHPW;
                await self._updatePeriodIfChanged('HP..');
              }

              currentSummationDeliveredHPW = Math.floor((currentSummationDeliveredHPW ?? 0) / 1000);
              await self.setCapabilityValue('full_hour_white_capability', currentSummationDeliveredHPW);

              if (hcWhiteLastValue == 0) {
                hcWhiteLastValue = currentSummationDeliveredHCW;
              }

              if (currentSummationDeliveredHCW != hcWhiteLastValue) {
                hcWhiteLastValue = currentSummationDeliveredHCW;
                await self._updatePeriodIfChanged('HC..');
              }

              currentSummationDeliveredHCW = Math.floor((currentSummationDeliveredHCW ?? 0) / 1000);
              await self.setCapabilityValue('empty_hour_white_capability', currentSummationDeliveredHCW);

              if (hpRedLastValue == 0) {
                hpRedLastValue = currentSummationDeliveredHPR;
              }

              if (currentSummationDeliveredHPR != hpRedLastValue) {
                hpRedLastValue = currentSummationDeliveredHPR;
                await self._updatePeriodIfChanged('HP..');
              }

              currentSummationDeliveredHPR = Math.floor((currentSummationDeliveredHPR ?? 0) / 1000);
              await self.setCapabilityValue('full_hour_red_capability', currentSummationDeliveredHPR);

              if (hcRedLastValue == 0) {
                hcRedLastValue = currentSummationDeliveredHCR;
              }

              if (currentSummationDeliveredHCR != hcRedLastValue) {
                hcRedLastValue = currentSummationDeliveredHCR;
                await self._updatePeriodIfChanged('HC..');
              }

              currentSummationDeliveredHCR = Math.floor((currentSummationDeliveredHCR ?? 0) / 1000);
              await self.setCapabilityValue('empty_hour_red_capability', currentSummationDeliveredHCR);
            }

            // Mode standard: index fournisseur EASF01..EASF10 et index tarifaire en cours
            // (NTARF / LTARF), quelle que soit l'offre. Erreur isolée: le reste du cycle continue.
            if (self.getCapabilityValue('mode_capability') === 'standard') {
              try {
                await self._readStandardSupplierIndexes(zclNode, indexes, currentSummationDelivered);
              } catch (e) {
                self._nextTariffChange = null;
                self.log(`[STANDARD] Lecture des index fournisseur impossible: ${e && e.message ? e.message : e}`);
              }
            }

            await self.setCapabilityValue('meter_power.exported', activeEnergyTotalInjected ? (activeEnergyTotalInjected / 1000) : 0);

            await self._updateDailyCost(indexes);

            self.log(`Cluster metering return response correctly`);
          } catch (e) {
            self.log(`Something wrong with zigbee cluster and message : ${e.message}, app will retry later `);
          }
        }, 10000);
      } catch (e) {
        self.error(e);
        //retry in 3 seconds
        setTimeout(doInit, 3000);
      }
    }
  }

  // Liste les capabilities pertinentes pour ce compteur: mode (historique/standard),
  // nombre de phases et option tarifaire. Les autres sont toujours présentes.
  _computeApplicableCapabilities(mode, phase, priceOption, producteur = false) {
    const CONDITIONAL_CAPABILITIES = [
      'full_hour_capability',
      'empty_hour_capability',
      'full_hour_blue_capability',
      'empty_hour_blue_capability',
      'full_hour_white_capability',
      'empty_hour_white_capability',
      'full_hour_red_capability',
      'empty_hour_red_capability',
      'apparent_power_instant_inject_capability',
      'supplier_tariff_capability',
      'estimated_active_power_capability',
      // Historique uniquement (ISOUSC, IMAX, HHPHC): absents ou sans objet en mode standard.
      // PTEC (période): historique, ou standard avec une option HP/HC, Tempo ou EJP.
      'subscribe_intensity_capability',
      'maximal_intensity_capability',
      'clock_full_hour_empty_hour_capability',
      'price_period_capability',
      // Standard uniquement (URMS1, CCASN, programme tarifaire)
      'rms_voltage_capability',
      'active_power_capability',
      'next_tariff_change_capability',
      'tomorrow_schedule_capability',
      // Standard uniquement (PREF/PCOUP, SMAXSN, SMAXSN-1)
      'subscribed_power_capability',
      'max_apparent_power_today_capability',
      'max_apparent_power_yesterday_capability',
      // Couleurs Tempo: seulement pour un contrat Tempo / BBR
      'today_color_capability',
      'tomorrow_color_capability',
      'phase_1_apparent_power_capability',
      'phase_2_apparent_power_capability',
      'phase_3_apparent_power_capability'
    ];

    const applicable = new Set(
      CAPABILITY_ORDER.filter(capability => !CONDITIONAL_CAPABILITIES.includes(capability))
    );

    // Offre HP/HC en mode standard qui utilise plus de deux index fournisseur (mercredi,
    // week-end...): les index HP (EASF02) et HC (EASF01) n'en couvrent qu'une partie, et la
    // période ne s'en déduit pas. Le tarif en cours est donné par « Tarif fournisseur » et
    // « Prix du kWh actuel », le coût par les prix par index fournisseur.
    this._layoutMultiIndex = this._usesExtraSupplierIndexes();
    const multiIndexHpHc = mode === 'standard' && HPHC_OPTIONS.includes(priceOption) && this._layoutMultiIndex;

    if (HP_HC_PRICE_OPTIONS.includes(priceOption) && !multiIndexHpHc) {
      applicable.add('full_hour_capability');
      applicable.add('empty_hour_capability');
    }

    if (COLORED_PRICE_OPTIONS.includes(priceOption)) {
      applicable.add('full_hour_blue_capability');
      applicable.add('empty_hour_blue_capability');
      applicable.add('full_hour_white_capability');
      applicable.add('empty_hour_white_capability');
      applicable.add('full_hour_red_capability');
      applicable.add('empty_hour_red_capability');
    }

    if (mode === 'standard') {
      // SINSTI n'est transmis qu'en mode standard producteur
      if (producteur) applicable.add('apparent_power_instant_inject_capability');
      applicable.add('supplier_tariff_capability');
      applicable.add('next_tariff_change_capability');
      applicable.add('tomorrow_schedule_capability');
      applicable.add('rms_voltage_capability');
      applicable.add('active_power_capability');
      // Tuile séparée inutile quand la tuile principale affiche déjà la puissance active estimée
      if (this._powerSource() !== 'active_estimated') applicable.add('estimated_active_power_capability');
      applicable.add('subscribed_power_capability');
      applicable.add('max_apparent_power_today_capability');
      applicable.add('max_apparent_power_yesterday_capability');
    } else {
      applicable.add('subscribe_intensity_capability');
      applicable.add('maximal_intensity_capability');
      applicable.add('clock_full_hour_empty_hour_capability');
    }

    // Période tarifaire: historique (PTEC), et en standard pour les options dont la période est
    // déduite des index HP/HC (comportement de la 1.5.0, cartes Flow « période »), sauf offre
    // HP/HC à plus de deux index (voir plus haut): un même libellé peut y être facturé à des
    // prix différents (« HP MERCREDI » au prix HC).
    if (mode !== 'standard'
      || ((HP_HC_PRICE_OPTIONS.includes(priceOption) || COLORED_PRICE_OPTIONS.includes(priceOption)) && !multiIndexHpHc)) {
      applicable.add('price_period_capability');
    }

    if (this._isTempoContract(priceOption)) {
      applicable.add('today_color_capability');
      applicable.add('tomorrow_color_capability');
    }

    if (phase === 'triphase') {
      applicable.add('phase_1_apparent_power_capability');
      applicable.add('phase_2_apparent_power_capability');
      applicable.add('phase_3_apparent_power_capability');
    }

    return applicable;
  }

  // Aligne les capabilities de l'appareil sur CAPABILITY_ORDER.
  // Homey n'expose aucun réordonnancement: addCapability ajoute toujours en fin de tableau. On ne
  // recrée donc que la queue à partir de la première divergence, ce qui laisse en place — et
  // conserve l'historique Insights de — tout ce qui est déjà bien positionné. Au démarrage suivant
  // l'ordre est déjà correct et cette méthode ne touche plus à rien.
  async _applyCapabilityLayout(applicable) {
    const desired = CAPABILITY_ORDER.filter(capability => applicable.has(capability));

    // Retire ce qui ne s'applique pas à ce compteur, ainsi que les capabilities obsolètes des
    // appareils déjà appairés: power_factor_capability, summation_delivered_capability et les
    // anciens identifiants des coûts sans préfixe 'measure_' (daily_cost_capability,
    // yesterday_cost_capability, current_kwh_price_capability). Ces derniers restent déclarés
    // (masqués) dans .homeycompose/capabilities car removeCapability refuse un identifiant absent
    // du manifeste ("Invalid Capability"); ils pourront être supprimés une fois les appareils
    // migrés.
    for (const capability of [...this.getCapabilities()]) {
      if (!desired.includes(capability)) {
        await this.removeCapability(capability)
          .then(() => this.log(`[LAYOUT] Capability retirée: ${capability}`))
          .catch(e => this.error(`[LAYOUT] removeCapability(${capability}) a échoué: ${e && e.message ? e.message : e}`));
      }
    }

    const current = this.getCapabilities();
    let firstMismatch = 0;
    while (firstMismatch < desired.length && current[firstMismatch] === desired[firstMismatch]) {
      firstMismatch++;
    }

    if (firstMismatch >= desired.length) {
      this.log('[LAYOUT] Ordre des capabilities déjà correct');
      return false;
    }

    this.log(`[LAYOUT] Réordonnancement à partir de ${desired[firstMismatch]} (${desired.length - firstMismatch} capabilities)`);

    for (let i = firstMismatch; i < desired.length; i++) {
      const capability = desired[i];

      if (this.hasCapability(capability)) {
        await this.removeCapability(capability)
          .catch(e => this.error(`[LAYOUT] removeCapability(${capability}) a échoué: ${e && e.message ? e.message : e}`));
      }

      await this.addCapability(capability)
        .catch(e => this.error(`[LAYOUT] addCapability(${capability}) a échoué: ${e && e.message ? e.message : e}`));

      // addCapability ne réinjecte pas les capabilitiesOptions du manifeste
      if (capability === 'measure_power') this._powerTitleKey = null;
      if (CAPABILITY_OPTIONS[capability] && this.hasCapability(capability)) {
        await this.setCapabilityOptions(capability, CAPABILITY_OPTIONS[capability])
          .catch(e => this.error(`[LAYOUT] setCapabilityOptions(${capability}) a échoué: ${e && e.message ? e.message : e}`));
      }
    }

    return true;
  }

  async getMode(zclNode) {
    return await zclNode.endpoints[this.getClusterEndpoint(LixeePrivateCluster)]
      .clusters[LixeePrivateCluster.NAME]
      .readAttributes([
        'mode'
      ]);
  }

  decodeMode(modeInt) {
    // Maps numeric mode (enum8/uint8) to ['mode', 'phase', 'producteur?']
    // 0: historique_monophase
    // 1: standard_monophase
    // 2: historique_triphase
    // 3: standard_triphase
    // 5: historique_triphase_producteur
    // 7: standard_triphase_producteur
    switch (modeInt) {
      case 0:
        return ['historique', 'monophase'];
      case 1:
        return ['standard', 'monophase'];
      case 2:
        return ['historique', 'triphase'];
      case 3:
        return ['standard', 'triphase'];
      case 5:
        return ['standard', 'monophase', 'producteur'];
      case 7:
        return ['standard', 'triphase', 'producteur'];
      default:
        this.log(`Unknown mode value for 0x0300: ${modeInt} — defaulting to historique_monophase`);
        return ['historique', 'monophase'];
    }
  }

  // Point d'entrée de la mise en place des capabilities: décode le mode du compteur, applique
  // l'ordre canonique puis pose les valeurs décrivant le compteur.
  async prepareMode(currentMode, rawPriceOption) {
    const explodedMode = this.decodeMode(currentMode.mode);
    const priceOption = this._normalizePriceOption(rawPriceOption);
    const [mode, decodedPhase, producteur] = explodedMode;

    this.log(`[INFO] Current mode: ${currentMode.mode}`);
    this.log(`[INFO] Decoded mode: ${explodedMode.join('_')}`);
    this.log(`[INFO] Price option: ${priceOption}`);

    // Un compteur annoncé triphasé mais qui ne mesure rien sur les phases 2 et 3 est traité comme
    // monophasé (voir le cluster electrical measurement). Ce repli est mémorisé: sans lui, les
    // capabilities de phase seraient rajoutées à chaque démarrage.
    const phase = this.getStoreValue(PHASE_OVERRIDE_STORE) === 'monophase' ? 'monophase' : decodedPhase;
    if (phase !== decodedPhase) {
      this.log(`[INFO] Phase forcée à ${phase}: aucune mesure sur les phases 2 et 3`);
    }

    // Mémorisé pour refaire la mise en page quand un réglage d'affichage change
    this._layoutArgs = [mode, phase, priceOption, producteur !== undefined];
    const layoutChanged = await this._applyCapabilityLayout(
      this._computeApplicableCapabilities(...this._layoutArgs)
    );
    // Clé de la mise en page courante: la surveillance du mode la recalcule si elle change
    this._layoutKey = `${currentMode.mode}|${priceOption}`;

    // Le réordonnancement a pu recréer le bouton de maintenance: on réenregistre son listener
    if (layoutChanged) {
      this._resetDailyCostListenerRegistered = false;
      this.registerResetDailyCostListener();
    }

    if (this.hasCapability('mode_capability')) {
      await this.setCapabilityValue('mode_capability', mode)
        .catch(this.error);
    }

    if (this.hasCapability('phase_capability')) {
      await this.setCapabilityValue('phase_capability', phase)
        .catch(this.error);
    }

    if (this.hasCapability('produce_capability')) {
      await this.setCapabilityValue('produce_capability', producteur !== undefined)
        .catch(this.error);
    }

    if (this.hasCapability('debug_capability')) {
      await this.setCapabilityValue(
        'debug_capability',
        `${String(currentMode.mode)}-${explodedMode.join('_')}-${priceOption}`
      )
        .catch(this.error);
    }

    return priceOption;
  }
}

// Helpers
// Appel API Tempo pour récupérer la couleur de demain, avec cache 30 minutes
// Retourne 'BLEU' | 'BLAN' | 'ROUG' | '----' | null en cas d'erreur
Device.prototype._fetchTempoTomorrowColor = async function() {
  try {
    const now = Date.now();
    const THIRTY_MIN = 30 * 60 * 1000;

    // Si le cache est encore valide, on le réutilise sans nouvel appel HTTP
    if (tempoApiCache.tomorrow.timestamp && (now - tempoApiCache.tomorrow.timestamp) < THIRTY_MIN) {
      this.log(`[TEMPO API] [tomorrow] Utilisation du cache (age=${Math.round((now - tempoApiCache.tomorrow.timestamp) / 1000)}s)`);
      return tempoApiCache.tomorrow.couleur;
    }

    this.log('[TEMPO API] Appel HTTP vers https://www.api-couleur-tempo.fr/api/jourTempo/tomorrow');
    const response = await fetch('https://www.api-couleur-tempo.fr/api/jourTempo/tomorrow', {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    if (!response.ok) {
      this.error(`[TEMPO API] Réponse HTTP invalide: ${response.status} ${response.statusText}`);
      // On met tout de même à jour le timestamp pour éviter de spammer l'API
      tempoApiCache.tomorrow.timestamp = now;
      tempoApiCache.tomorrow.couleur = null;
      return null;
    }

    const data = await response.json();
    // Exemple attendu : { "dateJour": "2024-11-08", "codeJour": 0, "periode": "2025-2026", "libCouleur": "Bleu" }
    const libCouleur = data && data.libCouleur;
    const codeJour = data && data.codeJour;

    let couleur = null;
    if (typeof libCouleur === 'string') {
      const u = libCouleur.toUpperCase();
      if (u.startsWith('BLEU')) couleur = 'BLEU';
      else if (u.startsWith('BLAN')) couleur = 'BLAN';
      else if (u.startsWith('ROUG') || u.startsWith('ROUGE')) couleur = 'ROUG';
    }

    // Fallback sur codeJour si jamais libCouleur n'est pas exploitable
    if (!couleur && (codeJour === 0 || codeJour === 1 || codeJour === 2)) {
      switch (codeJour) {
        case 0:
          couleur = 'BLEU';
          break;
        case 1:
          couleur = 'BLAN';
          break;
        case 2:
          couleur = 'ROUG';
          break;
        default:
          couleur = null;
      }
    }

    // Mise à jour du cache, même si couleur est null (pour respecter la limite d'appel)
    tempoApiCache.tomorrow.timestamp = now;
    tempoApiCache.tomorrow.couleur = couleur;

    this.log(`[TEMPO API] Réponse parsée: dateJour=${data && data.dateJour}, codeJour=${codeJour}, libCouleur=${libCouleur}, couleurNormalisee=${couleur}`);
    return couleur;
  } catch (e) {
    this.error(`[TEMPO API] Erreur lors de la récupération de la couleur: ${e && e.message ? e.message : e}`);
    const now = Date.now();
    // On enregistre quand même le timestamp pour ne pas surcharger l'API en cas d'erreur récurrente
    tempoApiCache.tomorrow.timestamp = now;
    return null;
  }
};

// Appel API Tempo pour récupérer la couleur d'aujourd'hui, avec cache 30 minutes
// Retourne 'BLEU' | 'BLAN' | 'ROUG' | '----' | null en cas d'erreur
Device.prototype._fetchTempoTodayColor = async function() {
  try {
    const now = Date.now();
    const THIRTY_MIN = 30 * 60 * 1000;

    // Si le cache est encore valide, on le réutilise sans nouvel appel HTTP
    if (tempoApiCache.today.timestamp && (now - tempoApiCache.today.timestamp) < THIRTY_MIN) {
      this.log(`[TEMPO API] [today] Utilisation du cache (age=${Math.round((now - tempoApiCache.today.timestamp) / 1000)}s)`);
      return tempoApiCache.today.couleur;
    }

    this.log('[TEMPO API] Appel HTTP vers https://www.api-couleur-tempo.fr/api/jourTempo/today');
    const response = await fetch('https://www.api-couleur-tempo.fr/api/jourTempo/today', {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    if (!response.ok) {
      this.error(`[TEMPO API] Réponse HTTP invalide: ${response.status} ${response.statusText}`);
      // On met tout de même à jour le timestamp pour éviter de spammer l'API
      tempoApiCache.today.timestamp = now;
      tempoApiCache.today.couleur = null;
      return null;
    }

    const data = await response.json();
    // Exemple attendu : { "dateJour": "2024-11-08", "codeJour": 0, "periode": "2025-2026", "libCouleur": "Bleu" }
    const libCouleur = data && data.libCouleur;
    const codeJour = data && data.codeJour;

    let couleur = null;
    if (typeof libCouleur === 'string') {
      const u = libCouleur.toUpperCase();
      if (u.startsWith('BLEU')) couleur = 'BLEU';
      else if (u.startsWith('BLAN')) couleur = 'BLAN';
      else if (u.startsWith('ROUG') || u.startsWith('ROUGE')) couleur = 'ROUG';
    }

    // Fallback sur codeJour si jamais libCouleur n'est pas exploitable
    if (!couleur && (codeJour === 0 || codeJour === 1 || codeJour === 2)) {
      switch (codeJour) {
        case 0:
          couleur = 'BLEU';
          break;
        case 1:
          couleur = 'BLAN';
          break;
        case 2:
          couleur = 'ROUG';
          break;
        default:
          couleur = null;
      }
    }

    // Mise à jour du cache, même si couleur est null (pour respecter la limite d'appel)
    tempoApiCache.today.timestamp = now;
    tempoApiCache.today.couleur = couleur;

    this.log(`[TEMPO API] Réponse parsée: dateJour=${data && data.dateJour}, codeJour=${codeJour}, libCouleur=${libCouleur}, couleurNormalisee=${couleur}`);
    return couleur;
  } catch (e) {
    this.error(`[TEMPO API] Erreur lors de la récupération de la couleur: ${e && e.message ? e.message : e}`);
    const now = Date.now();
    // On enregistre quand même le timestamp pour ne pas surcharger l'API en cas d'erreur récurrente
    tempoApiCache.today.timestamp = now;
    return null;
  }
};

// Helpers existants
// Convertit une valeur de registre (number/hex/string) en entier non signé 32 bits
// Retourne un number (0..0xFFFFFFFF) ou null si non parsable
Device.prototype._parseRegisterToUint32 = function(reg) {
  try {
    if (reg === null || reg === undefined) return null;
    if (typeof reg === 'number') return (reg >>> 0);
    let s = String(reg)
      .replace(/\u0000/g, '')
      .trim();
    if (s === '') return null;
    // Retire tout ce qui n'est pas chiffre/hex ou préfixe 0x
    s = s.replace(/[^0-9a-fA-Fx]/g, '');
    let v;
    if (/^0x/i.test(s)) {
      v = parseInt(s, 16);
    } else if (/[a-fA-F]/.test(s)) {
      v = parseInt(s, 16);
    } else {
      v = parseInt(s, 10);
    }
    if (Number.isNaN(v)) return null;
    return (v >>> 0);
  } catch (e) {
    this.error && this.error(`_parseRegisterToUint32 error: ${e && e.message ? e.message : e}`);
    return null;
  }
};
// Normalise la valeur texte de la couleur de demain (mode historique/Tempo)
// Retourne l'une des valeurs: '----', 'BLEU', 'BLAN', 'ROUG'
Device.prototype._normalizeTomorrowColor = function(raw) {
  try {
    if (raw === null || raw === undefined) return '----';
    let s = String(raw);
    // Nettoyage des caractères nuls et espaces
    s = s.replace(/\u0000/g, '')
      .trim();
    if (s === '') return '----';
    const u = s.toUpperCase();
    // Marques d'inconnues fréquentes
    if (u === '----' || u === '---- ----' || u.startsWith('-')) return '----';
    // Préfixes attendus Tempo
    if (u.startsWith('BLEU')) return 'BLEU';
    if (u.startsWith('BLAN')) return 'BLAN'; // BLANC
    if (u.startsWith('ROUG')) return 'ROUG'; // ROUGE
    // Quelques équivalents en anglais, au cas où
    if (u.startsWith('BLUE')) return 'BLEU';
    if (u.startsWith('WHITE')) return 'BLAN';
    if (u.startsWith('RED')) return 'ROUG';
    return '----';
  } catch (e) {
    this.error(`_normalizeTomorrowColor error: ${e && e.message ? e.message : e}`);
    return '----';
  }
};

// Extrait la couleur de DEMAIN (mode standard) depuis registerStatus (uint32)
// Spécification fournie: bits 26 (LSB) et 27 (MSB)
// Mapping: 0=Pas d'annonce, 1=BLEU, 2=BLAN, 3=ROUG
// Retourne: 'BLEU' | 'BLAN' | 'ROUG' | '----' (pas d'annonce) ou null si indéterminé (erreur de parsing)
Device.prototype._extractTomorrowFromRegister = function(reg) {
  try {
    if (reg === null || reg === undefined) return null;
    // On attend désormais un entier (uint32). S'il arrive au format autre, on tente un parse minimal.
    let v = (typeof reg === 'number') ? (reg >>> 0) : this._parseRegisterToUint32(reg);
    if (v === null) return null;

    const decodeFrom = (val) => ((val >>> 26) & 0x03);

    let code = decodeFrom(v);
    // Heuristique endianness: certains firmwares renvoient les octets inversés
    if (code === 0) {
      const swapped = (((v & 0x000000FF) << 24) | ((v & 0x0000FF00) << 8) | ((v & 0x00FF0000) >>> 8) | ((v & 0xFF000000) >>> 24)) >>> 0;
      const alt = decodeFrom(swapped);
      if (alt !== 0) {
        this.log && this.log(`[TOMORROW] using swapped bytes for bits 26-27: code=${alt} from 0x${v.toString(16)}`);
        code = alt;
      }
    }

    // code 0 = "pas d'annonce" : on renvoie '----' afin d'écraser l'ancienne valeur
    if (code === 0) return '----';
    switch (code) {
      case 1:
        return 'BLEU';
      case 2:
        return 'BLAN';
      case 3:
        return 'ROUG';
      default:
        return null;
    }
  } catch (e) {
    this.error(`_extractTomorrowFromRegister error: ${e && e.message ? e.message : e}`);
    return null;
  }
};

// Extrait la couleur d’AUJOURD’HUI (bits 24-25) — 0=Pas d’annonce, 1=BLEU, 2=BLAN, 3=ROUG
Device.prototype._extractTodayFromRegister = function(reg) {
  try {
    if (reg === null || reg === undefined) return null;
    let v = (typeof reg === 'number') ? (reg >>> 0) : this._parseRegisterToUint32(reg);
    if (v === null) return null;

    const decodeFrom = (val) => ((val >>> 24) & 0x03);

    let code = decodeFrom(v);
    // Mêmes précautions d’endianess
    if (code === 0) {
      const swapped = (((v & 0x000000FF) << 24) | ((v & 0x0000FF00) << 8) | ((v & 0x00FF0000) >>> 8) | ((v & 0xFF000000) >>> 24)) >>> 0;
      const alt = decodeFrom(swapped);
      if (alt !== 0) {
        this.log && this.log(`[TODAY] using swapped bytes for bits 24-25: code=${alt} from 0x${v.toString(16)}`);
        code = alt;
      }
    }

    // code 0 = "pas d'annonce" : on renvoie '----' afin d'écraser l'ancienne valeur
    if (code === 0) return '----';
    switch (code) {
      case 1:
        return 'BLEU';
      case 2:
        return 'BLAN';
      case 3:
        return 'ROUG';
      default:
        return null;
    }
  } catch (e) {
    this.error(`_extractTodayFromRegister error: ${e && e.message ? e.message : e}`);
    return null;
  }
};

// Diagnostic de la période HP/HC: en mode standard, renvoie le tarif en cours annoncé par le
// compteur (LTARF / NTARF) sous forme de suffixe de log. Chaîne vide en mode historique ou si
// la lecture échoue (firmware ZLinky ne les exposant pas).
Device.prototype._readCurrentTariffLabel = async function(zclNode) {
  if (this.getCapabilityValue('mode_capability') !== 'standard') return '';
  try {
    const {
      currentTariffLabel,
      currentTariffIndex
    } = await zclNode.endpoints[this.getClusterEndpoint(LixeePrivateCluster)]
      .clusters[LixeePrivateCluster.NAME]
      .readAttributes([
        'currentTariffLabel',
        'currentTariffIndex'
      ]);
    const label = String(currentTariffLabel ?? '').replace(/\0/g, '').trim();
    return ` | compteur: LTARF='${label}' NTARF=${currentTariffIndex}`;
  } catch (e) {
    return ` | compteur: LTARF/NTARF illisibles (${e && e.message ? e.message : e})`;
  }
};

// Diagnostic de la période HP/HC: en mode standard, logue le profil du prochain jour (PJOURF+1),
// soit jusqu'à 11 blocs 'HHMMAAAA' (heure de début + code action), les blocs inutilisés valant
// 'NONUTILE'. Le ZLinky encode l'heure et les minutes en hexadécimal (ex: '0D1E' = 13h30).
// Le dernier chiffre de l'action est lu comme le numéro d'index tarifaire (même valeur que NTARF).
Device.prototype._logNextDayProfile = async function(zclNode) {
  if (this.getCapabilityValue('mode_capability') !== 'standard') return;
  try {
    const { nextDayProfile } = await zclNode.endpoints[this.getClusterEndpoint(LixeePrivateCluster)]
      .clusters[LixeePrivateCluster.NAME]
      .readAttributes([
        'nextDayProfile'
      ]);
    const raw = String(nextDayProfile ?? '').replace(/\0/g, '').trim();
    const pad = n => String(n).padStart(2, '0');
    const slots = raw.split(/\s+/)
      .filter(block => /^[0-9A-Fa-f]{8}$/.test(block))
      .map(block => {
        const hours = parseInt(block.slice(0, 2), 16);
        const minutes = parseInt(block.slice(2, 4), 16);
        const action = block.slice(4).toUpperCase();
        return `${pad(hours)}h${pad(minutes)} -> index ${parseInt(action.slice(-1), 16)} (action ${action})`;
      });
    this.log(`[PERIOD] PJOURF+1 brut='${raw}'`);
    this.log(`[PERIOD] PJOURF+1 plages: ${slots.length ? slots.join(' | ') : 'aucune plage décodable'}`);
  } catch (e) {
    this.log(`[PERIOD] PJOURF+1 illisible: ${e && e.message ? e.message : e}`);
  }
};

// Options tarifaires reconnues après normalisation
const KNOWN_PRICE_OPTIONS = ['BASE', 'TEMPO', 'HC..', 'HPHC', 'EJP.', 'BBR'];

// Normalise l'option tarifaire lue sur le compteur: nettoyage de la chaîne puis alias
// ('BBRx' -> 'BBR', 'HC..'/'H PLEINE/CREUSE'/'H PLEINE-CREUSE' -> 'HPHC', 'EJP' -> 'EJP.').
// En mode historique l'attribut contient OPTARIF (BASE, HC.., EJP., BBRx où x est variable).
// En mode standard il contient NGTF, nom de calendrier libre choisi par le fournisseur
// (ex: 'HC SEM WE MERCR'): s'il n'est pas reconnu, on le classe par mots-clés.
// Retourne une chaîne vide si la lecture est vide.
Device.prototype._normalizePriceOption = function(raw) {
  let val = String(raw ?? '').replace(/\0/g, '').trim();

  if (!val) return '';
  if (val === 'BBRx') val = 'BBR';
  if (val === 'HC..') val = 'HPHC';
  if (val === 'H PLEINE/CREUSE') val = 'HPHC';
  if (val === 'H PLEINE-CREUSE') val = 'HPHC';
  if (val === 'EJP') val = 'EJP.';
  if (val.toUpperCase().includes('OHM') && val.toUpperCase().includes('HPHC')) val = 'HPHC';

  if (!KNOWN_PRICE_OPTIONS.includes(val)) {
    const u = val.toUpperCase();
    if (u.startsWith('BBR')) val = 'BBR';
    else if (u.includes('TEMPO')) val = 'TEMPO';
    else if (u.includes('EJP')) val = 'EJP.';
    else if (/(^|[^A-Z])H[CP]([^A-Z]|$)|HPHC|HCHP|CREUS|PLEIN/.test(u)) val = 'HPHC';
    else if (u.includes('BASE')) val = 'BASE';
  }

  return val;
};

// Met à jour l'option tarifaire si elle change, avec normalisation et déclenchement du Flow
// - Normalise via _normalizePriceOption
// - Valide contre la liste autorisée
// - Déclenche le trigger Flow 'price_option_became' si changement
Device.prototype._updatePriceOptionIfChanged = async function(newValue) {
  try {
    if (!this.hasCapability('price_option_capability')) return;
    if (!newValue) return;

    this.log('[INFO] priceOption avant' + newValue);

    let val = this._normalizePriceOption(newValue);

    this.log('[INFO] priceOption apres' + val);

    if (!val) return;

    if (!KNOWN_PRICE_OPTIONS.includes(val)) val = 'UNKN';

    if (this.hasCapability('debug_capability')) {
      const currentDebugValue = this.getCapabilityValue('debug_capability') || '';
      const debugPriceSuffix = `-${val}`;
      const cleanedDebugValue = currentDebugValue.replace(/-(?:BASE|TEMPO|HC\.\.|HPHC|EJP\.|BBR|UNKN)$/, '');
      if (!cleanedDebugValue.endsWith(debugPriceSuffix)) {
        await this.setCapabilityValue('debug_capability', `${cleanedDebugValue}${debugPriceSuffix}`);
      }
    }

    const prev = this.getCapabilityValue('price_option_capability');
    if (prev !== val) {
      await this.setCapabilityValue('price_option_capability', val);
      if (this._priceOptionBecameCard) {
        await this._priceOptionBecameCard.trigger(this, { target: val }, { target: val });
        this.log(`Flow trigger 'price_option_became' fired (target=${val})`);
      }
    }
  } catch (e) {
    this.error(`update price_option_capability failed: ${e && e.message ? e.message : e}`);
  }
};

// Mémorise l'état du calcul de coût (jour courant + index de référence) en mémoire et dans le
// store de l'appareil, afin de survivre à un redémarrage de l'app.
// Appelé uniquement quand la baseline change (jour suivant, nouveau registre, compteur remis à zéro).
Device.prototype._persistCostState = async function(state) {
  this._costState = state;
  await this.setStoreValue('cost_state', state)
    .catch(e => this.error(`persist cost_state failed: ${e && e.message ? e.message : e}`));
};

// Coût de la journée: consommation valorisée depuis minuit + part journalière de l'abonnement.
// Renvoie null si aucun tarif n'est renseigné pour l'option tarifaire courante et que
// l'abonnement est à 0 (la capability affiche alors '-' plutôt qu'un 0 trompeur).
Device.prototype._computeDailyCost = function(priceOption, state, indexes, settings) {
  const {
    cost,
    kwh,
    hasPrice
  } = Tariff.computeEnergyCost(priceOption, state.baseline, indexes, settings);
  const subscription = Tariff.dailySubscriptionCost(settings.price_subscription_monthly, state.day);

  if (!hasPrice && subscription === 0) {
    if (!this._costNotConfiguredLogged) {
      this._costNotConfiguredLogged = true;
      this.log(`[COST] Aucun tarif renseigné pour l'option ${priceOption}, coût non calculé`);
    }
    return null;
  }
  this._costNotConfiguredLogged = false;

  const total = Math.round((cost + subscription) * 100) / 100;
  this.log(`[COST] option=${priceOption} conso=${kwh.toFixed(3)}kWh coutConso=${cost.toFixed(4)}€ abonnement=${subscription.toFixed(4)}€ total=${total}€`);
  return total;
};

// Valorise la consommation de la journée en cours et met à jour les capabilities de coût.
// Le calcul se fait par différence d'index depuis le dernier passage de minuit (heure locale
// du Homey), registre par registre: c'est exact et insensible aux redémarrages de l'app.
// `indexes` contient les index bruts en Wh collectés dans l'intervalle metering.
Device.prototype._updateDailyCost = async function(indexes) {
  try {
    // Valorisation par index fournisseur sans index lus (lecture en échec sur ce relevé): on garde
    // les dernières valeurs plutôt que de compter la journée à l'abonnement seul
    if (this._costOption() === 'STANDARD' && !Object.keys(indexes).some(k => /^f\d\d$/.test(k))) return;

    // Derniers index connus, utilisés par resetDailyCost() qui est appelé hors de cet intervalle
    this._lastIndexes = indexes;

    if (!this.hasCapability('measure_daily_cost_capability')) return;

    const settings = this.getSettings();
    // En mode standard, dès qu'un prix par index fournisseur est saisi, on valorise index par
    // index (EASF01..EASF10) au lieu de passer par l'option tarifaire: exact pour toute offre.
    const priceOption = this._costOption(settings);
    const dayKey = Tariff.localDayKey(new Date(), this.homey.clock.getTimezone());

    let state = this._costState || await this.getStoreValue('cost_state');

    if (!state || !state.day || !state.baseline) {
      // Premier relevé (ou store vide): on pose la référence sur les index courants
      state = {
        day: dayKey,
        baseline: Tariff.reconcileBaseline({}, indexes)
      };
      await this._persistCostState(state);
      this.log(`[COST] Baseline initialisée pour le ${dayKey}`);
    } else if (state.day !== dayKey) {
      // Passage de minuit: on fige le coût de la veille puis on repart de zéro
      const closingCost = this._computeDailyCost(priceOption, state, indexes, settings);
      await this._closeDayIntoMonth(state.day, closingCost, dayKey);
      state = {
        day: dayKey,
        baseline: Tariff.reconcileBaseline({}, indexes)
      };
      await this._persistCostState(state);
      if (this.hasCapability('measure_yesterday_cost_capability')) {
        await this.setCapabilityValue('measure_yesterday_cost_capability', closingCost);
      }
      this.log(`[COST] Changement de jour -> ${dayKey}, coût de la veille figé à ${closingCost}€`);
    } else {
      // En cours de journée: recalage si un registre apparaît ou si un index recule
      // (remise à zéro du compteur, changement d'option tarifaire)
      const reconciled = Tariff.reconcileBaseline(state.baseline, indexes);
      if (JSON.stringify(reconciled) !== JSON.stringify(state.baseline)) {
        state = {
          day: state.day,
          baseline: reconciled
        };
        await this._persistCostState(state);
        this.log('[COST] Baseline recalée (nouveau registre ou index en recul)');
      }
    }

    const todayCost = this._computeDailyCost(priceOption, state, indexes, settings);
    await this.setCapabilityValue('measure_daily_cost_capability', todayCost);

    if (this.hasCapability('measure_month_cost_capability')) {
      const monthState = await this._getMonthState(dayKey);
      await this.setCapabilityValue(
        'measure_month_cost_capability',
        Tariff.monthToDateCost(monthState, dayKey, todayCost)
      );
    }

    if (this.hasCapability('measure_current_kwh_price_capability')) {
      await this.setCapabilityValue('measure_current_kwh_price_capability', Tariff.currentKwhPrice(
        priceOption,
        this.getCapabilityValue('price_period_capability'),
        this.getCapabilityValue('today_color_capability'),
        settings,
        this._currentTariffIndex
      ));
    }
  } catch (e) {
    this.error(`_updateDailyCost failed: ${e && e.message ? e.message : e}`);
  }
};

// Puissance transmise à Homey Energy (measure_power): apparente par défaut (instantanée),
// ou active estimée si l'utilisateur l'a choisi et qu'une estimation est disponible.
Device.prototype._powerForHomeyEnergy = function(apparentPower) {
  if (this._powerSource() === 'active_estimated'
    && this.getCapabilityValue('mode_capability') === 'standard'
    && Number.isFinite(this._estimatedActivePower)) {
    return this._estimatedActivePower;
  }
  return apparentPower;
};

// Titre de la tuile principale (measure_power, seule proposée comme indicateur d'état et
// utilisée par Homey Energy), aligné sur la puissance réellement transmise.
// Mis en cache: setCapabilityOptions n'est appelé que si le titre change.
Device.prototype._applyPowerTitle = async function(source) {
  if (!this.hasCapability('measure_power')) return;
  const active = (source ?? this._powerSource()) === 'active_estimated'
    && this.getCapabilityValue('mode_capability') === 'standard';
  const title = active
    ? { en: 'Estimated active power', fr: 'Puissance active estimée' }
    : { en: 'Apparent power (VA)', fr: 'Puissance apparente (VA)' };
  const key = title.en;
  if (this._powerTitleKey === key) return;
  await this.setCapabilityOptions('measure_power', { ...CAPABILITY_OPTIONS['measure_power'], title })
    .then(() => {
      this._powerTitleKey = key;
      this._diag = { ...(this._diag || {}), title: 'ok' };
    })
    .catch(e => {
      this._diag = { ...(this._diag || {}), title: `err ${e && e.message ? e.message : e}`.slice(0, 60) };
      this.error(`setCapabilityOptions measure_power failed: ${e && e.message ? e.message : e}`);
    });
};

// Réglages: le changement de source de puissance met à jour le titre tout de suite
Device.prototype.onSettings = async function({ oldSettings, newSettings, changedKeys }) {
  if (typeof ZigBeeDevice.prototype.onSettings === 'function') {
    await ZigBeeDevice.prototype.onSettings.call(this, { oldSettings, newSettings, changedKeys });
  }
  if (changedKeys.includes('power_source')) {
    this._powerTitleKey = null;
    this._powerSourceOverride = newSettings.power_source;
    await this._applyPowerTitle(newSettings.power_source);
    // Affiche ou retire la tuile « Puissance active estimée » séparée (doublon sinon)
    await this._reapplyLayout();
  }
};

// Recalcule la mise en page (tuiles affichées) avec les paramètres du dernier prepareMode
Device.prototype._reapplyLayout = async function() {
  if (!this._layoutArgs) return;
  try {
    const layoutChanged = await this._applyCapabilityLayout(this._computeApplicableCapabilities(...this._layoutArgs));
    // La remise en ordre a pu recréer le bouton de maintenance: on réenregistre son listener
    if (layoutChanged) {
      this._resetDailyCostListenerRegistered = false;
      this.registerResetDailyCostListener();
    }
  } catch (e) {
    this.error(`relayout failed: ${e && e.message ? e.message : e}`);
  }
};

// true si le compteur a déjà utilisé un index fournisseur au-delà de 2 (offre à plus de deux
// périodes: mercredi, week-end...). Les libellés vus sont mémorisés, l'information survit
// aux redémarrages.
Device.prototype._usesExtraSupplierIndexes = function() {
  const labels = (typeof this.getStoreValue === 'function' && this.getStoreValue('supplier_index_labels')) || {};
  return Object.keys(labels).some(k => Number(k) > 2) || Number(this._currentTariffIndex) > 2;
};

// false quand la période ne doit pas être déduite des index HP/HC: offre HP/HC en mode
// standard qui utilise d'autres index fournisseur (la période resterait figée le mercredi,
// le week-end...). Évite aussi de déclencher les Flows « période » à tort.
Device.prototype._periodFromDeltas = function() {
  if (this.getCapabilityValue('mode_capability') !== 'standard') return true;
  return !(HPHC_OPTIONS.includes(this.getCapabilityValue('price_option_capability')) && this._usesExtraSupplierIndexes());
};

// Source de puissance de la tuile principale. Pendant onSettings, getSetting renvoie encore
// l'ancienne valeur: on utilise la nouvelle, transmise par onSettings.
Device.prototype._powerSource = function() {
  if (this._powerSourceOverride !== undefined) return this._powerSourceOverride;
  return typeof this.getSetting === 'function' ? this.getSetting('power_source') : undefined;
};

// true pour un contrat Tempo (historique BBR ou nom de calendrier fournisseur contenant TEMPO)
Device.prototype._isTempoContract = function(rawOrNormalizedOption) {
  return /TEMPO|BBR/i.test(String(rawOrNormalizedOption ?? ''));
};

// Alarme de dépassement: met à jour la tuile et déclenche les cartes Flow « atteinte /
// n'est pas atteinte » (déclarées mais jamais déclenchées jusqu'ici). null = inconnu.
Device.prototype._updateOverpowerAlarm = async function(value) {
  if (value === null || !this.hasCapability('alarm_subscribe_power_capability')) return;
  const previous = this.getCapabilityValue('alarm_subscribe_power_capability');
  if (previous === value) return;
  await this.setCapabilityValue('alarm_subscribe_power_capability', value);
  // Pas de déclenchement au premier relevé (valeur précédente inconnue)
  if (previous === null || previous === undefined) return;
  const cardId = value ? 'alarm_subscribe_power_capability_true' : 'alarm_subscribe_power_capability_false';
  try {
    await this.homey.flow.getDeviceTriggerCard(cardId).trigger(this, {}, {});
  } catch (e) {
    this.error(`trigger ${cardId} failed: ${e && e.message ? e.message : e}`);
  }
};

// Mode standard: puissance apparente maximale du jour (SMAXSN) et de la veille (SMAXSN-1),
// transmises en VA et affichées en kVA comme la puissance souscrite.
// Lecture par identifiant numérique: le type varie selon le firmware (int16 avant v16, int32 depuis).
Device.prototype._readMaxApparentPower = async function(zclNode) {
  const tri = this.getCapabilityValue('phase_capability') === 'triphase';
  try {
    const todayId = tri ? 0x0304 : 0x050D;
    const result = (await RawAttributes.readRaw(
      zclNode.endpoints[this.getClusterEndpoint(CLUSTER.ELECTRICAL_MEASUREMENT)]
        .clusters[CLUSTER.ELECTRICAL_MEASUREMENT.NAME],
      [todayId]
    ))[todayId];
    this._diag = { ...(this._diag || {}), smaxsn: RawAttributes.describe(result) };
    if (result && result.status === 0 && Number.isFinite(Number(result.value))
      && this.hasCapability('max_apparent_power_today_capability')) {
      await this.setCapabilityValue('max_apparent_power_today_capability', Math.round(Number(result.value) / 10) / 100);
    }
  } catch (e) {
    this._diag = { ...(this._diag || {}), smaxsn: 'err' };
  }
  try {
    const yesterdayId = tri ? 0x0400 : 0x0212;
    const result = (await RawAttributes.readRaw(
      zclNode.endpoints[this.getClusterEndpoint(LixeePrivateCluster)]
        .clusters[LixeePrivateCluster.NAME],
      [yesterdayId]
    ))[yesterdayId];
    if (result && result.status === 0 && Number.isFinite(Number(result.value))
      && this.hasCapability('max_apparent_power_yesterday_capability')) {
      await this.setCapabilityValue('max_apparent_power_yesterday_capability', Math.round(Number(result.value) / 10) / 100);
    }
  } catch (e) {
    this.log(`[STANDARD] SMAXSN-1 illisible: ${e && e.message ? e.message : e}`);
  }
};

// Programme tarifaire: apprentissage des changements d'index, lecture de PJOURF+1 (toutes les
// 15 minutes), puis tuiles « Prochain changement de tarif » et « Programme de demain ».
Device.prototype._updateTariffSchedule = async function(zclNode, tariffIndex) {
  const now = new Date();
  const clock = Schedule.localClock(now, this.homey.clock.getTimezone());
  const tomorrow = Schedule.nextDay(clock.dayKey);

  const observed = Schedule.observe(this._scheduleState || this.getStoreValue('tariff_schedule'), now.getTime(), clock, tariffIndex);
  let state = observed.state;
  let dirty = observed.changed;

  if (!this._lastProfileReadTs || now.getTime() - this._lastProfileReadTs > 15 * 60 * 1000) {
    this._lastProfileReadTs = now.getTime();
    try {
      const raw = (await zclNode.endpoints[this.getClusterEndpoint(LixeePrivateCluster)]
        .clusters[LixeePrivateCluster.NAME]
        .readAttributes(['nextDayProfile'])).nextDayProfile;
      const parsed = Schedule.parseNextDayProfile(raw);
      this._diag = { ...(this._diag || {}), pjourf: parsed ? `${parsed.length} créneaux` : (raw ? 'vide' : 'absent') };
      if (parsed && JSON.stringify(state.profiles[tomorrow.dayKey]) !== JSON.stringify(parsed)) {
        state = { ...state, profiles: { ...state.profiles, [tomorrow.dayKey]: parsed } };
        dirty = true;
      }
    } catch (e) {
      this._diag = { ...(this._diag || {}), pjourf: 'illisible' };
    }
  }

  this._scheduleState = state;
  if (dirty) await this.setStoreValue('tariff_schedule', state).catch(this.error);

  const labels = this.getStoreValue('supplier_index_labels') || {};
  const settings = this.getSettings();
  // Tempo / EJP: l'index dépend de la couleur du jour, pas du jour de la semaine: on n'utilise
  // que le profil transmis par le compteur
  const rawOption = this.getCapabilityValue('price_option_capability');
  const useLearned = !this._isTempoContract(rawOption) && !/EJP/i.test(String(rawOption ?? ''));
  const todaySchedule = Schedule.scheduleFor(state, clock.dayKey, clock.weekday, useLearned);
  const tomorrowSchedule = Schedule.scheduleFor(state, tomorrow.dayKey, tomorrow.weekday, useLearned);
  // Sans programme du jour, le créneau de 00:00 de demain ne dit pas à quelle heure le tarif
  // change ce soir: on ne l'annonce pas. Cas du jour de l'installation, ou d'un Homey resté
  // hors service toute la veille (le profil du lendemain est relu toutes les 15 minutes).
  const change = todaySchedule
    ? Schedule.nextChange(todaySchedule, tomorrowSchedule, clock.minutes, tariffIndex)
    : null;
  this._nextTariffChange = change ? { ...change, at: now.getTime() } : null;

  const learnedDays = Object.keys(state.learned || {}).length;
  const learning = useLearned ? `Apprentissage en cours (${learnedDays}/7 jours)` : 'Programme non transmis par le compteur';

  const priceOf = index => Tariff.currentKwhPrice('STANDARD', null, null, settings, index);
  const priceText = price => `${price.toFixed(4).replace('.', ',')} €`;

  // Tuiles: textes courts, lisibles sur une ligne dans l'app mobile (environ 16 caractères).
  // L'heure suffit: le prochain changement tombe toujours dans les 24 heures.
  let nextText = todaySchedule || !tomorrowSchedule ? learning : 'Programme du jour inconnu';
  if (change) {
    const price = priceOf(change.index);
    const label = labels[change.index] || `Index ${String(change.index).padStart(2, '0')}`;
    nextText = `${Schedule.formatMinutes(change.minutes)} → ${price ? priceText(price) : label}`;
  }
  const tomorrowText = tomorrowSchedule
    ? Schedule.summarizeSchedule(tomorrowSchedule.entries, labels, priceOf)
    : learning;

  // Détail dans les réglages: un champ par jour, deux lignes courtes (une par niveau tarifaire,
  // HC / HP), car l'app mobile n'affiche que les deux premières lignes d'un réglage en lecture seule
  const describe = schedule => (schedule
    ? `${Schedule.describeDay(schedule.entries, labels, priceOf)}${schedule.source === 'appris' ? ' (appris)' : ''}`
    : 'Inconnu');
  const scheduleSettings = {
    tariff_schedule_today: describe(todaySchedule),
    tariff_schedule_tomorrow: describe(tomorrowSchedule),
  };
  if (Object.keys(scheduleSettings).some(k => settings[k] !== scheduleSettings[k])) {
    await this.setSettings(scheduleSettings)
      .catch(e => this.error(`setSettings tariff schedule failed: ${e && e.message ? e.message : e}`));
  }

  if (this.hasCapability('next_tariff_change_capability')
    && this.getCapabilityValue('next_tariff_change_capability') !== nextText) {
    await this.setCapabilityValue('next_tariff_change_capability', nextText);
  }
  if (this.hasCapability('tomorrow_schedule_capability')
    && this.getCapabilityValue('tomorrow_schedule_capability') !== tomorrowText) {
    await this.setCapabilityValue('tomorrow_schedule_capability', tomorrowText);
  }
};

// Minutes avant le prochain changement de tarif connu, null si inconnu (condition Flow)
Device.prototype.getMinutesToNextTariffChange = function() {
  const change = this._nextTariffChange;
  if (!change || !Number.isFinite(change.at)) return null;
  const elapsed = (Date.now() - change.at) / 60000;
  // Valeur périmée (plus de relevé depuis 2 minutes): inconnue
  if (elapsed > 2) return null;
  return Math.max(0, change.inMinutes - elapsed);
};

// Suffixe de diagnostic ajouté à la tuile Debug (valeurs brutes utiles pour un rapport)
// Tuile Debug (mode standard), utile pour un rapport de bug: contrat (NGTF), registre de
// statuts STGE décodé (index fournisseur et distributeur en cours, dépassement), état du
// programme du lendemain, couleurs Tempo pour un contrat Tempo, puis seulement les lectures
// en échec (les valeurs lues correctement ont leur propre tuile).
Device.prototype._buildDebugValue = function(rawOption, stge, tempoContract, today, tomorrow) {
  const parts = [String(rawOption ?? '').replace(/\0/g, '').trim() || '?'];
  if (Number.isFinite(stge)) {
    const hex = (stge >>> 0).toString(16).toUpperCase().padStart(8, '0');
    const overpower = ((stge >>> 7) & 1) === 1 ? ', dépassement' : '';
    parts.push(`STGE ${hex} (fournisseur ${((stge >>> 10) & 0x0F) + 1}, distributeur ${((stge >>> 14) & 0x03) + 1}${overpower})`);
  }
  if (tempoContract) parts.push(`Tempo ${today ?? '----'} / ${tomorrow ?? '----'}`);
  return parts.join(' · ') + this._diagSuffix();
};

// Diagnostic: programme du lendemain, puis uniquement les lectures en échec
Device.prototype._diagSuffix = function() {
  const d = this._diag || {};
  const out = [];
  if (d.pjourf !== undefined) out.push(`PJOURF+1 ${d.pjourf}`);
  const failed = (name, v) => {
    if (v === undefined || (typeof v === 'string' && v !== '')) out.push(`${name} ${v === undefined ? 'absent' : v}`);
  };
  if (this.getCapabilityValue && this.getCapabilityValue('mode_capability') === 'standard') {
    failed('PREF', d.pref);
    failed('PCOUP', d.pcoup);
    failed('SMAXSN', d.smaxsn);
  }
  if (typeof d.title === 'string' && d.title.startsWith('err')) out.push(`titre ${d.title}`);
  return out.length ? ` · ${out.join(' · ')}` : '';
};

// Option utilisée pour valoriser la consommation: 'STANDARD' (prix par index fournisseur)
// dès qu'un prix par index est saisi en mode standard, sinon l'option tarifaire du compteur.
Device.prototype._costOption = function(settings = this.getSettings()) {
  return this._useSupplierIndexPrices(settings)
    ? 'STANDARD'
    : this.getCapabilityValue('price_option_capability');
};

// État du cumul mensuel (mémoire puis store), initialisé sur le mois de dayKey si absent
Device.prototype._getMonthState = async function(dayKey) {
  let monthState = this._monthState || await this.getStoreValue('month_cost_state');
  if (!monthState || !monthState.month) {
    monthState = { month: String(dayKey).slice(0, 7), closed: 0 };
    this._monthState = monthState;
    await this.setStoreValue('month_cost_state', monthState).catch(this.error);
  }
  this._monthState = monthState;
  return monthState;
};

// Ajoute le coût de la journée close au cumul du mois; au changement de mois, publie le coût
// du mois écoulé et repart de zéro.
Device.prototype._closeDayIntoMonth = async function(closedDayKey, closingCost, newDayKey) {
  try {
    const current = await this._getMonthState(closedDayKey);
    const { state, lastMonthCost } = Tariff.closeDayIntoMonth(current, closedDayKey, closingCost, newDayKey);
    this._monthState = state;
    await this.setStoreValue('month_cost_state', state).catch(this.error);
    if (lastMonthCost !== null && this.hasCapability('measure_last_month_cost_capability')) {
      await this.setCapabilityValue('measure_last_month_cost_capability', lastMonthCost);
      this.log(`[COST] Mois ${closedDayKey.slice(0, 7)} clos à ${lastMonthCost}€`);
    }
  } catch (e) {
    this.error(`_closeDayIntoMonth failed: ${e && e.message ? e.message : e}`);
  }
};

// true si le coût doit être calculé index fournisseur par index fournisseur (mode standard
// et au moins un prix 'price_index_xx' renseigné)
Device.prototype._useSupplierIndexPrices = function(settings) {
  return this.getCapabilityValue('mode_capability') === 'standard'
    && Tariff.hasSupplierIndexPrices(settings || this.getSettings());
};

// Mode standard: lit EASF01..EASF10, NTARF et LTARF.
// - complète `indexes` avec les clés f01..f10 (Wh) pour la valorisation;
// - publie l'index total à partir de EAST (currentSummationDelivered), au Wh près;
// - met à jour le tarif fournisseur en cours et déclenche le Flow s'il change;
// - mémorise le libellé de chaque index pour l'afficher dans les réglages.
Device.prototype._readStandardSupplierIndexes = async function(zclNode, indexes, east) {
  // Index nul: le ZLinky n'a pas encore reçu de trame TIC. On n'exploite rien de ce relevé, sinon
  // des index à zéro recaleraient la référence du coût du jour et fausseraient la suite.
  if (!(Number(east) > 0)) throw new Error('EAST nul, trame TIC pas encore reçue');

  const metering = zclNode.endpoints[this.getClusterEndpoint(CLUSTER.METERING)]
    .clusters[CLUSTER.METERING.NAME];

  // Même registres que HC/HP/HCW/HPW/HCR/HPR en historique = EASF01..EASF06 en standard.
  // Deux lectures de 5 attributs pour rester sous la taille d'une trame Zigbee.
  const first = await metering.readAttributes([
    'currentSummationDeliveredHC', 'currentSummationDeliveredHP',
    'currentSummationDeliveredHCW', 'currentSummationDeliveredHPW',
    'currentSummationDeliveredHCR',
  ]);
  const second = await metering.readAttributes([
    'currentSummationDeliveredHPR',
    'supplierIndex07', 'supplierIndex08', 'supplierIndex09', 'supplierIndex10',
  ]);
  const raw = [
    first.currentSummationDeliveredHC, first.currentSummationDeliveredHP,
    first.currentSummationDeliveredHCW, first.currentSummationDeliveredHPW,
    first.currentSummationDeliveredHCR, second.currentSummationDeliveredHPR,
    second.supplierIndex07, second.supplierIndex08, second.supplierIndex09, second.supplierIndex10,
  ];
  Tariff.SUPPLIER_INDEX_NUMBERS.forEach((n, i) => {
    const value = Number(raw[i]);
    if (Number.isFinite(value)) indexes[Tariff.supplierIndexKey(n)] = value;
  });

  // Puissance active estimée à partir de la pente de EAST (le Linky n'en transmet pas)
  if (!this._activePowerEstimator) this._activePowerEstimator = new ActivePowerEstimator();
  const estimated = this._activePowerEstimator.push(Date.now(), Number(east));
  this._estimatedActivePower = estimated;
  if (estimated !== null && this.hasCapability('estimated_active_power_capability')
    && this.getCapabilityValue('estimated_active_power_capability') !== estimated) {
    await this.setCapabilityValue('estimated_active_power_capability', estimated);
  }

  // Index total = EAST, qui couvre tous les index fournisseur
  const eastKwh = Number(east) / 1000;
  if (Number.isFinite(eastKwh) && eastKwh > 0 && eastKwh !== this.getCapabilityValue('meter_power.imported')) {
    await this.setCapabilityValue('meter_power', eastKwh);
    await this.setCapabilityValue('meter_power.imported', eastKwh);
  }

  const { currentTariffLabel, currentTariffIndex } = await zclNode
    .endpoints[this.getClusterEndpoint(LixeePrivateCluster)]
    .clusters[LixeePrivateCluster.NAME]
    .readAttributes(['currentTariffLabel', 'currentTariffIndex']);

  const tariffIndex = Number(currentTariffIndex);
  if (!Number.isInteger(tariffIndex) || tariffIndex < 1 || tariffIndex > 10) return;
  const label = String(currentTariffLabel ?? '').replace(/\0/g, '').trim() || `Index ${String(tariffIndex).padStart(2, '0')}`;

  const previousIndex = this._currentTariffIndex;
  this._currentTariffIndex = tariffIndex;

  if (this.hasCapability('supplier_tariff_capability')
    && this.getCapabilityValue('supplier_tariff_capability') !== label) {
    await this.setCapabilityValue('supplier_tariff_capability', label);
  }

  await this._rememberTariffLabel(tariffIndex, label);
  await this._refreshTariffLabelsSetting();
  // Premier index au-delà de 2 rencontré: la mise en page change (tuile Période, voir
  // _computeApplicableCapabilities)
  if (this._layoutArgs && this._layoutMultiIndex === false && this._usesExtraSupplierIndexes()) {
    await this._reapplyLayout();
  }
  await this._updateTariffSchedule(zclNode, tariffIndex)
    .catch(e => this.error(`_updateTariffSchedule failed: ${e && e.message ? e.message : e}`));

  // Pas de déclenchement au premier relevé après démarrage
  if (previousIndex !== undefined && previousIndex !== tariffIndex && this._supplierTariffChangedCard) {
    const price = Tariff.currentKwhPrice('STANDARD', null, null, this.getSettings(), tariffIndex);
    await this._supplierTariffChangedCard
      .trigger(this, { label, index: tariffIndex, price: price ?? 0 }, {})
      .catch(e => this.error(`supplier_tariff_changed trigger failed: ${e && e.message ? e.message : e}`));
    this.log(`[STANDARD] Tarif fournisseur: index ${previousIndex} -> ${tariffIndex} (${label})`);
  }
};

// Mémorise le libellé LTARF de chaque index et le recopie dans le réglage en lecture seule
// 'supplier_index_labels', pour que l'utilisateur sache quel prix saisir dans quel champ.
Device.prototype._rememberTariffLabel = async function(tariffIndex, label) {
  const labels = { ...(this.getStoreValue('supplier_index_labels') || {}) };
  if (labels[tariffIndex] === label) return;

  labels[tariffIndex] = label;
  await this.setStoreValue('supplier_index_labels', labels).catch(this.error);
  await this._refreshTariffLabelsSetting();
};

// Réécrit le réglage 'supplier_index_labels' si besoin, en signalant les index sans prix.
// Appelé à chaque relevé: un prix saisi entre-temps fait disparaître la mention.
Device.prototype._refreshTariffLabelsSetting = async function() {
  const settings = this.getSettings();
  const text = Tariff.supplierLabelsText(this.getStoreValue('supplier_index_labels') || {}, settings);
  if (!text || text === settings.supplier_index_labels) return;
  await this.setSettings({ supplier_index_labels: text })
    .catch(e => this.error(`setSettings supplier_index_labels failed: ${e && e.message ? e.message : e}`));
};

// (Ré)enregistre le listener du bouton de maintenance "Remettre à zéro le coût du jour".
// Appelé au démarrage et après un réordonnancement des capabilities, qui recrée le bouton.
Device.prototype.registerResetDailyCostListener = function() {
  try {
    if (!this.hasCapability(RESET_DAILY_COST_BUTTON)) return;
    if (this._resetDailyCostListenerRegistered) return;
    this.registerCapabilityListener(RESET_DAILY_COST_BUTTON, async () => {
      await this.resetDailyCost();
    });
    this._resetDailyCostListenerRegistered = true;
  } catch (e) {
    this.error(`Failed to register maintenance action ${RESET_DAILY_COST_BUTTON}: ${e && e.message ? e.message : e}`);
  }
};

// Remet à zéro le coût du jour, à la demande (bouton de maintenance ou action Flow).
// On recale la baseline sur les derniers index connus: seule la consommation valorisée
// repart de zéro. La part journalière de l'abonnement reste due pour la journée, donc le
// coût du jour redescend à ce seul montant (0 € si aucun abonnement n'est renseigné) puis
// remonte avec la consommation à venir. Le coût de la veille n'est pas touché.
// Si aucun relevé n'a encore eu lieu, la baseline reste vide: le prochain passage de
// l'intervalle metering l'initialisera sur les index courants (reconcileBaseline).
Device.prototype.resetDailyCost = async function() {
  const dayKey = Tariff.localDayKey(new Date(), this.homey.clock.getTimezone());

  const state = {
    day: dayKey,
    baseline: Tariff.reconcileBaseline({}, this._lastIndexes || {})
  };
  await this._persistCostState(state);

  if (this.hasCapability('measure_daily_cost_capability')) {
    // Recalculé plutôt que forcé à 0, pour réafficher immédiatement la part d'abonnement
    const settings = this.getSettings();
    const total = this._computeDailyCost(
      this._costOption(settings),
      state,
      this._lastIndexes || {},
      settings
    );
    await this.setCapabilityValue('measure_daily_cost_capability', total)
      .catch(e => this.error(`reset measure_daily_cost_capability failed: ${e && e.message ? e.message : e}`));
  }

  this.log(`[COST] Coût du jour remis à zéro pour le ${dayKey} (la part d'abonnement du jour reste comptée)`);
};

module.exports = Device;
