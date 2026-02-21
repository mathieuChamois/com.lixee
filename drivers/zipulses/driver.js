'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class ZiPulsesDriver extends ZigBeeDriver {

  async onInit() {
    super.onInit();
    this.log('ZiPulses driver initialized');
  }

}

module.exports = ZiPulsesDriver;
