'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');

const BATTERY_MAX_VOLTAGE = 30; // 3.0V in 100mV units
const BATTERY_MIN_VOLTAGE = 20; // 2.0V in 100mV units

// Native Homey capabilities per meter type
const METER_CAPABILITIES = {
  electricity: 'meter_power',  // kWh
  water: 'meter_water',        // m³
  gas: 'meter_gas',            // m³
};

class ZiPulsesDevice extends ZigBeeDevice {

  async onNodeInit({ zclNode }) {
    this.log('ZiPulses device initializing...');

    const ep = zclNode.endpoints[1] || zclNode.endpoints[0];
    const epId = zclNode.endpoints[1] ? 1 : 0;

    if (!ep) {
      this.error('No valid endpoint found!');
      return;
    }

    this.log(`Using endpoint ${epId}, clusters: ${Object.keys(ep.clusters || {})}`);

    // --- Read settings ---
    const settings = this.getSettings();
    this._multiplier = Number(settings.multiplier) || 1;
    this._divisor = Number(settings.divisor) || 1000;
    this._unit = settings.unit || 'kWh';
    this._meterType = settings.meter_type || 'electricity';
    this._lastRawValue = null;
    this.log(`[Settings] type=${this._meterType} mult=${this._multiplier} div=${this._divisor} unit=${this._unit}`);

    // =====================================================
    // 1. REGISTER LISTENERS (synchronous, never blocks)
    // =====================================================

    // --- Metering (0x0702) ---
    if (ep.clusters.metering) {
      try {
        ep.clusters.metering.on('attr.currentSummationDelivered', (value) => {
          this.log(`[Metering] raw pulses: ${value}`);
          this._lastRawValue = value;
          this._processPulses(value);
        });
        this.log('Metering listener registered');
      } catch (err) {
        this.error('Metering listener failed:', err.message);
      }
    } else {
      this.error('Metering cluster NOT found');
    }

    // --- Temperature (0x0402) ---
    if (ep.clusters.temperatureMeasurement) {
      try {
        ep.clusters.temperatureMeasurement.on('attr.measuredValue', (value) => {
          const temp = Math.round((value / 100) * 10) / 10;
          this.log(`[Temp] ${temp}°C`);
          this.setCapabilityValue('measure_temperature', temp).catch(this.error);
        });
        this.log('Temperature listener registered');
      } catch (err) {
        this.error('Temperature listener failed:', err.message);
      }
    } else {
      this.error('Temperature cluster NOT found');
    }

    // --- Battery (0x0001) ---
    if (ep.clusters.powerConfiguration) {
      this._hasBatteryPercentage = false;

      try {
        ep.clusters.powerConfiguration.on('attr.batteryPercentageRemaining', (value) => {
          this._hasBatteryPercentage = true;
          const pct = Math.min(100, Math.round(value / 2));
          this.log(`[Battery] ${pct}%`);
          this.setCapabilityValue('measure_battery', pct).catch(this.error);
          this.setCapabilityValue('alarm_battery', pct < 15).catch(this.error);
        });
      } catch (err) {
        this.log('batteryPercentageRemaining not available');
      }

      try {
        ep.clusters.powerConfiguration.on('attr.batteryVoltage', (value) => {
          if (this._hasBatteryPercentage) return;
          const pct = this._voltageToPercentage(value);
          this.log(`[Battery] ${value / 10}V -> ${pct}%`);
          this.setCapabilityValue('measure_battery', pct).catch(this.error);
          this.setCapabilityValue('alarm_battery', pct < 15).catch(this.error);
        });
      } catch (err) {
        this.error('Battery voltage listener failed:', err.message);
      }
    } else {
      this.error('PowerConfiguration cluster NOT found');
    }

    // =====================================================
    // 2. CONFIGURE REPORTING (fire-and-forget)
    // =====================================================

    if (ep.clusters.metering) {
      this.configureAttributeReporting([{
        endpointId: epId,
        cluster: CLUSTER.METERING,
        attributeName: 'currentSummationDelivered',
        minInterval: 60,
        maxInterval: 7200,
        minChange: 1,
      }]).catch(err => this.log('Metering reporting config failed (sleepy device):', err.message));
    }

    if (ep.clusters.temperatureMeasurement) {
      this.configureAttributeReporting([{
        endpointId: epId,
        cluster: CLUSTER.TEMPERATURE_MEASUREMENT,
        attributeName: 'measuredValue',
        minInterval: 60,
        maxInterval: 7200,
        minChange: 50,
      }]).catch(err => this.log('Temperature reporting config failed:', err.message));
    }

    if (ep.clusters.powerConfiguration) {
      this.configureAttributeReporting([{
        endpointId: epId,
        cluster: CLUSTER.POWER_CONFIGURATION,
        attributeName: 'batteryVoltage',
        minInterval: 3600,
        maxInterval: 43200,
        minChange: 1,
      }]).catch(err => this.log('Battery reporting config failed:', err.message));
    }

    // =====================================================
    // 3. ASYNC SETUP (after listeners are safe)
    // =====================================================

    await this._setupNativeCapability(this._meterType).catch(err =>
      this.error('Native capability setup failed:', err.message));

    await this._applyUnit(this._unit).catch(err =>
      this.error('Unit setup failed:', err.message));

    this.log('ZiPulses initialized');
  }

