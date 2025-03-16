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

        setInterval(async () => {
          try {
            const {
              subscribeIntensity,
            } = await zclNode.endpoints[self.getClusterEndpoint(MeterIdentificationCluster)]
              .clusters[MeterIdentificationCluster.NAME]
              .readAttributes(
                'subscribeIntensity'
              );

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
              .readAttributes(
                'priceOption'
              );

            const {
              subscribePowerAlert,
            } = await zclNode.endpoints[self.getClusterEndpoint(LixeePrivateCluster)]
              .clusters[LixeePrivateCluster.NAME]
              .readAttributes(
                'subscribePowerAlert'
              );

            const {
              tomorrowColor,
            } = await zclNode.endpoints[self.getClusterEndpoint(LixeePrivateCluster)]
              .clusters[LixeePrivateCluster.NAME]
              .readAttributes(
                'tomorrowColor'
              );

            const {
              clockFullHourEmptyHour,
            } = await zclNode.endpoints[self.getClusterEndpoint(LixeePrivateCluster)]
              .clusters[LixeePrivateCluster.NAME]
              .readAttributes(
                'clockFullHourEmptyHour'
              );

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
              .readAttributes(
                'rmsVoltage',
                'rmsCurrent',
                'activePower',
                'apparentPower',
                'maximalIntensity',
                'measurementType',
                'phase2ApparentPower',
                'phase3ApparentPower'
              );

            if (phase2ApparentPower == undefined || phase2ApparentPower == 65535) {
              phase2ApparentPower = 0;
            }

            if (phase3ApparentPower == undefined || phase3ApparentPower == 65535) {
              phase3ApparentPower = 0;
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

            try {
                        if (HomeyModule.env.HOMEY_LOG_FORCE === 1) {
                self.homeyLog = new Log({ homey: self.homey });
                self.homeyLog.setTags(self.getState());
                const today = new Date().toISOString()
                  .split('T')[0];
                if (lastLogDate !== today) {
                  let modeCapability = self.hasCapability('mode_capability') ? self.getCapabilityValue('mode_capability') : 'unknown';
                  self.homeyLog.captureMessage(modeCapability);
                  lastLogDate = today;
                          }
                        } else {
                          this.log(`Sentry log is disable`);
              }
            } catch (e) {
              self.log(`Cannot send log to sentry`);
            }

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
              serialNumber,
              pricePeriod
            } = await zclNode.endpoints[self.getClusterEndpoint(CLUSTER.METERING)]
              .clusters[CLUSTER.METERING.NAME]
              .readAttributes(
                'currentSummationDelivered',
                'currentSummationDeliveredHCHC',
                'currentSummationDeliveredHCHP',
                'serialNumber',
                'pricePeriod'
              );

            await self.setCapabilityValue('serial_number_capability', serialNumber);

            await self.setCapabilityValue('debug_capability', null);

            if (currentSummationDelivered != this.getCapabilityValue('meter_power')) {
              await self.setCapabilityValue('price_period_capability', 'BASE');
              await self.setCapabilityValue('price_option_capability', 'BASE');
              await self.setCapabilityValue('meter_power', (currentSummationDelivered / 1000));

              await self.removeCapability('full_hour_capability').catch(this.error);
              await self.removeCapability('empty_hour_capability').catch(this.error);
            }


            if (currentSummationDeliveredHCHP != this.getCapabilityValue('full_hour_capability')) {
              await self.setCapabilityValue('price_period_capability', 'HP..');
              await self.setCapabilityValue('price_option_capability', 'HPHC');
              await self.setCapabilityValue('full_hour_capability', currentSummationDeliveredHCHP / 1000);
            }


            if (currentSummationDeliveredHCHC != this.getCapabilityValue('empty_hour_capability')) {
              await self.setCapabilityValue('price_period_capability', 'HC..');
              await self.setCapabilityValue('price_option_capability', 'HPHC');
              await self.setCapabilityValue('empty_hour_capability', currentSummationDeliveredHCHC / 1000);
            }

            switch (self.getCapabilityValue('price_option_capability')) {
              case 'EJP.':
              case 'BBR':
                await self.setCapabilityValue('meter_power', (currentSummationDelivered / 1000));
                break;
            }

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
    return await zclNode.endpoints[this.getClusterEndpoint(LixeePrivateCluster)]
      .clusters[LixeePrivateCluster.NAME]
      .readAttributes(
        'mode'
      );
  }

  async prepareMode(currentMode) {
    let explodedMode = currentMode.mode.split('_');

    await this.removeCapability('full_hour_capability')
      .catch(this.error);
    await this.removeCapability('empty_hour_capability')
      .catch(this.error);
    await this.addCapability('full_hour_capability')
      .catch(this.error);
    await this.addCapability('empty_hour_capability')
      .catch(this.error);

    await this.removeCapability('phase_capability');
    await this.addCapability('phase_capability')
    if (explodedMode[1] !== undefined && this.hasCapability('phase_capability')) {
      await this.setCapabilityValue('phase_capability', explodedMode[1]);
    }

    await this.removeCapability('phase_1_apparent_power_capability');
    if (explodedMode[1] === 'triphase')
      await this.addCapability('phase_1_apparent_power_capability');

    await this.removeCapability('phase_2_apparent_power_capability').catch(this.error);
    if (explodedMode[1] === 'triphase')
      await this.addCapability('phase_2_apparent_power_capability');

    await this.removeCapability('phase_3_apparent_power_capability').catch(this.error);
    if (explodedMode[1] === 'triphase')
      await this.addCapability('phase_3_apparent_power_capability');

    await this.removeCapability('mode_capability')
    await this.addCapability('mode_capability');
    if (explodedMode[0] !== undefined && this.hasCapability('mode_capability')) {
      await this.setCapabilityValue('mode_capability', explodedMode[0]);
    }

    await this.removeCapability('produce_capability').catch(this.error);
    await this.addCapability('produce_capability')
    await this.setCapabilityValue('produce_capability', explodedMode[2] !== undefined);
  }
}

module.exports = Device;
