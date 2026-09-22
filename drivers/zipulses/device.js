'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');

const ENDPOINT_ID = 1;
const STORE_RAW_PULSES = 'raw_pulses';

class ZiPulsesDevice extends ZigBeeDevice {
  async onNodeInit({ zclNode }) {
    const endpoint = zclNode.endpoints[ENDPOINT_ID];
    if (!endpoint) {
      throw new Error(`ZiPulses endpoint ${ENDPOINT_ID} was not found`);
    }

    this._metering = endpoint.clusters[CLUSTER.METERING.NAME];
    this._temperature = endpoint.clusters[CLUSTER.TEMPERATURE_MEASUREMENT.NAME];
    this._power = endpoint.clusters[CLUSTER.POWER_CONFIGURATION.NAME];

    if (!this._metering) {
      throw new Error('ZiPulses Simple Metering cluster (0x0702) was not found');
    }

    this._metering.on('attr.currentSummationDelivered', value => {
      this._handlePulseReport(value).catch(err => this.error(err));
    });

    if (this._temperature) {
      this._temperature.on('attr.measuredValue', value => {
        this._handleTemperatureReport(value).catch(err => this.error(err));
      });
    }

    if (this._power) {
      this._power.on('attr.batteryPercentageRemaining', value => {
        this._handleBatteryReport(value).catch(err => this.error(err));
      });
    }

    // Recalculate meter_water from a previously stored raw pulse count. This does not
    // initiate Zigbee communication, so it is safe for this sleepy end device.
    const storedPulses = this.getStoreValue(STORE_RAW_PULSES);
    if (storedPulses !== null && storedPulses !== undefined) {
      await this._updatePulseCapabilities(storedPulses);
    }

    this.log('ZiPulses driver ready; waiting for reports from the device');
  }

  async onEndDeviceAnnounce() {
    super.onEndDeviceAnnounce();

    // ZiPulses is sleepy. When it announces itself, it is temporarily awake, so this
    // is the best time to try one compact refresh. Failures are harmless because the
    // normal attribute reports remain the primary data path.
    await this._refreshWhileAwake();
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (!changedKeys.includes('pulses_per_m3')) return;

    const pulsesPerM3 = Number(newSettings.pulses_per_m3);
    if (!Number.isFinite(pulsesPerM3) || pulsesPerM3 <= 0) {
      throw new Error('Pulser pr. m³ skal være større end 0');
    }

    const storedPulses = this.getStoreValue(STORE_RAW_PULSES);
    if (storedPulses !== null && storedPulses !== undefined) {
      await this._updatePulseCapabilities(storedPulses, pulsesPerM3);
    }
  }

  async _handlePulseReport(rawValue) {
    const pulses = this._toFiniteNumber(rawValue);
    if (pulses === null || pulses < 0) {
      this.warn('Ignored invalid ZiPulses pulse value:', rawValue);
      return;
    }

    await this.setStoreValue(STORE_RAW_PULSES, pulses);
    await this._updatePulseCapabilities(pulses);
    this.log(`Pulse count: ${pulses}; water: ${this.getCapabilityValue('meter_water')} m³`);
  }

  async _updatePulseCapabilities(pulses, explicitPulsesPerM3) {
    const pulsesPerM3 = explicitPulsesPerM3 ?? this._getPulsesPerM3();
    const waterM3 = pulses / pulsesPerM3;

    const updates = [];

    if (this.getCapabilityValue('measure_pulses') !== pulses) {
      updates.push(this.setCapabilityValue('measure_pulses', pulses));
    }

    if (this.getCapabilityValue('meter_water') !== waterM3) {
      updates.push(this.setCapabilityValue('meter_water', waterM3));
    }

    await Promise.all(updates);
  }

  async _handleTemperatureReport(rawValue) {
    const raw = this._toFiniteNumber(rawValue);
    if (raw === null || raw === -32768) return; // Zigbee invalid-value marker

    const celsius = raw / 100;
    await this.setCapabilityValue('measure_temperature', celsius);
  }

  async _handleBatteryReport(rawValue) {
    const raw = this._toFiniteNumber(rawValue);
    if (raw === null || raw === 0xFF) return; // Zigbee unknown-value marker

    // Zigbee Power Configuration reports BatteryPercentageRemaining in 0.5% units.
    const percent = Math.max(0, Math.min(100, raw / 2));
    await this.setCapabilityValue('measure_battery', percent);
  }

  async _refreshWhileAwake() {
    try {
      const result = await this._metering.readAttributes(['currentSummationDelivered']);
      if (result && result.currentSummationDelivered !== undefined) {
        await this._handlePulseReport(result.currentSummationDelivered);
      }
    } catch (err) {
      this.debug('Metering refresh skipped/failed:', err.message);
    }

    if (this._temperature) {
      try {
        const result = await this._temperature.readAttributes(['measuredValue']);
        if (result && result.measuredValue !== undefined) {
          await this._handleTemperatureReport(result.measuredValue);
        }
      } catch (err) {
        this.debug('Temperature refresh skipped/failed:', err.message);
      }
    }

    if (this._power) {
      try {
        const result = await this._power.readAttributes(['batteryPercentageRemaining']);
        if (result && result.batteryPercentageRemaining !== undefined) {
          await this._handleBatteryReport(result.batteryPercentageRemaining);
        }
      } catch (err) {
        this.debug('Battery refresh skipped/failed:', err.message);
      }
    }
  }

  _getPulsesPerM3() {
    const configured = Number(this.getSetting('pulses_per_m3'));
    if (Number.isFinite(configured) && configured > 0) return configured;
    return 1000;
  }

  _toFiniteNumber(value) {
    if (typeof value === 'bigint') {
      const asNumber = Number(value);
      return Number.isSafeInteger(asNumber) ? asNumber : null;
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }
}

module.exports = ZiPulsesDevice;