  // --- Pulse processing ---

  _processPulses(rawValue) {
    this.setCapabilityValue('meter_pulse_raw_capability', rawValue).catch(this.error);

    const index = Math.round((rawValue * this._multiplier / this._divisor) * 1000) / 1000;
    this.log(`[Index] ${rawValue} × ${this._multiplier} ÷ ${this._divisor} = ${index} ${this._unit}`);
    this.setCapabilityValue('meter_pulse_capability', index).catch(this.error);

    this._updateNativeCapability(index);
  }

  _updateNativeCapability(index) {
    const nativeCap = METER_CAPABILITIES[this._meterType];
    if (!nativeCap || !this.hasCapability(nativeCap)) return;

    let nativeValue;

    if (this._meterType === 'electricity') {
      // meter_power expects kWh
      nativeValue = this._unit === 'Wh'
        ? Math.round((index / 1000) * 1000) / 1000
        : index;
    } else {
      // meter_water / meter_gas expect m³
      switch (this._unit) {
        case 'L':   nativeValue = Math.round((index / 1000) * 1e6) / 1e6; break;
        case 'gal': nativeValue = Math.round((index * 0.00378541) * 1e6) / 1e6; break;
        case 'ft3': nativeValue = Math.round((index * 0.0283168) * 1e6) / 1e6; break;
        default:    nativeValue = index;
      }
    }

    this.log(`[Native] ${nativeCap} = ${nativeValue}`);
    this.setCapabilityValue(nativeCap, nativeValue).catch(this.error);
  }

  // --- Dynamic capabilities ---

  async _setupNativeCapability(meterType) {
    // Remove capabilities that don't match
    for (const [type, cap] of Object.entries(METER_CAPABILITIES)) {
      if (this.hasCapability(cap) && type !== meterType) {
        this.log(`Removing ${cap}`);
        await this.removeCapability(cap);
      }
    }
    // Add the right one
    const nativeCap = METER_CAPABILITIES[meterType];
    if (nativeCap && !this.hasCapability(nativeCap)) {
      this.log(`Adding ${nativeCap}`);
      await this.addCapability(nativeCap);
    }
  }

  async _applyUnit(unit) {
    const labels = {
      kWh: 'kWh', Wh: 'Wh', L: 'L',
      m3: 'm\u00B3', ft3: 'ft\u00B3', gal: 'gal', imp: 'imp',
    };
    const label = labels[unit] || unit;
    await this.setCapabilityOptions('meter_pulse_capability', {
      units: { en: label, fr: label },
    });
    this.log(`Unit: ${label}`);
  }

  // --- Helpers ---

  _voltageToPercentage(voltage) {
    if (voltage >= BATTERY_MAX_VOLTAGE) return 100;
    if (voltage <= BATTERY_MIN_VOLTAGE) return 0;
    return Math.round(((voltage - BATTERY_MIN_VOLTAGE) / (BATTERY_MAX_VOLTAGE - BATTERY_MIN_VOLTAGE)) * 100);
  }

  // --- Settings ---

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed:', changedKeys);

    if (changedKeys.includes('multiplier')) {
      this._multiplier = Number(newSettings.multiplier) || 1;
    }
    if (changedKeys.includes('divisor')) {
      this._divisor = Number(newSettings.divisor) || 1000;
    }
    if (changedKeys.includes('unit')) {
      this._unit = newSettings.unit;
      await this._applyUnit(this._unit);
    }
    if (changedKeys.includes('meter_type')) {
      this._meterType = newSettings.meter_type;
      await this._setupNativeCapability(this._meterType);
    }

    // Recalculate with last known value
    if (this._lastRawValue !== null) {
      this.log(`Recalculating from last value: ${this._lastRawValue}`);
      this._processPulses(this._lastRawValue);
    }
  }

  onDeleted() {
    this.log('ZiPulses deleted');
  }

}

module.exports = ZiPulsesDevice;
