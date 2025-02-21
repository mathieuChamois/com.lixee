const { ZigBeeDevice } = require('homey-zigbeedriver');
const {
  debug,
  CLUSTER
} = require('zigbee-clusters');
const { Log } = require('homey-log');

var currentMode;
var lastLogDate;

const Homey = require('homey');
const HomeyModule = require('homey');

var message;
var state;

class Device extends ZigBeeDevice {
  async onNodeInit({ zclNode }) {
    this.enableDebug();
    debug(true);
    this.printNode();

    await this.getMode(zclNode)
      .then(
        async () => await this.prepareMode()
          .then(
            async () => await this.prepareCapabilities()
              .then(
                async () => {
                  setInterval(async () => {
                    try {
                      const {
                        subscribeIntensity,
                      } = await zclNode.endpoints[this.getClusterEndpoint(CLUSTER.METER_IDENTIFICATION)]
                        .clusters[CLUSTER.METER_IDENTIFICATION.NAME]
                        .readAttributes(
                          'subscribeIntensity',
                        );

                      await this.setCapabilityValue('subscribe_intensity_capability', subscribeIntensity);

                      this.log(`Cluster meter identification return response correctly`);
                    } catch (e) {
                      this.log(`Something wrong with zigbee cluster and message : ${e.message}, app will retry later `);
                    }
                  }, 10000);

                  setInterval(async () => {
                    try {
                      let {
                        priceOption
                      } = await zclNode.endpoints[this.getClusterEndpoint(CLUSTER.LIXEE_PRIVATE)]
                        .clusters[CLUSTER.LIXEE_PRIVATE.NAME]
                        .readAttributes(
                          'priceOption'
                        );

                      const {
                        subscribePowerAlert,
                      } = await zclNode.endpoints[this.getClusterEndpoint(CLUSTER.LIXEE_PRIVATE)]
                        .clusters[CLUSTER.LIXEE_PRIVATE.NAME]
                        .readAttributes(
                          'subscribePowerAlert',
                        );

                      const {
                        tomorrowColor,
                      } = await zclNode.endpoints[this.getClusterEndpoint(CLUSTER.LIXEE_PRIVATE)]
                        .clusters[CLUSTER.LIXEE_PRIVATE.NAME]
                        .readAttributes(
                          'tomorrowColor'
                        );

                      const {
                        clockFullHourEmptyHour,
                      } = await zclNode.endpoints[this.getClusterEndpoint(CLUSTER.LIXEE_PRIVATE)]
                        .clusters[CLUSTER.LIXEE_PRIVATE.NAME]
                        .readAttributes(
                          'clockFullHourEmptyHour'
                        );

                      await this.setCapabilityValue('debug_capability', priceOption || null);

                      if (['BASE', 'HC..', 'EJP.', 'BBR'].includes(priceOption) == false) {
                        priceOption = 'BBR';
                      }

                      await this.setCapabilityValue('price_option_capability', priceOption);
                      await this.setCapabilityValue('clock_full_hour_empty_hour_capability', clockFullHourEmptyHour);
                      await this.setCapabilityValue('tomorrow_color_capability', tomorrowColor || '----');
                      await this.setCapabilityValue('alarm_subscribe_power_capability', subscribePowerAlert !== 0);

                      this.log(`Cluster lixee private return response correctly`);
                    } catch (e) {
                      this.log(`Something wrong with zigbee cluster and message : ${e.message}, app will retry later `);
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
                      } = await zclNode.endpoints[this.getClusterEndpoint(CLUSTER.ELECTRICAL_MEASUREMENT)]
                        .clusters[CLUSTER.ELECTRICAL_MEASUREMENT.NAME]
                        .readAttributes(
                          'rmsVoltage',
                          'rmsCurrent',
                          'activePower',
                          'apparentPower',
                          'maximalIntensity',
                          'measurementType',
                          'phase2ApparentPower',
                          'phase3ApparentPower',
                        );

                      if (phase2ApparentPower == undefined || phase2ApparentPower == 65535) {
                        phase2ApparentPower = 0;
                      }

                      if (phase3ApparentPower == undefined || phase3ApparentPower == 65535) {
                        phase3ApparentPower = 0;
                      }

                      if (this.hasCapability('phase_capability') && this.getCapabilityValue('phase_capability') == 'triphase') {
                        await this.setCapabilityValue('phase_1_apparent_power_capability', apparentPower);
                        await this.setCapabilityValue('phase_2_apparent_power_capability', phase2ApparentPower ?? 0);
                        await this.setCapabilityValue('phase_3_apparent_power_capability', phase3ApparentPower ?? 0);
                        await this.setCapabilityValue('measure_power', parseInt(apparentPower) + parseInt(phase2ApparentPower ?? 0) + parseInt(phase3ApparentPower ?? 0));
                      } else {
                        await this.setCapabilityValue('measure_power', apparentPower);
                      }

                      await this.setCapabilityValue('active_power_capability', activePower);
                      await this.setCapabilityValue('rms_current_capability', rmsCurrent);
                      await this.setCapabilityValue('rms_voltage_capability', rmsVoltage);
                      await this.setCapabilityValue('maximal_intensity_capability', maximalIntensity);

                      this.log(`Cluster electrical measurement return response correctly`);

                      try {
                        if (HomeyModule.env.HOMEY_LOG_FORCE === 1) {
                          this.homeyLog = new Log({ homey: this.homey });
                          this.homeyLog.setTags(this.getState());
                          const today = new Date().toISOString()
                            .split('T')[0];
                          if (lastLogDate !== today) {
                            let modeCapability = this.hasCapability('mode_capability') ? this.getCapabilityValue('mode_capability') : 'unknown';
                            this.homeyLog.captureMessage(modeCapability);
                            lastLogDate = today;
                          }
                        } else {
                          this.log(`Sentry log is disable`);
                        }
                      } catch (e) {
                        this.log(`Cannot send log to sentry`);
                      }

                    } catch (e) {
                      this.log(`Something wrong with zigbee cluster and message : ${e.message}, app will retry later `);
                    }
                  }, 10000);

                  setInterval(async () => {
                    try {
                      let {
                        currentSummationDelivered,
                        currentSummationDeliveredHCHC,
                        currentSummationDeliveredHCHP,
                        serialNumber,
                        pricePeriod
                      } = await zclNode.endpoints[this.getClusterEndpoint(CLUSTER.METERING)]
                        .clusters[CLUSTER.METERING.NAME]
                        .readAttributes(
                          'currentSummationDelivered',
                          'currentSummationDeliveredHCHC',
                          'currentSummationDeliveredHCHP',
                          'serialNumber',
                          'pricePeriod',
                        );

                      await this.setCapabilityValue('serial_number_capability', serialNumber);

                      if (['TH..', 'HC..', 'HP..', 'HN..', 'PM..', 'HCJB', 'HCJW', 'HCJR', 'HPJB', 'HPJW', 'HPJR'].includes(pricePeriod) == false) {
                        pricePeriod = 'UNKN';
                      }

                      await this.setCapabilityValue('price_period_capability', pricePeriod);

                      switch (this.getCapabilityValue('price_option_capability')) {
                        case 'BASE':
                          await this.setCapabilityValue('meter_power', (currentSummationDelivered / 1000));
                          break;
                        case 'HC..':
                          if (currentSummationDeliveredHCHP > 0) {
                            await this.setCapabilityValue('meter_power', (currentSummationDeliveredHCHP / 1000));
                          } else {
                            await this.setCapabilityValue('meter_power', (currentSummationDelivered / 1000));
                          }
                          break;
                        case 'EJP.':
                        case 'BBR':
                          await this.setCapabilityValue('meter_power', (currentSummationDelivered / 1000));
                          break;
                      }

                      this.log(`Cluster metering return response correctly`);
                    } catch (e) {
                      this.log(`Something wrong with zigbee cluster and message : ${e.message}, app will retry later `);
                    }
                  }, 10000);
                }
              )
          )
      );
  }

  async prepareCapabilities() {
    await this.removeCapability('debug_capability')
      .catch(this.error);
    await this.removeCapability('price_option_capability')
      .catch(this.error);
    await this.removeCapability('clock_full_hour_empty_hour_capability')
      .catch(this.error);
    await this.removeCapability('serial_number_capability')
      .catch(this.error);
    await this.removeCapability('price_period_capability')
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
    await this.addCapability('price_option_capability')
      .catch(this.error);
    await this.addCapability('price_period_capability')
      .catch(this.error);
    await this.addCapability('serial_number_capability')
      .catch(this.error);
    await this.addCapability('alarm_subscribe_power_capability')
      .catch(this.error);
    await this.addCapability('tomorrow_color_capability')
      .catch(this.error);
    await this.addCapability('clock_full_hour_empty_hour_capability')
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
  }

  async getMode(zclNode) {
    currentMode = await zclNode.endpoints[this.getClusterEndpoint(CLUSTER.LIXEE_PRIVATE)]
      .clusters[CLUSTER.LIXEE_PRIVATE.NAME]
      .readAttributes(
        'mode'
      );
  }

  async prepareMode() {
    let explodedMode = currentMode.mode.split('_');

    await this.removeCapability('phase_capability')
      .catch(this.error)
      .then(async () => {
          await this.addCapability('phase_capability')
            .catch(this.error)
            .then(async () => {
                if (explodedMode[1] !== undefined && this.hasCapability('phase_capability')) {
                  await this.setCapabilityValue('phase_capability', explodedMode[1]);
                }

                await this.removeCapability('phase_1_apparent_power_capability')
                  .catch(this.error)
                  .then(async () => {
                      if (explodedMode[1] === 'triphase') {
                        await this.addCapability('phase_1_apparent_power_capability')
                          .catch(this.error);
                      }
                    }
                  );

                await this.removeCapability('phase_2_apparent_power_capability')
                  .catch(this.error)
                  .then(async () => {
                      if (explodedMode[1] === 'triphase') {
                        await this.addCapability('phase_2_apparent_power_capability')
                          .catch(this.error);
                      }
                    }
                  );
                await this.removeCapability('phase_3_apparent_power_capability')
                  .catch(this.error)
                  .then(async () => {
                      if (explodedMode[1] === 'triphase') {
                        await this.addCapability('phase_3_apparent_power_capability')
                          .catch(this.error);
                      }
                    }
                  );

              }
            );
        }
      );

    await this.removeCapability('mode_capability')
      .catch(this.error)
      .then(async () => {
          await this.addCapability('mode_capability')
            .catch(this.error)
            .then(async () => {
                if (explodedMode[0] !== undefined && this.hasCapability('mode_capability')) {
                  await this.setCapabilityValue('mode_capability', explodedMode[0]);
                }
              }
            );
        }
      );

    await this.removeCapability('produce_capability')
      .catch(this.error)
      .then(async () => {
          await this.addCapability('produce_capability')
            .catch(this.error)
            .then(async () => {
                await this.setCapabilityValue('produce_capability', false);
                if (explodedMode[2] !== undefined) {
                  await this.setCapabilityValue('produce_capability', true);
                }
              }
            );
        }
      );
  }
}

module.exports = Device;
