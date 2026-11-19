const { Cluster,ZCLDataTypes } = require('zigbee-clusters');

const ATTRIBUTES = {
  // ISOUSC (A) en historique, PREF (kVA) en standard: Uint16 d'après la documentation ZLinky
  subscribeIntensity: { id: 0x000D, type: ZCLDataTypes.uint16 },
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
