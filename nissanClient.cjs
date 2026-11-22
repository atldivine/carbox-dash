/**
 * nissanClient.cjs — MyNISSAN (US) client for the carbox relay (relay.cjs).
 * No npm dependencies — uses Node's built-in fetch (Node 18+) and crypto/fs.
 * Reverse-engineered from the official MyNISSAN app's traffic; unofficial,
 * not affiliated with Nissan. Endpoints and auth flow can change without notice.
 *
 * Usage:
 *   const { NissanClient } = require('./nissanClient.cjs');
 *   const client = new NissanClient({ tokenPath: './nissan-tokens.json' });
 *   await client.authenticate(email, password);   // first run only
 *   const vehicles = await client.getVehicles();
 *   const status = await client.getVehicleStatus(vehicles[0].vin);
 *   await client.doorLock(vin);
 */

const fs = require('fs');
const crypto = require('crypto');

const TOKEN_ENDPOINT = 'https://services.nissanusa.com/token';
const GRAPHQL_ENDPOINT = 'https://api-ccs.na.nissancloud.com/iotmw-hades-ccs/graphql';
const ACCOUNT_NAMESPACE = 'NISNNAVCS';
const CLIENT_ID = 'v9no_nW7GqHYsfAKkki6_N5AFVIa';
const CLIENT_SECRET = 'Ynn56ncVx0yVffnDHIIMTWVYiuAa';
const APP_PACKAGE = 'ca.nissan.nissanconnectservices';
const APP_VERSION = '9.9.91';
const USER_AGENT = 'okhttp/5.2.1';
const BRAND = 'Nissan';
const COUNTRY = 'US';
const ACCEPT_LANGUAGE = 'en-US';

const QUERIES = {
  VEHICLES_STATIC_DATA:
    'query VehiclesStaticData { vehicles { __typename vin year model nickname } }',

  VEHICLE_DYNAMIC_DATA:
    'query VehicleDynamicData($vin: String!, $unit: DistanceUnit) { vehicle(vin: $vin) { ' +
    '__typename ... on BaseAVKVehicle { doorsStatus { lastUpdatedAt ' +
    'doorFrontLeft { ajar window lock } doorFrontRight { ajar window lock } ' +
    'doorRearLeft { ajar window lock } doorRearRight { ajar window lock } ' +
    'engineHood { ajar } hatch { ajar } sunroof { ajar } trunk { lock } overallLock { lock } } ' +
    'fuelAutonomy(unit: $unit) { lastUpdatedAt value unit } ' +
    'mileage(unit: $unit) { total recordedTime unit } ' +
    'tirePressure { lastUpdatedAt flPressure frPressure rlPressure rrPressure flStatus frStatus rlStatus rrStatus } ' +
    'mils { active detailedMessage type } } } }',

  DOOR_LOCK: 'mutation DoorLock($vin: String!) { doorLock(vin: $vin) { __typename serviceRequestId } }',
  DOOR_UNLOCK: 'mutation DoorUnlock($vin: String!) { doorUnlock(vin: $vin) { __typename serviceRequestId } }',
  FLASH_LIGHTS: 'mutation FlashLights($vin: String!) { flashLights(vin: $vin) { __typename serviceRequestId } }',

  CHECK_DOOR_REQUEST:
    'mutation CheckDoorServiceRequest($vin: String!, $serviceRequestId: String!) { ' +
    'checkDoorServiceRequest(vin: $vin, serviceRequestId: $serviceRequestId) { __typename status } }',

  CHECK_HORN_LIGHT_REQUEST:
    'mutation CheckHornLightServiceRequest($vin: String!, $serviceRequestId: String!) { ' +
    'checkHornLightServiceRequest(vin: $vin, serviceRequestId: $serviceRequestId) { __typename status } }',
};

class NissanClient {
  /**
   * @param {object} opts
   * @param {string} [opts.tokenPath] - where to persist tokens between runs (default ./nissan-tokens.json)
   */
  constructor(opts = {}) {
    this.tokenPath = opts.tokenPath || './nissan-tokens.json';
    this.deviceId = crypto.randomUUID();
    this.tokens = this._loadTokens();
  }

  _loadTokens() {
    try {
      return JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
    } catch {
      return null;
    }
  }

  _saveTokens(tokens) {
    this.tokens = tokens;
    try {
      fs.writeFileSync(this.tokenPath, JSON.stringify(tokens, null, 2));
    } catch (err) {
      console.error('nissanClient: failed to persist tokens:', err.message);
    }
  }

  async _postJson(url, { data, jsonBody, headers = {} } = {}) {
    const h = { 'User-Agent': USER_AGENT, ...headers };
    let body;
    if (jsonBody !== undefined) {
      h['Content-Type'] = 'application/json';
      body = JSON.stringify(jsonBody);
    } else {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(data).toString();
    }
    const resp = await fetch(url, { method: 'POST', headers: h, body });
    const status = resp.status;
    let payload = {};
    try {
      payload = await resp.json();
    } catch {
      /* non-JSON response */
    }
    return { status, payload };
  }

