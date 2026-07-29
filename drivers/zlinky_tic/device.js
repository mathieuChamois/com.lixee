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
      en: 'Apparent power',
      fr: 'Puissance apparente'
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

              await self.setCapabilityValue('price_period_capability', newValue);
              self._lastPeriod = newValue;
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
            const {
              subscribeIntensity,
            } = await zclNode.endpoints[self.getClusterEndpoint(MeterIdentificationCluster)]
              .clusters[MeterIdentificationCluster.NAME]
              .readAttributes([
                'subscribeIntensity'
              ]);

            await self.setCapabilityValue('subscribe_intensity_capability', subscribeIntensity);

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

            if (self.getCapabilityValue('mode_capability') === 'standard') {
              // lecture et décodage de la couleur de demain via registerStatus (bits 24-25)
              try {
                const { registerStatus } = await zclNode.endpoints[self.getClusterEndpoint(LixeePrivateCluster)]
                  .clusters[LixeePrivateCluster.NAME]
                  .readAttributes([
                    'registerStatus'
                  ]);
                tomorrowRaw = registerStatus;
                // Parse en entier non signé avant l'extraction de la couleur
                let regDec = self._parseRegisterToUint32(registerStatus);
                normTomorrow = self._extractTomorrowFromRegister(regDec);
                normToday = self._extractTodayFromRegister(regDec);

                try {
                  const todayStr = normToday ?? '----';
                  const tomorrowStr = normTomorrow ?? '----';
                  const debugValue = `${priceOption} - ${tomorrowRaw} - ${regDec} - ${todayStr} | ${tomorrowStr}`;
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
              await self.setCapabilityValue('apparent_power_instant_inject_capability', apparentPowerInstInject ? apparentPowerInstInject : 0);
            } else {
              // Mode historique/Tempo: lecture tomorrowColor (texte) puis normalisation
              try {
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

            await self.setCapabilityValue('clock_full_hour_empty_hour_capability', clockFullHourEmptyHour);
            // N'actualise la capability que si on a une valeur normalisée valide
            // Fallback API Tempo si aujourd'hui ET demain sont inconnus ('----')
            try {
              const todayUnknown = (normToday === null || normToday === '----');
              const tomorrowUnknown = (normTomorrow === null || normTomorrow === '----');
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

            if (normTomorrow !== null) {
              self.log(`[TOMORROW] Raw='${tomorrowRaw}' -> Normalized='${normTomorrow}'`);
              await self._updateTomorrowColorIfChanged(normTomorrow);
            }

            if (normToday !== null) {
              self.log(`[TODAY] Raw='${tomorrowRaw}' -> Normalized='${normToday}'`);
              await self._updateTodayColorIfChanged(normToday);
            }

            await self.setCapabilityValue('alarm_subscribe_power_capability', subscribePowerAlert !== 0);

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
              await self.setCapabilityValue('measure_power', parseInt(apparentPower) + parseInt(phase2ApparentPower ?? 0) + parseInt(phase3ApparentPower ?? 0));
            } else {
              await self.setCapabilityValue('measure_power', apparentPower);
            }

            await self.setCapabilityValue('active_power_capability', activePower);
            await self.setCapabilityValue('rms_current_capability', rmsCurrent);
            await self.setCapabilityValue('rms_voltage_capability', rmsVoltage);
            await self.setCapabilityValue('maximal_intensity_capability', maximalIntensity);

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

              let cumulativeIndex = Math.floor((currentSummationDeliveredHP ?? 0) / 1000) + Math.floor((currentSummationDeliveredHC ?? 0) / 1000);
              await self.setCapabilityValue('meter_power', cumulativeIndex);
              await self.setCapabilityValue('meter_power.imported', cumulativeIndex);

              self.log(`currentSummationDeliveredHP=${currentSummationDeliveredHP} currentSummationDeliveredHC=${currentSummationDeliveredHC}`);
              self.log(`hpLastValue=${hpLastValue} hcLastValue=${hcLastValue}`);

              if (hpLastValue == 0) {
                hpLastValue = currentSummationDeliveredHP;
              }

              if (currentSummationDeliveredHP != hpLastValue) {
                hpLastValue = currentSummationDeliveredHP;
                await self._updatePeriodIfChanged('HP..');
              }

              currentSummationDeliveredHP = Math.floor((currentSummationDeliveredHP ?? 0) / 1000);
              await self.setCapabilityValue('full_hour_capability', currentSummationDeliveredHP);

              if (hcLastValue == 0) {
                hcLastValue = currentSummationDeliveredHC;
              }

              if (currentSummationDeliveredHC != hcLastValue) {
                hcLastValue = currentSummationDeliveredHC;
                await self._updatePeriodIfChanged('HC..');
              }

              currentSummationDeliveredHC = Math.floor((currentSummationDeliveredHC ?? 0) / 1000);
              await self.setCapabilityValue('empty_hour_capability', currentSummationDeliveredHC);
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
  _computeApplicableCapabilities(mode, phase, priceOption) {
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
      'phase_1_apparent_power_capability',
      'phase_2_apparent_power_capability',
      'phase_3_apparent_power_capability'
    ];

    const applicable = new Set(
      CAPABILITY_ORDER.filter(capability => !CONDITIONAL_CAPABILITIES.includes(capability))
    );

    if (HP_HC_PRICE_OPTIONS.includes(priceOption)) {
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
      applicable.add('apparent_power_instant_inject_capability');
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

    const layoutChanged = await this._applyCapabilityLayout(
      this._computeApplicableCapabilities(mode, phase, priceOption)
    );

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

// Normalise l'option tarifaire lue sur le compteur: nettoyage de la chaîne puis alias
// ('BBRx' -> 'BBR', 'HC..'/'H PLEINE/CREUSE' -> 'HPHC', 'EJP' -> 'EJP.').
// Retourne une chaîne vide si la lecture est vide.
Device.prototype._normalizePriceOption = function(raw) {
  let val = String(raw ?? '').replace(/\0/g, '').trim();

  if (!val) return '';
  if (val === 'BBRx') val = 'BBR';
  if (val === 'HC..') val = 'HPHC';
  if (val === 'H PLEINE/CREUSE') val = 'HPHC';
  if (val === 'EJP') val = 'EJP.';

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

    const VALID = ['BASE', 'TEMPO', 'HC..', 'HPHC', 'EJP.', 'BBR'];
    if (!VALID.includes(val)) val = 'UNKN';

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
    // Derniers index connus, utilisés par resetDailyCost() qui est appelé hors de cet intervalle
    this._lastIndexes = indexes;

    if (!this.hasCapability('measure_daily_cost_capability')) return;

    const settings = this.getSettings();
    const priceOption = this.getCapabilityValue('price_option_capability');
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

    await this.setCapabilityValue(
      'measure_daily_cost_capability',
      this._computeDailyCost(priceOption, state, indexes, settings)
    );

    if (this.hasCapability('measure_current_kwh_price_capability')) {
      await this.setCapabilityValue('measure_current_kwh_price_capability', Tariff.currentKwhPrice(
        priceOption,
        this.getCapabilityValue('price_period_capability'),
        this.getCapabilityValue('today_color_capability'),
        settings
      ));
    }
  } catch (e) {
    this.error(`_updateDailyCost failed: ${e && e.message ? e.message : e}`);
  }
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
    const total = this._computeDailyCost(
      this.getCapabilityValue('price_option_capability'),
      state,
      this._lastIndexes || {},
      this.getSettings()
    );
    await this.setCapabilityValue('measure_daily_cost_capability', total)
      .catch(e => this.error(`reset measure_daily_cost_capability failed: ${e && e.message ? e.message : e}`));
  }

  this.log(`[COST] Coût du jour remis à zéro pour le ${dayKey} (la part d'abonnement du jour reste comptée)`);
};

module.exports = Device;
