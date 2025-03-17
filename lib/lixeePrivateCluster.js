const { Cluster,ZCLDataTypes } = require('zigbee-clusters');

const ATTRIBUTES = {
  priceOption: { id: 0x0000, type: ZCLDataTypes.enum16({
      'BASE': 0,
      'HC..': 1,
      'EJP.': 2,
      'BBRx': 3,
    }),
  },
  tomorrowColor: { id: 0x0001, type: ZCLDataTypes.string },
  clockFullHourEmptyHour: { id: 0x0002, type: ZCLDataTypes.enum8({
      A: 0,
      C: 1,
      D: 2,
      E: 3,
      Y: 3,
    }),
  },
  mode: { id: 0x0300, type: ZCLDataTypes.enum8({
      historique_monophase: 0,
      standard_monophase: 1,
      historique_triphase: 2,
      standard_triphase: 3,
      historique_triphase_producteur: 5,
      standard_triphase_producteur: 7,
    }),
  },
  subscribePowerAlert: { id: 0x0005, type: ZCLDataTypes.uint16 },
};

const COMMANDS = {};

class LixeePrivateCluster extends Cluster {

  static get ID() {
    return 0xFF66;
  }

  static get NAME() {
    return 'lixeePrivate';
  }

  static get ATTRIBUTES() {
    return ATTRIBUTES;
  }

  static get COMMANDS() {
    return COMMANDS;
  }

}

Cluster.addCluster(LixeePrivateCluster);

module.exports = LixeePrivateCluster;
