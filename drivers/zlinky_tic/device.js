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

class Device extends ZigBeeDevice {
  async onNodeInit({ zclNode }) {
    this.enableDebug();
    debug(true);
    this.printNode();
    const self = this;

    await doInit();

    async function doInit() {
      try {
        await self.prepareMode(await self.getMode(zclNode));
        await self.prepareCapabilities()

        // Enregistre la condition Flow "period_option_is"
        try {
          // Options de saisie semi-automatique pour "target" (périodes)
          const PERIOD_OPTIONS = [
            { id: 'TH..', name: 'Toutes Heures' },
            { id: 'HC..', name: 'Heures Creuses' },
            { id: 'HP..', name: 'Heures Pleines' },
            { id: 'HN..', name: 'Heures Normales' },
            { id: 'PM..', name: 'Pointe Mobile' },
            { id: 'HCJB', name: 'HC Jour Bleu' },
            { id: 'HCJW', name: 'HC Jour Blanc' },
            { id: 'HCJR', name: 'HC Jour Rouge' },
            { id: 'HPJB', name: 'HP Jour Bleu' },
            { id: 'HPJW', name: 'HP Jour Blanc' },
            { id: 'HPJR', name: 'HP Jour Rouge' },
            { id: 'UNKN', name: 'Inconnu' },
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
            const q = (query || '').toString().toLowerCase();
            if (!q) return PERIOD_OPTIONS;
            return PERIOD_OPTIONS.filter(opt =>
              opt.id.toLowerCase().includes(q) || (opt.name && opt.name.toLowerCase().includes(q))
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
              { id: 'TH..', name: 'Toutes Heures' },
              { id: 'HC..', name: 'Heures Creuses' },
              { id: 'HP..', name: 'Heures Pleines' },
              { id: 'HN..', name: 'Heures Normales' },
              { id: 'PM..', name: 'Pointe Mobile' },
              { id: 'HCJB', name: 'HC Jour Bleu' },
              { id: 'HCJW', name: 'HC Jour Blanc' },
              { id: 'HCJR', name: 'HC Jour Rouge' },
              { id: 'HPJB', name: 'HP Jour Bleu' },
              { id: 'HPJW', name: 'HP Jour Blanc' },
              { id: 'HPJR', name: 'HP Jour Rouge' },
              { id: 'UNKN', name: 'Inconnu' },
            ];
            const q = (query || '').toString().toLowerCase();
            if (!q) return PERIOD_OPTIONS;
            return PERIOD_OPTIONS.filter(opt =>
              opt.id.toLowerCase().includes(q) || (opt.name && opt.name.toLowerCase().includes(q))
            );
          });
        } catch (e) {
          self.error(`Failed to register trigger card period_option_became: ${e && e.message ? e.message : e}`);
        }

        // Mémorise la dernière période connue
        self._lastPeriod = self.getCapabilityValue('price_period_capability');

        // Helper: met à jour la capability de période et déclenche le Flow si elle change
        self._updatePeriodIfChanged = async (newValue) => {
          try {
            if (!newValue) return;
            const prev = self._lastPeriod;
            if (prev !== newValue) {
              await self.setCapabilityValue('price_period_capability', newValue);
              self._lastPeriod = newValue;
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
            let {
              priceOption
            } = await zclNode.endpoints[self.getClusterEndpoint(LixeePrivateCluster)]
              .clusters[LixeePrivateCluster.NAME]
              .readAttributes([
                'priceOption'
              ]);

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
              tomorrowColor,
            } = await zclNode.endpoints[self.getClusterEndpoint(LixeePrivateCluster)]
              .clusters[LixeePrivateCluster.NAME]
              .readAttributes([
                'tomorrowColor'
              ]);

            const {
              clockFullHourEmptyHour,
            } = await zclNode.endpoints[self.getClusterEndpoint(LixeePrivateCluster)]
              .clusters[LixeePrivateCluster.NAME]
              .readAttributes([
                'clockFullHourEmptyHour'
              ]);

            if (self.getCapabilityValue('mode_capability') === 'standard') {
              if (['BASE', 'HC..', 'EJP.', 'BBR'].includes(priceOption) == false) {
                priceOption = 'BBR';
              }

              // On continue à mettre à jour la capability d'option tarifaire pour compatibilité existante
              await self._updatePriceOptionIfChanged(priceOption);
              await self.setCapabilityValue('apparent_power_instant_inject_capability', apparentPowerInstInject);
            }

            await self.setCapabilityValue('clock_full_hour_empty_hour_capability', clockFullHourEmptyHour);
            await self.setCapabilityValue('tomorrow_color_capability', tomorrowColor || '----');
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
                await self.removeCapability('phase_1_apparent_power_capability').catch(this.error);
              }

              if (self.hasCapability('phase_2_apparent_power_capability')) {
                await self.removeCapability('phase_2_apparent_power_capability').catch(this.error);
              }

              if (self.hasCapability('phase_3_apparent_power_capability')) {
                await self.removeCapability('phase_3_apparent_power_capability').catch(this.error);
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
              currentSummationDeliveredHCHC,
              currentSummationDeliveredHCHP,
              activeEnergyTotalInjected,
              serialNumber,
              pricePeriod
            } = await zclNode.endpoints[self.getClusterEndpoint(CLUSTER.METERING)]
              .clusters[CLUSTER.METERING.NAME]
              .readAttributes([
                'currentSummationDelivered',
                'currentSummationDeliveredHCHC',
                'currentSummationDeliveredHCHP',
                'serialNumber',
                'pricePeriod'
              ]);

            await self.setCapabilityValue('serial_number_capability', serialNumber);

            // if (self.getCapabilityValue('mode_capability') === 'historique') {
              if (currentSummationDelivered != 0) {
                if (currentSummationDelivered != self.getCapabilityValue('meter_power.imported')) {
                  await self._updatePeriodIfChanged('TH..');
                  await self._updatePriceOptionIfChanged('BASE');
                  await self.setCapabilityValue('meter_power', (currentSummationDelivered / 1000));
                  await self.setCapabilityValue('meter_power.imported', (currentSummationDelivered / 1000));
                  await self.setCapabilityValue('meter_power.exported', activeEnergyTotalInjected ?? 0);
                }
              }

              self.log(currentSummationDeliveredHCHP);
              self.log(hpLastValue);

              if (currentSummationDeliveredHCHP != hpLastValue) {
                hpLastValue = currentSummationDeliveredHCHP;
                currentSummationDeliveredHCHP = Math.floor((currentSummationDeliveredHCHP ?? 0) / 1000);
                await self._updatePeriodIfChanged('HP..');
                await self.setCapabilityValue('price_option_capability', 'HPHC');
                await self.setCapabilityValue('full_hour_capability', currentSummationDeliveredHCHP);
                await self.setCapabilityValue('meter_power', currentSummationDeliveredHCHP);
                await self.setCapabilityValue('meter_power.imported', currentSummationDeliveredHCHP);
                await self.setCapabilityValue('meter_power.exported', activeEnergyTotalInjected ?? 0);
              }

              self.log(currentSummationDeliveredHCHC);
              self.log(hcLastValue);

              if (currentSummationDeliveredHCHC != hcLastValue) {
                hcLastValue = currentSummationDeliveredHCHC;
                currentSummationDeliveredHCHC = Math.floor((currentSummationDeliveredHCHC ?? 0) / 1000);
                await self._updatePeriodIfChanged('HC..');
                await self.setCapabilityValue('price_option_capability', 'HPHC');
                await self.setCapabilityValue('empty_hour_capability', currentSummationDeliveredHCHC);
                await self.setCapabilityValue('meter_power', currentSummationDeliveredHCHC);
                await self.setCapabilityValue('meter_power.imported', currentSummationDeliveredHCHC);
                await self.setCapabilityValue('meter_power.exported', activeEnergyTotalInjected ?? 0);
              }

              switch (self.getCapabilityValue('price_option_capability')) {
                case 'EJP.':
                case 'BBR':
                  await self.setCapabilityValue('meter_power', (currentSummationDelivered / 1000));
                  await self.setCapabilityValue('meter_power.imported', (currentSummationDelivered / 1000));
                  await self.setCapabilityValue('meter_power.exported', activeEnergyTotalInjected ?? 0);
                  break;
              }
            // } else {
            //   if (['TH..', 'HC..', 'HP..', 'HN..', 'PM..', 'HCJB', 'HCJW', 'HCJR', 'HPJB', 'HPJW', 'HPJR'].includes(pricePeriod) == false) {
            //     pricePeriod = 'UNKN';
            //   }
            //
            //   await self.setCapabilityValue('price_period_capability', pricePeriod);
            //
            //   self.log(self.getCapabilityValue('price_option_capability'));
            //   switch (self.getCapabilityValue('price_option_capability')) {
            //     case 'BASE':
            //       await self.setCapabilityValue('meter_power', (currentSummationDelivered / 1000));
            //       await self.setCapabilityValue('meter_power.imported', (currentSummationDelivered / 1000));
            //       await self.setCapabilityValue('meter_power.exported', 0);
            //       break;
            //     case 'HC..':
            //       if (currentSummationDeliveredHCHP > 0) {
            //         await self.setCapabilityValue('meter_power', (currentSummationDeliveredHCHP / 1000));
            //         await self.setCapabilityValue('meter_power.imported', (currentSummationDeliveredHCHP / 1000));
            //         await self.setCapabilityValue('meter_power.exported', 0);
            //       } else {
            //         await self.setCapabilityValue('meter_power', (currentSummationDelivered / 1000));
            //         await self.setCapabilityValue('meter_power.imported', (currentSummationDelivered / 1000));
            //         await self.setCapabilityValue('meter_power.exported', 0);
            //       }
            //       break;
            //     case 'EJP.':
            //     case 'BBR':
            //       await self.setCapabilityValue('meter_power', (currentSummationDelivered / 1000));
            //       await self.setCapabilityValue('meter_power.imported', (currentSummationDelivered / 1000));
            //       await self.setCapabilityValue('meter_power.exported', 0);
            //       break;
            //   }
            // }

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
    await this.addCapability('alarm_subscribe_power_capability')
      .catch(this.error);
    await this.addCapability('tomorrow_color_capability')
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
      await this.addCapability('meter_power').catch(this.error);
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
      case 0: return ['historique', 'monophase'];
      case 1: return ['standard', 'monophase'];
      case 2: return ['historique', 'triphase'];
      case 3: return ['standard', 'triphase'];
      case 5: return ['historique', 'triphase', 'producteur'];
      case 7: return ['standard', 'triphase', 'producteur'];
      default:
        this.log(`Unknown mode value for 0x0300: ${modeInt} — defaulting to historique_monophase`);
        return ['historique', 'monophase'];
    }
  }

  async prepareMode(currentMode) {
    const explodedMode = this.decodeMode(currentMode.mode);

    await this.removeCapability('meter_power.imported').catch(this.error);

    await this.addCapability('meter_power.imported').catch(this.error)
      .then(async () => {
        await this.removeCapability('meter_power.exported').catch(this.error);
        await this.addCapability('meter_power.exported')
          .catch(this.error)
          .then(async () => {
            if (!this.hasCapability('meter_power.exported')) {
              this.log('meter_power.exported capability not created; skipping subsequent capabilities');
              return;
            }

            await this.removeCapability('full_hour_capability').catch(this.error);
            await this.removeCapability('empty_hour_capability').catch(this.error);
            await this.addCapability('full_hour_capability').catch(this.error);
            await this.addCapability('empty_hour_capability').catch(this.error);

            await this.removeCapability('price_period_capability').catch(this.error);
            await this.addCapability('price_period_capability').catch(this.error);

            await this.removeCapability('phase_1_apparent_power_capability').catch(this.error);
            if (explodedMode[1] === 'triphase') await this.addCapability('phase_1_apparent_power_capability');

            await this.removeCapability('phase_2_apparent_power_capability').catch(this.error);
            if (explodedMode[1] === 'triphase') await this.addCapability('phase_2_apparent_power_capability');

            await this.removeCapability('phase_3_apparent_power_capability').catch(this.error);
            if (explodedMode[1] === 'triphase') await this.addCapability('phase_3_apparent_power_capability');

            await this.removeCapability('price_option_capability').catch(this.error);
            await this.addCapability('price_option_capability').catch(this.error);

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

            await this.removeCapability('apparent_power_instant_inject_capability').catch(this.error);

            if (explodedMode[0] === 'standard') {
              await this.addCapability('apparent_power_instant_inject_capability').catch(this.error);
            }

            await this.removeCapability('produce_capability').catch(this.error);
            await this.addCapability('produce_capability');
            await this.setCapabilityValue('produce_capability', explodedMode[2] !== undefined);

            await this.removeCapability('debug_capability').catch(this.error);
            await this.addCapability('debug_capability').catch(this.error);
            await this.setCapabilityValue('debug_capability', String(currentMode.mode));
          });
      });
  }
}

module.exports = Device;
