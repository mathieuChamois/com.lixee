const { Cluster,ZCLDataTypes } = require('zigbee-clusters');

const ATTRIBUTES = {
  subscribeIntensity: { id: 0x000D, type: ZCLDataTypes.int16 },
};

const COMMANDS = {};

class MeterIdentificationCluster extends Cluster {

  static get ID() {
    return 0x0B01;
  }

  static get NAME() {
    return 'meterIdentification';
  }

  static get ATTRIBUTES() {
    return ATTRIBUTES;
  }

  static get COMMANDS() {
    return COMMANDS;
  }

}

Cluster.addCluster(MeterIdentificationCluster);

module.exports = MeterIdentificationCluster;
