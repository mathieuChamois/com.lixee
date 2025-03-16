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
  currentSummationDeliveredHCHC: { id: 0x0100, type: ZCLDataTypes.uint48 },
  currentSummationDeliveredHCHP: { id: 0x0102, type: ZCLDataTypes.uint48 },
};

const COMMANDS = {};

class LixeeMeteringCluster extends MeteringCluster {

  static get ATTRIBUTES() {
    return {...super.ATTRIBUTES,...ATTRIBUTES};
  }

}

Cluster.addCluster(LixeeMeteringCluster);

module.exports = LixeeMeteringCluster;
