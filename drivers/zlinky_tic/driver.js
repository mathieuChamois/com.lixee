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

    // Condition Flow "current_kwh_price_below": compare le prix du kWh en vigueur (réglage de
    // l'index ou de la période en cours) au seuil saisi. Faux si le prix n'est pas connu.
    try {
      this.homey.flow.getConditionCard('current_kwh_price_below')
        .registerRunListener(async args => {
          if (!args || !args.device) return false;
          const price = args.device.getCapabilityValue('measure_current_kwh_price_capability');
          if (price === null || price === undefined || !Number.isFinite(Number(price))) return false;
          return Number(price) <= Number(args.price);
        });
    } catch (e) {
      this.error(`Failed to register condition card current_kwh_price_below: ${e && e.message ? e.message : e}`);
    }

    // Condition Flow "tariff_change_within": prochain changement de tarif connu et proche
    try {
      this.homey.flow.getConditionCard('tariff_change_within')
        .registerRunListener(async args => {
          if (!args || !args.device || typeof args.device.getMinutesToNextTariffChange !== 'function') return false;
          const minutes = args.device.getMinutesToNextTariffChange();
          return minutes !== null && minutes <= Number(args.minutes);
        });
    } catch (e) {
      this.error(`Failed to register condition card tariff_change_within: ${e && e.message ? e.message : e}`);
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
