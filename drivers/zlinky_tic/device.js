const { ZigBeeDevice } = require('homey-zigbeedriver');
const {
  debug,
  CLUSTER
} = require('zigbee-clusters');
const LixeePrivateCluster = require('../../lib/lixeePrivateCluster');
const MeterIdentificationCluster = require('../../lib/meterIdentificationCluster');
require('../../lib/lixeeElectricalMeasurementCluster');
require('../../lib/lixeeMeteringCluster');
const { Log } = require('homey-log');

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

class Device extends ZigBeeDevice {
  async onNodeInit({ zclNode }) {
    this.enableDebug();
    debug(true);
    this.printNode();
    const self = this;

    await doInit();

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

        await self.prepareMode(await self.getMode(zclNode), await priceOption);

        await self.prepareCapabilities();

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

        // Mémorise la dernière période connue
        self._lastPeriod = self.getCapabilityValue('price_period_capability');
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
              await self.setCapabilityValue('apparent_power_instant_inject_capability', apparentPowerInstInject);
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
            if (normTomorrow !== null) {
              if (self.getCapabilityValue('tomorrow_color_capability') !== normTomorrow) {
                self.log(`[TOMORROW] Raw='${tomorrowRaw}' -> Normalized='${normTomorrow}'`);
              }
              await self.setCapabilityValue('tomorrow_color_capability', normTomorrow);
            }

            if (normToday !== null) {
              if (self.getCapabilityValue('today_color_capability') !== normToday) {
                self.log(`[TODAY] Raw='${tomorrowRaw}' -> Normalized='${normToday}'`);
              }
              await self.setCapabilityValue('today_color_capability', normToday);
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

            if (phase2ApparentPower == undefined || phase2ApparentPower == 65535) {
              phase2ApparentPower = 0;
            }

            if (phase3ApparentPower == undefined || phase3ApparentPower == 65535) {
              phase3ApparentPower = 0;
            }

            if (self.hasCapability('phase_capability') && self.getCapabilityValue('phase_capability') == 'triphase' && phase2ApparentPower == 0 && phase3ApparentPower == 0) {
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
                'serialNumber',
                'pricePeriod'
              ]);

            await self.setCapabilityValue('serial_number_capability', serialNumber);

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

            if (self.getCapabilityValue('price_option_capability') === 'TEMPO' || self.getCapabilityValue('price_option_capability') === 'BBR' || self.getCapabilityValue('price_option_capability') === 'EJP') {
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
            await self.setCapabilityValue('meter_power.exported', activeEnergyTotalInjected ?? 0);

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

  async prepareCapabilities() {
    await this.removeCapability('clock_full_hour_empty_hour_capability')
      .catch(this.error);
    await this.removeCapability('serial_number_capability')
      .catch(this.error);
    await this.removeCapability('today_color_capability')
      .catch(this.error);
    await this.removeCapability('tomorrow_color_capability')
      .catch(this.error);
    await this.removeCapability('subscribe_intensity_capability')
      .catch(this.error);
    await this.removeCapability('alarm_subscribe_power_capability')
      .catch(this.error);
    await this.removeCapability('rms_voltage_capability')
      .catch(this.error);
    await this.removeCapability('active_power_capability')
      .catch(this.error);
    await this.removeCapability('rms_current_capability')
      .catch(this.error);
    await this.removeCapability('power_factor_capability')
      .catch(this.error);
    await this.removeCapability('maximal_intensity_capability')
      .catch(this.error);

    await this.addCapability('debug_capability')
      .catch(this.error);
    await this.addCapability('serial_number_capability')
      .catch(this.error);
    await this.addCapability('clock_full_hour_empty_hour_capability')
      .catch(this.error);
    await this.addCapability('today_color_capability')
      .catch(this.error);
    await this.addCapability('tomorrow_color_capability')
      .catch(this.error);
    await this.addCapability('alarm_subscribe_power_capability')
      .catch(this.error);
    await this.addCapability('subscribe_intensity_capability')
      .catch(this.error);
    await this.addCapability('maximal_intensity_capability')
      .catch(this.error);
    await this.addCapability('rms_current_capability')
      .catch(this.error);
    await this.addCapability('rms_voltage_capability')
      .catch(this.error);
    await this.addCapability('active_power_capability')
      .catch(this.error);

    if (this.hasCapability('meter_power') === false) {
      await this.addCapability('meter_power')
        .catch(this.error);
    }
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

  async prepareMode(currentMode, priceOption) {
    this.log(`Current mode: ${currentMode.mode}`);
    const explodedMode = this.decodeMode(currentMode.mode);

    await this.removeCapability('meter_power.imported')
      .catch(this.error);

    await this.addCapability('meter_power.imported')
      .catch(this.error)
      .then(async () => {
        await this.removeCapability('meter_power.exported')
          .catch(this.error);
        await this.addCapability('meter_power.exported')
          .catch(this.error)
          .then(async () => {
            if (!this.hasCapability('meter_power.exported')) {
              this.log('meter_power.exported capability not created; skipping subsequent capabilities');
              return;
            }

            await this.removeCapability('full_hour_capability')
              .catch(this.error);
            await this.removeCapability('empty_hour_capability')
              .catch(this.error);

            if (priceOption == 'HC..' || priceOption == 'HP..') {
              await this.addCapability('full_hour_capability')
                .catch(this.error);
              await this.addCapability('empty_hour_capability')
                .catch(this.error);
            }

            await this.removeCapability('full_hour_blue_capability')
              .catch(this.error);
            await this.removeCapability('empty_hour_blue_capability')
              .catch(this.error);
            await this.removeCapability('full_hour_white_capability')
              .catch(this.error);
            await this.removeCapability('empty_hour_white_capability')
              .catch(this.error);
            await this.removeCapability('full_hour_red_capability')
              .catch(this.error);
            await this.removeCapability('empty_hour_red_capability')
              .catch(this.error);

            if (priceOption == 'TEMPO' || priceOption == 'BBR' || priceOption === 'EJP') {
              await this.addCapability('full_hour_blue_capability')
                .catch(this.error);
              await this.addCapability('empty_hour_blue_capability')
                .catch(this.error);
              await this.addCapability('full_hour_white_capability')
                .catch(this.error);
              await this.addCapability('empty_hour_white_capability')
                .catch(this.error);
              await this.addCapability('full_hour_red_capability')
                .catch(this.error);
              await this.addCapability('empty_hour_red_capability')
                .catch(this.error);
            }

            await this.removeCapability('price_period_capability')
              .catch(this.error);
            await this.addCapability('price_period_capability')
              .catch(this.error);

            await this.removeCapability('phase_1_apparent_power_capability')
              .catch(this.error);
            if (explodedMode[1] === 'triphase') await this.addCapability('phase_1_apparent_power_capability');

            await this.removeCapability('phase_2_apparent_power_capability')
              .catch(this.error);
            if (explodedMode[1] === 'triphase') await this.addCapability('phase_2_apparent_power_capability');

            await this.removeCapability('phase_3_apparent_power_capability')
              .catch(this.error);
            if (explodedMode[1] === 'triphase') await this.addCapability('phase_3_apparent_power_capability');

            await this.removeCapability('price_option_capability')
              .catch(this.error);
            await this.addCapability('price_option_capability')
              .catch(this.error);

            await this.removeCapability('mode_capability');
            await this.addCapability('mode_capability');
            if (explodedMode[0] !== undefined && this.hasCapability('mode_capability')) {
              await this.setCapabilityValue('mode_capability', explodedMode[0]);
            }

            await this.removeCapability('phase_capability');
            await this.addCapability('phase_capability');
            if (explodedMode[1] !== undefined && this.hasCapability('phase_capability')) {
              await this.setCapabilityValue('phase_capability', explodedMode[1]);
            }

            await this.removeCapability('apparent_power_instant_inject_capability')
              .catch(this.error);

            if (explodedMode[0] === 'standard') {
              await this.addCapability('apparent_power_instant_inject_capability')
                .catch(this.error);
            }

            await this.removeCapability('produce_capability')
              .catch(this.error);
            await this.addCapability('produce_capability');
            await this.setCapabilityValue('produce_capability', explodedMode[2] !== undefined);

            await this.removeCapability('debug_capability')
              .catch(this.error);
            await this.addCapability('debug_capability')
              .catch(this.error);
            await this.setCapabilityValue('debug_capability', String(currentMode.mode));
          });
      });
  }
}

// Helpers
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

// Met à jour l'option tarifaire si elle change, avec normalisation et déclenchement du Flow
// - Normalise: 'BBRx' -> 'BBR'
// - Valide contre la liste autorisée
// - Déclenche le trigger Flow 'price_option_became' si changement
Device.prototype._updatePriceOptionIfChanged = async function(newValue) {
  try {
    if (!this.hasCapability('price_option_capability')) return;
    if (!newValue) return;

    // normalisation minimale
    let val = newValue;
    if (val === 'BBRx') val = 'BBR';
    if (val === 'HC..') val = 'HPHC';
    const VALID = ['BASE', 'TEMPO', 'HC..', 'HPHC', 'EJP.', 'BBR', 'UNKN'];
    if (!VALID.includes(val)) val = 'UNKN';

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

module.exports = Device;
