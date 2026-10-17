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
  // Bits 24-25: couleur du jour, bits 26-27: couleur de demain (0 = pas d'annonce, 1 = Bleu,
  // 2 = Blanc, 3 = Rouge). Bit 7: dépassement de la puissance de référence. Bits 10-13: index
  // fournisseur en cours - 1. Bits 14-15: index distributeur en cours - 1.
  registerStatus: { id: 0x0217, type: ZCLDataTypes.string },
  // Mode standard uniquement: libellé (LTARF) et numéro (NTARF, 1 à 10) de l'index fournisseur
  // en cours. NTARF désigne le registre EASFxx qui s'incrémente en ce moment.
  currentTariffLabel: { id: 0x0200, type: ZCLDataTypes.string },
  currentTariffIndex: { id: 0x0201, type: ZCLDataTypes.uint8 },
  // Mode standard: profil du prochain jour du calendrier fournisseur (PJOURF+1, 98 car. max)
  nextDayProfile: { id: 0x0227, type: ZCLDataTypes.string },
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
