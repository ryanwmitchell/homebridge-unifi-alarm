"use strict";
const axios = require("axios");
const https = require("https");

// UDM Pro uses a self-signed certificate
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

let Service, Characteristic, UUIDGen;

module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;
  homebridge.registerPlatform("homebridge-unifi-alarm", "UnifiAlarm", UnifiAlarmPlatform);
};

class UnifiAlarmPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];

    if (!api) return;

    api.on("didFinishLaunching", () => {
      const uuid = UUIDGen.generate("unifi-alarm-" + this.config.controller);
      const cached = this.accessories.find(a => a.UUID === uuid);
      const stale = this.accessories.filter(a => a.UUID !== uuid);
      if (stale.length > 0) {
        this.api.unregisterPlatformAccessories("homebridge-unifi-alarm", "UnifiAlarm", stale);
      }
      if (cached) {
        this.log("Restoring UniFi Alarm from cache.");
        new UnifiAlarmAccessory(this.log, this.config, this.api, Service, Characteristic, cached);
      } else {
        const accessory = new this.api.platformAccessory(this.config.name || "Security System", uuid);
        new UnifiAlarmAccessory(this.log, this.config, this.api, Service, Characteristic, accessory);
        this.api.registerPlatformAccessories("homebridge-unifi-alarm", "UnifiAlarm", [accessory]);
      }
    });
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }
}

class UnifiAlarmAccessory {
  constructor(log, config, api, Service, Characteristic, accessory) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.Service = Service;
    this.Characteristic = Characteristic;
    this.accessory = accessory;
    this.name = config.name || "Security System";
    this.controller = config.controller;
    this.username = config.username;
    this.password = config.password;

    this.cookies = null;
    this.csrfToken = null;
    this.armProfileId = config.armProfileId || null;  // auto-discovered from bootstrap
    this.isArmed = false;

    this.informationService = accessory.getService(Service.AccessoryInformation)
      || accessory.addService(Service.AccessoryInformation);
    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, "Ubiquiti")
      .setCharacteristic(Characteristic.Model, "UniFi Protect")
      .setCharacteristic(Characteristic.SerialNumber, "Unknown");

    this.securityService = accessory.getService(Service.SecuritySystem)
      || accessory.addService(Service.SecuritySystem, this.name);
    this.securityService.getCharacteristic(Characteristic.SecuritySystemCurrentState)
      .onGet(() => this.currentState());
    this.securityService.getCharacteristic(Characteristic.SecuritySystemTargetState)
      .onGet(() => this.targetState())
      .onSet(this.handleTargetStateSet.bind(this));

    if (api) {
      api.on("shutdown", () => {
        if (this.pollInterval) clearInterval(this.pollInterval);
      });
    }

    this.init();
  }

  get baseUrl() {
    return `https://${this.controller}`;
  }

  currentState() {
    const C = this.Characteristic.SecuritySystemCurrentState;
    return this.isArmed ? C.AWAY_ARM : C.DISARMED;
  }

  targetState() {
    const C = this.Characteristic.SecuritySystemTargetState;
    return this.isArmed ? C.AWAY_ARM : C.DISARM;
  }

  async login() {
    const response = await axios.post(
      `${this.baseUrl}/api/auth/login`,
      { username: this.username, password: this.password },
      { httpsAgent, timeout: 15000, headers: { "Content-Type": "application/json" } }
    );
    const setCookies = response.headers["set-cookie"];
    if (setCookies) {
      this.cookies = setCookies.map(c => c.split(";")[0]).join("; ");
    }
    this.csrfToken = response.headers["x-csrf-token"];
    this.log(`[${this.name}] Logged in to UniFi Protect.`);
  }

  async getBootstrap() {
    const response = await axios.get(`${this.baseUrl}/proxy/protect/api/bootstrap`, {
      httpsAgent,
      timeout: 15000,
      headers: { Cookie: this.cookies, "X-Csrf-Token": this.csrfToken },
    });
    return response.data;
  }

  async init() {
    try {
      await this.login();
      const bootstrap = await this.getBootstrap();
      const armMode = bootstrap.nvr?.armMode || {};

      // Auto-discover the profile ID from bootstrap
      if (!this.armProfileId && armMode.armProfileId) {
        this.armProfileId = armMode.armProfileId;
        this.log(`[${this.name}] Discovered arm profile ID: ${this.armProfileId}`);
      }

      this.isArmed = armMode.status === "armed";
      this.securityService.updateCharacteristic(
        this.Characteristic.SecuritySystemCurrentState,
        this.currentState()
      );
      this.securityService.updateCharacteristic(
        this.Characteristic.SecuritySystemTargetState,
        this.targetState()
      );
      this.log(`[${this.name}] State: ${this.isArmed ? "Armed" : "Disarmed"}`);
    } catch (err) {
      const detail = err.response
        ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
        : err.message;
      this.log.error(`[${this.name}] Initialization failed: ${detail}`);
      return;
    }

    this.pollInterval = setInterval(() => {
      this.poll().catch(err => {
        this.log.error(`[${this.name}] Poll error: ${err.message}`);
      });
    }, 5 * 1000);
  }

  async poll() {
    try {
      const bootstrap = await this.getBootstrap();
      const armMode = bootstrap.nvr?.armMode || {};
      const wasArmed = this.isArmed;
      this.isArmed = armMode.status === "armed";

      if (wasArmed !== this.isArmed) {
        this.log(`[${this.name}] State changed: ${this.isArmed ? "Armed" : "Disarmed"}`);
        this.securityService.updateCharacteristic(
          this.Characteristic.SecuritySystemCurrentState,
          this.currentState()
        );
        this.securityService.updateCharacteristic(
          this.Characteristic.SecuritySystemTargetState,
          this.targetState()
        );
      }
    } catch (err) {
      if (err.response && err.response.status === 401) {
        this.log.warn(`[${this.name}] Session expired, re-logging in...`);
        await this.login();
      } else {
        throw err;
      }
    }
  }

  async handleTargetStateSet(value) {
    const C = this.Characteristic.SecuritySystemTargetState;
    const arming = value !== C.DISARM;

    try {
      if (arming) {
        if (!this.armProfileId) {
          this.log.error(`[${this.name}] No arm profile ID available.`);
          return;
        }
        await axios.post(
          `${this.baseUrl}/proxy/protect/api/arm/enable`,
          { armProfileId: this.armProfileId },
          {
            httpsAgent,
            timeout: 15000,
            headers: {
              Cookie: this.cookies,
              "X-Csrf-Token": this.csrfToken,
              "Content-Type": "application/json",
            },
          }
        );
        this.log(`[${this.name}] Armed.`);
      } else {
        await axios.post(
          `${this.baseUrl}/proxy/protect/api/arm/disable`,
          {},
          {
            httpsAgent,
            timeout: 15000,
            headers: {
              Cookie: this.cookies,
              "X-Csrf-Token": this.csrfToken,
              "Content-Type": "application/json",
            },
          }
        );
        this.log(`[${this.name}] Disarmed.`);
      }

      this.isArmed = arming;
      this.securityService.updateCharacteristic(
        this.Characteristic.SecuritySystemCurrentState,
        this.currentState()
      );
    } catch (err) {
      if (err.response && err.response.status === 401) {
        this.log.warn(`[${this.name}] Session expired, re-logging in and retrying...`);
        await this.login();
        return this.handleTargetStateSet(value);
      }
      const detail = err.response
        ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
        : err.message;
      this.log.error(`[${this.name}] Command failed: ${detail}`);
    }
  }
}
