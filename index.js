'use strict';
const packageJSON = require('./package.json');

let request = require('requestretry');
let Service, Characteristic, HomebridgeAPI;

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    HomebridgeAPI = homebridge;
    homebridge.registerAccessory(
        'homebridge-blinds',
        'BlindsHTTP',
        BlindsHTTPAccessory
    );
};

function BlindsHTTPAccessory(log, config) {
    // global vars
    this.log = log;
    if (!config) {
        this.log.info('No configuration found for homebridge-blinds');
        return;
    }

    // configuration vars
    this.name = config.name;
    this.upURL = config.up_url || false;
    this.downURL = config.down_url || false;
    this.positionURL = config.position_url || false;
    this.stopURL = config.stop_url || false;
    this.showStopButton = config.show_stop_button || false;
    this.stopAtBoundaries = config.trigger_stop_at_boundaries || false;
    this.useSameUrlForStop = config.use_same_url_for_stop || false;
    this.httpMethod = config.http_method || { method: 'POST' };
    this.successCodes = config.success_codes || [200];
    this.maxHttpAttempts = parseInt(config.max_http_attempts, 10) || 5;
    this.retryDelay = parseInt(config.retry_delay, 10) || 2000;
    this.motionTime = parseInt(config.motion_time, 10) || 10000;
    this.responseLag = parseInt(config.response_lag, 10) || 0;
    this.verbose = config.verbose || false;

    this.cacheDirectory = HomebridgeAPI.user.persistPath();
    this.storage = require('node-persist');
    this.storage.initSync({
        dir: this.cacheDirectory,
        forgiveParseErrors: true
    });

    // state vars
    this.stopTimeout = null;
    this.lagTimeout = null;
    this.stepInterval = null;
    this.lastPosition = this.storage.getItemSync(this.name) || 0; // last known position of the blinds, down by default
    this.currentTargetPosition = this.lastPosition;

    // register the service and provide the functions
    this.service = new Service.WindowCovering(this.name);

    // the current position (0-100)
    // https://github.com/KhaosT/HAP-NodeJS/blob/master/src/lib/gen/HomeKit.ts#L712
    this.service
        .getCharacteristic(Characteristic.CurrentPosition)
        .on('get', this.getCurrentPosition.bind(this));

    // the target position (0-100)
    // https://github.com/KhaosT/HAP-NodeJS/blob/master/src/lib/gen/HomeKit.ts#L2781
    this.service
        .getCharacteristic(Characteristic.TargetPosition)
        .on('get', this.getTargetPosition.bind(this))
        .on('set', this.setTargetPosition.bind(this));

    this.service
        .getCharacteristic(Characteristic.PositionState)
        .updateValue(Characteristic.PositionState.STOPPED);
}

BlindsHTTPAccessory.prototype.getCurrentPosition = function(callback) {
    if (this.verbose) {
        this.log(`Requested CurrentPosition: ${this.lastPosition}%`);
    }

    if (this.positionURL) {
        this.setCurrentPositionByUrl(function(err) {
            if (err) {
                this.log.error(`setCurrentPositionByUrl failed; invalid response (should be 0-100): ${err}`);
            }
            return callback(null, this.lastPosition);
        });
    } else {
        return callback(null, this.lastPosition);
    }
};

BlindsHTTPAccessory.prototype.setCurrentPositionByUrl = function(callback) {
    this.httpRequest(this.positionURL, { method: 'GET' }, function(body, err) {
        if (err || !body) {
            return callback('(missing or error)');
        }

        const pos = parseInt(body, 10);
        if (pos < 0 || pos > 100) { // invalid
            return callback(pos);
        }

        this.lastPosition = pos;
        return callback(null);
    }.bind(this));
};

BlindsHTTPAccessory.prototype.getTargetPosition = function(callback) {
    if (this.verbose) {
        this.log(`Requested TargetPosition: ${this.currentTargetPosition}%`);
    }
    return callback(null, this.currentTargetPosition);
};