  async authenticate(email, password) {
    const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const { status, payload } = await this._postJson(TOKEN_ENDPOINT, {
      data: {
        username: `${ACCOUNT_NAMESPACE}/${email.trim().toLowerCase()}`,
        password,
        scope: `openid device_${this.deviceId}+internal_login`,
        grant_type: 'password',
      },
      headers: { Authorization: `Basic ${creds}` },
    });
    if (status < 200 || status >= 300) {
      throw new Error(`MyNISSAN auth failed (HTTP ${status}): ${JSON.stringify(payload)}`);
    }
    this._saveTokens({
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      id_token: payload.id_token,
    });
    return this.tokens;
  }

  async refreshTokens() {
    if (!this.tokens?.refresh_token) throw new Error('No refresh token available — call authenticate() first.');
    const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const { status, payload } = await this._postJson(TOKEN_ENDPOINT, {
      data: { refresh_token: this.tokens.refresh_token, grant_type: 'refresh_token' },
      headers: { Authorization: `Basic ${creds}` },
    });
    if (status < 200 || status >= 300) {
      throw new Error(`MyNISSAN token refresh failed (HTTP ${status}): ${JSON.stringify(payload)}`);
    }
    this._saveTokens({
      access_token: payload.access_token,
      refresh_token: payload.refresh_token || this.tokens.refresh_token,
      id_token: payload.id_token || this.tokens.id_token,
    });
    return this.tokens;
  }

  _isJwtExpired(token, leewaySeconds = 30) {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      return payload.exp && payload.exp <= Date.now() / 1000 + leewaySeconds;
    } catch {
      return false;
    }
  }

  async _ensureFreshTokens() {
    if (!this.tokens) throw new Error('Not authenticated — call authenticate() first.');
    if (this._isJwtExpired(this.tokens.access_token)) {
      await this.refreshTokens();
    }
  }

  async graphql(operationName, document, variables = {}) {
    await this._ensureFreshTokens();
    const headers = {
      Authorization: `Bearer ${this.tokens.access_token}`,
      Brand: BRAND,
      Country: COUNTRY,
      'Accept-Language': ACCEPT_LANGUAGE,
      'x-correlation-id': crypto.randomUUID(),
      'apollographql-client-name': `${APP_PACKAGE}:android`,
      'apollographql-client-version': APP_VERSION,
    };
    if (this.tokens.id_token) headers['id-token'] = this.tokens.id_token;

    let { status, payload } = await this._postJson(GRAPHQL_ENDPOINT, {
      jsonBody: { operationName, query: document, variables },
      headers,
    });

    if (status === 401) {
      await this.refreshTokens();
      headers.Authorization = `Bearer ${this.tokens.access_token}`;
      ({ status, payload } = await this._postJson(GRAPHQL_ENDPOINT, {
        jsonBody: { operationName, query: document, variables },
        headers,
      }));
    }

    if (status < 200 || status >= 300) {
      throw new Error(`Nissan GraphQL error (HTTP ${status}): ${JSON.stringify(payload)}`);
    }
    return payload.data;
  }

  async getVehicles() {
    const data = await this.graphql('VehiclesStaticData', QUERIES.VEHICLES_STATIC_DATA, {});
    return data.vehicles;
  }

  async getVehicleStatus(vin, unit = 'MILE') {
    const data = await this.graphql('VehicleDynamicData', QUERIES.VEHICLE_DYNAMIC_DATA, { vin, unit });
    return data.vehicle;
  }

  async _sendCommand(opName, doc, field, vin) {
    const data = await this.graphql(opName, doc, { vin });
    return data[field].serviceRequestId;
  }

  async _pollServiceRequest(vin, serviceRequestId, opName, doc, field, { intervalMs = 2000, maxAttempts = 15 } = {}) {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const data = await this.graphql(opName, doc, { vin, serviceRequestId });
      const status = data[field]?.status;
      if (status && !['IN_PROGRESS', 'PENDING', 'QUEUED'].includes(status)) {
        return status;
      }
    }
    return null; // caller should treat this as "unknown — check status separately"
  }

  async doorLock(vin) {
    const id = await this._sendCommand('DoorLock', QUERIES.DOOR_LOCK, 'doorLock', vin);
    return this._pollServiceRequest(vin, id, 'CheckDoorServiceRequest', QUERIES.CHECK_DOOR_REQUEST, 'checkDoorServiceRequest');
  }

  async doorUnlock(vin) {
    const id = await this._sendCommand('DoorUnlock', QUERIES.DOOR_UNLOCK, 'doorUnlock', vin);
    return this._pollServiceRequest(vin, id, 'CheckDoorServiceRequest', QUERIES.CHECK_DOOR_REQUEST, 'checkDoorServiceRequest');
  }

  async flashLights(vin) {
    const id = await this._sendCommand('FlashLights', QUERIES.FLASH_LIGHTS, 'flashLights', vin);
    return this._pollServiceRequest(vin, id, 'CheckHornLightServiceRequest', QUERIES.CHECK_HORN_LIGHT_REQUEST, 'checkHornLightServiceRequest');
  }
}

module.exports = { NissanClient };
