'use strict';

const { Driver } = require('homey');

class MyDriver extends Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('LiXee ZLinky_TIC driver has been initialized');
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
