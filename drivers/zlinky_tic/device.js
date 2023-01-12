const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require("zigbee-clusters");

class Device extends ZigBeeDevice {
  async onNodeInit({ zclNode }) {
    setInterval(async () => {
      try {
        if (typeof this.activePowerFactor !== 'number') {
          const {
            rmsVoltage,
            rmsCurrent,
            activePower,
            apparentPower,
          } = await zclNode.endpoints[this.getClusterEndpoint(CLUSTER.ELECTRICAL_MEASUREMENT)]
            .clusters[CLUSTER.ELECTRICAL_MEASUREMENT.NAME]
            .readAttributes(
              'rmsVoltage',
              'rmsCurrent',
              'activePower',
              'apparentPower',
            );

          this.setCapabilityValue('measure_power', apparentPower);
          this.setCapabilityValue('active_power_capability', activePower);
          this.setCapabilityValue('rms_current_capability', rmsCurrent);
          this.setCapabilityValue('rms_voltage_capability', rmsVoltage);
        }
      } catch (e) {
        this.log(`Something wrong with zigbee cluster and message : ${e.message}, app will retry later `);
      }
    }, 7000);

    setInterval(async () => {
      try {
        if (typeof this.meteringFactor !== 'number') {
          const {
            currentSummationDelivered,
          } = await zclNode.endpoints[this.getClusterEndpoint(CLUSTER.METERING)]
            .clusters[CLUSTER.METERING.NAME]
            .readAttributes(
              'currentSummationDelivered',
            );

          this.log(zclNode.endpoints[
            this.getClusterEndpoint(CLUSTER.METERING)]
            .clusters[CLUSTER.METERING.NAME]);

          this.setCapabilityValue('meter_power', (currentSummationDelivered / 1000));
        }
      } catch (e) {
        this.log(`Something wrong with zigbee cluster and message : ${e.message}, app will retry later `);
      }
    }, 7000);
  }
}

module.exports = Device;
