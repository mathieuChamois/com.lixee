const { ZigBeeDevice } = require('homey-zigbeedriver');
const { debug, CLUSTER } = require("zigbee-clusters");

class Device extends ZigBeeDevice {
  async onNodeInit({ zclNode }) {
    this.enableDebug();
    // debug(true);
    // this.printNode();

    await this.prepareCapabilities();

    setInterval(async () => {
      try {
        const {
          subscribeIntensity,
        } = await zclNode.endpoints[this.getClusterEndpoint(CLUSTER.METER_IDENTIFICATION)]
          .clusters[CLUSTER.METER_IDENTIFICATION.NAME]
          .readAttributes(
            'subscribeIntensity',
          );

        this.setCapabilityValue('subscribe_intensity_capability', subscribeIntensity);

        this.log(`Cluster meter identification return response correctly`);
      } catch (e) {
        this.log(`Something wrong with zigbee cluster and message : ${e.message}, app will retry later `);
      }
    }, 10000);

    setInterval(async () => {
      try {
        const {
          priceOption,
        } = await zclNode.endpoints[this.getClusterEndpoint(CLUSTER.LIXEE_PRIVATE)]
          .clusters[CLUSTER.LIXEE_PRIVATE.NAME]
          .readAttributes(
            'priceOption',
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

        this.setCapabilityValue('price_option_capability', priceOption);
        this.setCapabilityValue('clock_full_hour_empty_hour_capability', clockFullHourEmptyHour);
        this.setCapabilityValue('tomorrow_color_capability', tomorrowColor === "" ? "----" : tomorrowColor);
        this.setCapabilityValue('alarm_subscribe_power_capability', subscribePowerAlert !== 0);

        this.log(`Cluster lixee private return response correctly`);
      } catch (e) {
        this.log(`Something wrong with zigbee cluster and message : ${e.message}, app will retry later `);
      }
    }, 10000);

    setInterval(async () => {
      try {
        const {
          rmsVoltage,
          rmsCurrent,
          activePower,
          apparentPower,
          maximalIntensity,
        } = await zclNode.endpoints[this.getClusterEndpoint(CLUSTER.ELECTRICAL_MEASUREMENT)]
          .clusters[CLUSTER.ELECTRICAL_MEASUREMENT.NAME]
          .readAttributes(
            'rmsVoltage',
            'rmsCurrent',
            'activePower',
            'apparentPower',
            'maximalIntensity',
          );

        this.setCapabilityValue('measure_power', apparentPower);
        this.setCapabilityValue('active_power_capability', activePower);
        this.setCapabilityValue('rms_current_capability', rmsCurrent);
        this.setCapabilityValue('rms_voltage_capability', rmsVoltage);
        this.setCapabilityValue('maximal_intensity_capability', maximalIntensity);

        this.log(`Cluster electrical measurement return response correctly`);
      } catch (e) {
        this.log(`Something wrong with zigbee cluster and message : ${e.message}, app will retry later `);
      }
    }, 10000);

    setInterval(async () => {
      try {
        const {
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

        this.setCapabilityValue('serial_number_capability', serialNumber);
        this.setCapabilityValue('price_period_capability', pricePeriod);

        switch (this.getCapabilityValue('price_option_capability')) {
          case 'BASE':
            this.setCapabilityValue('meter_power', (currentSummationDelivered / 1000));
            break;
          case 'HC':
            if (currentSummationDeliveredHCHP > 0) {
              this.setCapabilityValue('meter_power', (currentSummationDeliveredHCHP / 1000));
            } else {
              this.setCapabilityValue('meter_power', (currentSummationDeliveredHCHP / 1000));
            }
            break;
          case 'EJP':
          case 'BBRx':
            this.setCapabilityValue('meter_power', (currentSummationDelivered / 1000));
            break;
        }

        this.log(`Cluster metering return response correctly`);
      } catch (e) {
        this.log(`Something wrong with zigbee cluster and message : ${e.message}, app will retry later `);
      }
    }, 10000);
  }

  async prepareCapabilities() {
    await this.removeCapability('price_option_capability').catch(this.error);
    await this.removeCapability('clock_full_hour_empty_hour_capability').catch(this.error);
    await this.removeCapability('serial_number_capability').catch(this.error);
    await this.removeCapability('price_period_capability').catch(this.error);
    await this.removeCapability('tomorrow_color_capability').catch(this.error);
    await this.removeCapability('subscribe_intensity_capability').catch(this.error);
    await this.removeCapability('alarm_subscribe_power_capability').catch(this.error);
    await this.removeCapability('rms_voltage_capability').catch(this.error);
    await this.removeCapability('active_power_capability').catch(this.error);
    await this.removeCapability('rms_current_capability').catch(this.error);
    await this.removeCapability('power_factor_capability').catch(this.error);
    await this.removeCapability('maximal_intensity_capability').catch(this.error);
    await this.addCapability('price_option_capability').catch(this.error);
    await this.addCapability('price_period_capability').catch(this.error);
    await this.addCapability('serial_number_capability').catch(this.error);
    await this.addCapability('alarm_subscribe_power_capability').catch(this.error);
    await this.addCapability('tomorrow_color_capability').catch(this.error);
    await this.addCapability('clock_full_hour_empty_hour_capability').catch(this.error);
    await this.addCapability('subscribe_intensity_capability').catch(this.error);
    await this.addCapability('maximal_intensity_capability').catch(this.error);
    await this.addCapability('rms_current_capability').catch(this.error);
    await this.addCapability('rms_voltage_capability').catch(this.error);
    await this.addCapability('active_power_capability').catch(this.error);
  }
}

module.exports = Device;
