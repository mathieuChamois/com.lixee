const { Cluster,ZCLDataTypes,ElectricalMeasurementCluster } = require('zigbee-clusters');

const ATTRIBUTES = {
  apparentPower: { id: 1295, type: ZCLDataTypes.uint16 },
  maximalIntensity: { id: 0x050A, type: ZCLDataTypes.uint16 },
  phase2ApparentPower: { id: 0x090F, type: ZCLDataTypes.uint16 },
  phase3ApparentPower: { id: 0x0A0F, type: ZCLDataTypes.uint16 },
};

const COMMANDS = {};

class LixeeElectricalMeasurementCluster extends ElectricalMeasurementCluster {

  static get ATTRIBUTES() {
    return {...super.ATTRIBUTES,...ATTRIBUTES};
  }

}

Cluster.addCluster(LixeeElectricalMeasurementCluster);

module.exports = LixeeElectricalMeasurementCluster;
