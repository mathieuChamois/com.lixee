const { Cluster,ZCLDataTypes } = require('zigbee-clusters');

const ATTRIBUTES = {
  priceOption: { id: 0x0000, type: ZCLDataTypes.string },
  tomorrowColor: { id: 0x0001, type: ZCLDataTypes.string },
  clockFullHourEmptyHour: { id: 0x0002, type: ZCLDataTypes.enum8({
      A: 0,
      C: 1,
      D: 2,
      E: 3,
      Y: 3,
    }),
  },
  // Registre de statuts du fichier (Enedis 6.2.3.14)
  // Bits 24 (LSB) et 25 (MSB) codent la couleur de demain:
  // 0 = Pas d'annonce, 1 = Bleu, 2 = Blanc, 3 = Rouge
  registerStatus: { id: 0x0217, type: ZCLDataTypes.uint32 },
  mode: { id: 0x0300, type: ZCLDataTypes.uint8 },
  subscribePowerAlert: { id: 0x0005, type: ZCLDataTypes.uint16 },
  apparentPowerInstInject: { id: 0x0207, type: ZCLDataTypes.uint16 },
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
