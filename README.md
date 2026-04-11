# homebridge-unifi-alarm

[![npm version](https://badge.fury.io/js/homebridge-unifi-alarm.svg)](https://www.npmjs.com/package/homebridge-unifi-alarm)

A Homebridge plugin that exposes the UniFi Protect alarm system to Apple HomeKit, allowing you to arm and disarm your alarm from the Home app or via Siri.

## Features

- Arm and disarm your UniFi Protect alarm from HomeKit
- Reflects state changes made in the UniFi Protect app within seconds
- Auto-discovers your alarm profile on startup
- Handles session expiry and re-authentication automatically

## Installation

Install via the Homebridge UI by searching for `homebridge-unifi-alarm`, or manually:

```bash
npm install -g homebridge-unifi-alarm
```

## Configuration

Add the following to the `platforms` array in your Homebridge `config.json`:

```json
{
  "platform": "UnifiAlarm",
  "name": "Security System",
  "controller": "192.168.1.1",
  "username": "your-unifi-username",
  "password": "your-unifi-password"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `controller` | Yes | IP address or hostname of your UniFi Protect controller |
| `username` | Yes | Local UniFi OS account (a dedicated read/write account is recommended) |
| `password` | Yes | Password for the above account |
| `name` | No | Name shown in HomeKit (default: `Security System`) |

## Notes

- The plugin uses the UniFi Protect local API and requires a local admin account. Cloud accounts with MFA are not supported.
- Self-signed certificates on the UDM Pro are handled automatically.
