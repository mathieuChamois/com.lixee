const { Cluster,ZCLDataTypes,MeteringCluster } = require('zigbee-clusters');

const ATTRIBUTES = {
  serialNumber: { id: 0x0308, type: ZCLDataTypes.string },
  pricePeriod: { id: 0x0020, type: ZCLDataTypes.enum8({
      'TH..': 0,
      'HC..': 1,
      'HP..': 2,
      'HN..': 4,
      'PM..': 5,
      'HCJB': 6,
      'HCJW': 7,
      'HCJR': 8,
      'HPJB': 9,
      'HPJW': 10,
    }),
  },
  currentSummationDeliveredHC: { id: 0x0100, type: ZCLDataTypes.uint48 },
  currentSummationDeliveredHP: { id: 0x0102, type: ZCLDataTypes.uint48 },
  currentSummationDeliveredHCW: { id: 0x0104, type: ZCLDataTypes.uint48 },
  currentSummationDeliveredHPW: { id: 0x0106, type: ZCLDataTypes.uint48 },
  currentSummationDeliveredHCR: { id: 0x0108, type: ZCLDataTypes.uint48 },
  currentSummationDeliveredHPR: { id: 0x010A, type: ZCLDataTypes.uint48 },
  activeEnergyTotalInjected: { id: 0x0001, type: ZCLDataTypes.uint48 },
};

const COMMANDS = {};

class LixeeMeteringCluster extends MeteringCluster {

  static get ATTRIBUTES() {
    return {...super.ATTRIBUTES,...ATTRIBUTES};
  }

}

Cluster.addCluster(LixeeMeteringCluster);

module.exports = LixeeMeteringCluster;