BlindsHTTPAccessory.prototype.setTargetPosition = function(pos, callback) {
    if (this.lagTimeout != null) clearTimeout(this.lagTimeout);
    if (this.stopTimeout != null) clearTimeout(this.stopTimeout);
    if (this.stepInterval != null) clearInterval(this.stepInterval);

    this.manualStop = false;
    this.currentTargetPosition = pos;
    if (this.currentTargetPosition == this.lastPosition) {
        if (this.currentTargetPosition % 100 > 0) {
            this.log(`Already there: ${this.currentTargetPosition}%`);
            return callback(null);
        } else {
            this.log(
                `Already there: ${this.currentTargetPosition}%, re-sending request`
            );
        }
    }

    const moveUp =
        this.currentTargetPosition > this.lastPosition ||
        this.currentTargetPosition == 100;
    const moveMessage = `Move ${moveUp ? 'up' : 'down'}`;
    this.log(`Requested ${moveMessage} (to ${this.currentTargetPosition}%)`);

    let self = this;

    const startTimestamp = Date.now();
    const moveUrl = moveUp ? this.upURL : this.downURL;
    if (this.useSameUrlForStop) {
        this.stopURL = moveUrl;
    }

    this.httpRequest(moveUrl, this.httpMethod, function(body, err) {
        if (err) {
            return;
        }

        this.storage.setItemSync(this.name, this.currentTargetPosition);
        const motionTimeStep = this.motionTime / 100;
        const waitDelay = Math.abs(this.currentTargetPosition - this.lastPosition) * motionTimeStep;

        this.log(
            `Move request sent (${Date.now() - startTimestamp} ms), waiting ${Math.round(waitDelay / 100) / 10}s (+ ${Math.round(this.responseLag / 100) / 10}s response lag)...`
        );

        // Send stop command before target position is reached to account for response_lag
        if (this.stopAtBoundaries || this.currentTargetPosition % 100 > 0) {
            if (this.verbose) {
                self.log('Stop command will be requested');
            }
            this.stopTimeout = setTimeout(function() {
                self.sendStopRequest(null, true);
            }, Math.max(waitDelay, 0));
        }

        // Delay for response lag, then track movement of blinds
        this.lagTimeout = setTimeout(function() {
            if (self.verbose) {
                self.log('Timeout finished');
            }
            self.stepInterval = setInterval(function() {
                if (self.manualStop) {
                    self.currentTargetPosition = self.lastPosition;
                }

                // TODO: should periodic polling of self.getCurrentPosition be performed if self.positionURL is set?
                if (moveUp && self.lastPosition < self.currentTargetPosition) {
                    self.lastPosition += 1;
                } else if (!moveUp && self.lastPosition > self.currentTargetPosition) {
                    self.lastPosition += -1;
                } else {
                    // Reached target
                    self.log(
                        `End ${moveMessage} (to ${self.currentTargetPosition}%)`
                    );
                    
                    self.service
                        .getCharacteristic(Characteristic.CurrentPosition)
                        .updateValue(self.lastPosition);
                    
                    self.currentTargetPosition = self.lastPosition; // In case of overshoot
                    self.service
                        .getCharacteristic(Characteristic.PositionState)
                        .updateValue(Characteristic.PositionState.STOPPED);
                    clearInterval(self.stepInterval);
                }
            }, motionTimeStep);
        }, Math.max(this.responseLag, 0));
    }.bind(this));

    return callback(null);
};

BlindsHTTPAccessory.prototype.sendStopRequest = function(targetService, on, callback) {
    if (on) {
        if (targetService) {
            this.log('Requesting manual stop');
            if (this.stopTimeout != null) clearTimeout(this.stopTimeout);
        } else {
            this.log('Requesting stop');
        }

        this.httpRequest(this.stopURL, this.httpMethod, function(body, err) {
            if (err) {
                this.log.warn('Stop request failed');
            } else {
                if (targetService) {
                    this.manualStop = true;
                }
                this.log('Stop request sent');
            }
        }.bind(this));
        
        if (targetService) {
            setTimeout(function() {
                targetService.setCharacteristic(Characteristic.On, false);
            }.bind(this), 1000);
        }
    }

    if (targetService) {
        return callback(null);
    }
};

BlindsHTTPAccessory.prototype.httpRequest = function(url, methods, callback) {
    if (!url) {
    }

    // backward compatibility
    if (methods && typeof methods.valueOf() === 'string') {
        methods = { method: methods };
        return callback(null, null);
    }

    const urlRetries = {
        url: url,
        maxAttempts: (this.maxHttpAttempts > 1) ? this.maxHttpAttempts : 1,
        retryDelay: (this.retryDelay > 100) ? this.retryDelay : 100,
        retryStrategy: request.RetryStrategies.HTTPOrNetworkError
    };
    const options = Object.assign(urlRetries, methods);

    request(options, function(err, response, body) {
        if (!err && response && this.successCodes.includes(response.statusCode)) {
            if (response.attempts > 1 || this.verbose) {
                this.log.info(
                    `Request succeeded after ${response.attempts} / ${this.maxHttpAttempts} attempt${this.maxHttpAttempts > 1 ? 's' : ''}`
                );
            }

            return callback(body, null);
        } else {
            this.log.error(
                `Error sending request (HTTP status code ${response ? response.statusCode : 'not defined'}): ${err}`
            );
            this.log.error(`${response ? response.attempts : this.maxHttpAttempts} / ${this.maxHttpAttempts} attempt${this.maxHttpAttempts > 1 ? 's' : ''} failed`);
            this.log.error(`Body: ${body}`);

            return callback(body, err);
        }
    }.bind(this));
};

BlindsHTTPAccessory.prototype.getServices = function() {
    this.services = [];

    const informationService = new Service.AccessoryInformation();
    informationService
        .setCharacteristic(Characteristic.Manufacturer, 'homebridge-blinds')
        .setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.Model, this.name)
        .setCharacteristic(Characteristic.SerialNumber, 'BlindsHTTPAccessory')
        .setCharacteristic(Characteristic.FirmwareRevision, packageJSON.version);

    this.services.push(informationService);
    this.services.push(this.service);

    if (this.showStopButton && (this.stopURL || this.useSameUrlForStop)) {
        const switchService = new Service.Switch(this.name + ' Stop');
        switchService
            .getCharacteristic(Characteristic.On)
            .on('set', this.sendStopRequest.bind(this, switchService));

        this.services.push(switchService);
    }

    return this.services;
};
