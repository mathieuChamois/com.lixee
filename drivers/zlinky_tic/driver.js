'use strict';

const { Driver } = require('homey');

class MyDriver extends Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('LiXee ZLinky_TIC driver has been initialized');

    // Action Flow "reset_daily_cost": remet à zéro le coût du jour de l'appareil ciblé.
    // Enregistrée au niveau du driver (une seule fois), l'appareil vient de l'argument 'device'.
    try {
      this.homey.flow.getActionCard('reset_daily_cost')
        .registerRunListener(async args => {
          if (!args || !args.device) return false;
          await args.device.resetDailyCost();
          return true;
        });
    } catch (e) {
      this.error(`Failed to register action card reset_daily_cost: ${e && e.message ? e.message : e}`);
    }
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
    return [
       {
          name: 'LiXee',
          data: {
          id: 'ZLinky_TIC',
        },
       },
    ];
  }

}

module.exports = MyDriver;
