const events = require('events');
const varDiff = require('./varDiff.js');
const daemon = require('./daemon.js');
const stratum = require('./stratum.js');
const { JobManager, ErrorCodes } = require('./jobManager.js');
const constants = require('./constants.js');
const { AMQPSyncer } = require('./sync.js');

var pool = module.exports = function pool(config, logger) {
    this.config = config;
    var _this = this;
    var jobExpiryPeriod = config.jobExpiryPeriod * 1000; // ms

    var syncer = new AMQPSyncer(config.rabbitmq.url)

    this.start = function () {
        SetupVarDiff();
        SetupDaemonInterface(function () {
            SetupJobManager();
            OnBlockchainSynced(function () {
                StartStratumServer();
            });
        });
    };

    function OnBlockchainSynced(syncedCallback) {
        var checkSynced = function (displayNotSynced) {
            _this.daemon.isSynced(function (synced) {
                if (synced) {
                    syncedCallback();
                }
                else {
                    if (displayNotSynced) displayNotSynced();
                    setTimeout(checkSynced, 5000);
                }
            });
        };
        checkSynced(function () {
            //Only let the first fork show synced status or the log wil look flooded with it
            if (!process.env.forkId || process.env.forkId === '0')
                logger.info('Daemon is still syncing with network (download blockchain) - server will be started once synced');
        });
    }

    function SetupVarDiff() {
        _this.varDiff = new varDiff(config.pool.varDiff);
        _this.varDiff.on('newDifficulty', function (client, newDiff) {

            /* We request to set the newDiff @ the next difficulty retarget
             (which should happen when a new job comes in - AKA BLOCK) */
            client.enqueueNextDifficulty(newDiff);
        });
    }

    function SetupJobManager() {
        _this.jobManager = new JobManager(jobExpiryPeriod);

        _this.jobManager
            .on('newJobs', function (templates) {
                //Check if stratumServer has been initialized yet
                if (_this.stratumServer) {
                    _this.stratumServer.broadcastMiningJobs(templates);
                }
            })
            .on('share', function (shareData) {
                if (shareData.error) {
                    let workerName = "unnamed";
                    let address = ""
                    try {
                        let firstDot = shareData.worker.indexOf('.');
                        if (firstDot !== -1) {
                            address = shareData.worker.substring(0, firstDot);
                            workerName = shareData.worker.substring(firstDot + 1, shareData.worker.length);
                        }
                    } catch (e) {
                        console.log(e);
                    }

                    let errorType = "invalid"
                    switch (shareData.errorType) {
                        case ErrorCodes.InvalidJobChainIndex:
                        case ErrorCodes.InvalidWorker:
                        case ErrorCodes.InvalidNonce:
                        case ErrorCodes.InvalidNonce:
                        case ErrorCodes.LowDifficulty:
                        case ErrorCodes.InvalidBlockChainIndex:
                            break
                        case ErrorCodes.JobNotFound:
                            errorType = "stale"
                            break
                        case ErrorCodes.DuplicatedShare:
                            errorType = "duplicate"
                            break
                    }

                    syncer.publish(config.rabbitmq.exchange, `alphpool.shares.${config.poolId}`, {
                        event: "invalid_share",
                        time: new Date().toISOString(),
                        data: {
                            difficulty: shareData.difficulty,
                            address: address,
                            worker: workerName,
                            worker_ip: shareData.ip,
                            time: Math.round(new Date().getTime() / 1000),
                            pool_id: config.poolId,
                            region: config.region,
                            error: shareData.error,
                            error_type: errorType,
                        }
                    })
                    // we only emit valid shares
                    logger.error('Invalid share from ' + shareData.worker +
                        ', error: ' + shareData.error +
                        ', jobId: ' + shareData.job +
                        ', ip: ' + shareData.ip
                    );
                    return;
                }

                var job = shareData.job;
                var chainIndex = chainIndexStr(job.fromGroup, job.toGroup);
                logger.info(
                    'Received share from ' + shareData.worker +
                    ', jobId: ' + job.jobId +
                    ', chainIndex: ' + chainIndex +
                    ', pool difficulty: ' + shareData.difficulty +
                    ', share difficulty: ' + shareData.shareDiff +
                    ', ip: ' + shareData.ip
                );

                let workerName = "unnamed";
                try {
                    let firstDot = shareData.worker.indexOf('.');
                    if (firstDot !== -1) {
                        workerName = shareData.worker.substring(firstDot, shareData.worker.length);
                    }
                } catch (e) {
                    console.log(e);
                }

                syncer.publish(config.rabbitmq.exchange, `alphpool.shares.${config.poolId}`, {
                    event: "share",
                    time: new Date().toISOString(),
                    region: config.region,
                    pool_id: config.poolId,
                    data: {
                        address: shareData.workerAddress,
                        worker: workerName,
                        worker_ip: shareData.ip,
                        difficulty: shareData.difficulty,
                        network_difficulty: 0,
                        block_hash: shareData.blockHash,
                        nonce: "",
                        block_found: shareData.foundBlock,
                        pool_id: config.poolId,
                        region: config.region,
                        time: Math.round(new Date().getTime() / 1000),
                        extra: {
                            from_group: `${job.fromGroup}`,
                            to_group: `${job.toGroup}`,
                        },
                    },

                })

                if (shareData.foundBlock) {
                    logger.info('Found block for chainIndex: ' + chainIndex +
                        ', hash: ' + shareData.blockHash +
                        ', miner: ' + shareData.worker
                    );

                    var block = Buffer.concat([shareData.nonce, job.headerBlob, job.txsBlob]);
                    _this.daemon.submit(block, function (error) {
                        if (error) {
                            logger.error('Submit block error: ' + error);
                        }
                    });
                }
            })
    }

    function chainIndexStr(fromGroup, toGroup) {
        return fromGroup + " -> " + toGroup;
    }

    function SetupDaemonInterface(finishedCallback) {

        if (!config.daemon) {
            logger.error('No daemons have been configured - pool cannot start');
            return;
        }

        // TODO: support backup daemons
        _this.daemon = new daemon.interface(config.daemon, logger);

        _this.daemon.once('online', function () {
            finishedCallback();
            _this.daemon.connectToMiningServer(messageHandler);

        }).on('cliqueNotReady', function () {
            logger.info('Clique is not ready.');

        }).on('error', function (message) {
            logger.error(message);

        });

        _this.daemon.init();
    }

    function messageHandler(message) {
        switch (message.type) {
            case constants.JobsMessageType:
                _this.jobManager.processJobs(message.payload);
                break;
            case constants.SubmitResultMessageType:
                var result = message.payload;
                handleSubmitResult(result.fromGroup, result.toGroup, result.succeed);
                break;
            default:
                logger.error('Invalid message type: ' + message.type);
        }
    }

    function handleSubmitResult(fromGroup, toGroup, succeed) {
        var chainIndex = chainIndexStr(fromGroup, toGroup);
        if (succeed) {
            logger.info('Submit block succeed for chainIndex: ' + chainIndex);
        }
        else {
            logger.error('Submit block failed for chainIndex: ' + chainIndex);
        }
    }

    function StartStratumServer() {
        _this.stratumServer = new stratum.Server(config);
        logger.info('Stratum server started on port ' + config.pool.port);

        setInterval(() => {
            logger.info(`Clients:  ${Object.keys(_this.stratumServer.stratumClients).length}`)
            logger.info(`Banned clients: ${Object.keys(_this.stratumServer.bannedIPs).length}`)
        }, 10000)

        _this.stratumServer
            .on('started', function () {
                _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJobs);
            })
            .on('tooManyConnectionsFromSameIP', function (ipAddress) {
                logger.warn('Too many connections from IP: ' + ipAddress);
            })
            .on('client.connected', function (client) {
                logger.info('New miner connected: ' + client.getLabel());

                syncer.publish(config.rabbitmq.exchange, `alphpool.updates.${config.poolId}`, {
                    event: 'miner_connected',
                    time: new Date().toISOString(),
                    data: {
                        ip: client.remoteAddress,
                        port: client.remotePort,
                        pool_id: config.poolId,
                        region: config.region,
                    }
                })
                _this.varDiff.manageClient(client);

                client
                    .on('submit', function (params, resultCallback) {
                        var result = _this.jobManager.processShare(
                            params,
                            client.previousDifficulty,
                            client.difficulty,
                            client.remoteAddress,
                            client.socket.localPort
                        );
                        resultCallback(result.error, result.result ? true : null);

                    })
                    .on('malformedMessage', function (message) {
                        logger.warn('Malformed message from ' + client.getLabel() + ': ' + message);
                        syncer.publish(config.rabbitmq.exchange, `alphpool.updates.${config.poolId}`, {
                            event: 'malformed_message',
                            time: new Date().toISOString(),
                            data: {
                                pool_id: config.poolId,
                                region: config.region,
                                time: new Date().toISOString(),
                                ip: client.remoteAddress,
                                port: client.remotePort
                            }
                        })
                    })
                    .on('socketError', function (err) {
                        logger.warn('Socket error from ' + client.getLabel() + ': ' + JSON.stringify(err));
                        syncer.publish(config.rabbitmq.exchange, `alphpool.updates.${config.poolId}`, {
                            event: 'socket_error',
                            time: new Date().toISOString(),
                            data: {
                                pool_id: config.poolId,
                                region: config.region,
                                time: new Date().toISOString(),
                                ip: client.remoteAddress,
                                port: client.remotePort
                            }
                        })

                    })
                    .on('socketTimeout', function (reason) {
                        logger.warn('Connected timed out for ' + client.getLabel() + ': ' + reason)
                        syncer.publish(config.rabbitmq.exchange, `alphpool.updates.${config.poolId}`, {
                            event: 'socket_timeout',
                            time: new Date().toISOString(),
                            data: {
                                pool_id: config.poolId,
                                region: config.region,
                                time: new Date().toISOString(),
                                ip: client.remoteAddress,
                                port: client.remotePort
                            },
                        })
                    })
                    .on('socketDisconnect', function () {
                        logger.warn('Socket disconnected from ' + client.getLabel());
                        syncer.publish(config.rabbitmq.exchange, `alphpool.updates.${config.poolId}`, {
                            event: 'socket_disconnected',
                            time: new Date().toISOString(),
                            data: {
                                pool_id: config.poolId,
                                region: config.region,
                                time: new Date().toISOString(),
                                ip: client.remoteAddress,
                                port: client.remotePort
                            },
                        })
                    })
                    .on('difficultyChanged', function (difficulty) {
                        logger.info('Set new difficulty for ' + client.getLabel() + ' to ' + difficulty);

                    })
                    .on('kickedBannedIP', function (remainingBanTime) {
                        logger.info('Rejected incoming connection from ' + client.remoteAddress + ' banned for ' + remainingBanTime + ' more seconds');
                        syncer.publish(config.rabbitmq.exchange, `alphpool.updates.${config.poolId}`, {
                            event: 'kicked_banned_ip',
                            time: new Date().toISOString(),
                            data: {
                                pool_id: config.poolId,
                                region: config.region,
                                time: new Date().toISOString(),
                                ip: client.remoteAddress,
                                port: client.remotePort
                            },
                        })
                    })
                    .on('forgaveBannedIP', function () {
                        logger.info('Forgave banned IP ' + client.remoteAddress);
                        syncer.publish(config.rabbitmq.exchange, `alphpool.updates.${config.poolId}`, {
                            event: 'unbanned',
                            time: new Date().toISOString(),
                            data: {
                                pool_id: config.poolId,
                                region: config.region,
                                time: new Date().toISOString(),
                                ip: client.remoteAddress,
                                port: client.remotePort
                            },
                        })
                    })
                    .on('unknownStratumMethod', function (fullMessage) {
                        logger.error('Unknown stratum method from ' + client.getLabel() + ': ' + fullMessage.method);
                        syncer.publish(config.rabbitmq.exchange, `alphpool.updates.${config.poolId}`, {
                            event: 'unknown_stratum_method',
                            time: new Date().toISOString(),
                            data: {
                                pool_id: config.poolId,
                                region: config.region,
                                time: new Date().toISOString(),
                                ip: client.remoteAddress,
                                port: client.remotePort
                            },
                        })
                    })
                    .on('socketFlooded', function () {
                        logger.warn('Detected socket flooding from ' + client.getLabel());
                        syncer.publishUpdate({
                            event: 'socket_flooded',
                            time: new Date().toISOString(),
                            data: {
                                ip: client.remoteAddress,
                                port: client.remotePort,
                                pool_id: config.poolId,
                                region: config.region,
                                time: new Date().toISOString(),
                            },
                        })
                    })
                    .on('triggerBan', function (reason) {
                        logger.info('Banned triggered for ' + client.getLabel() + ': ' + reason);
                        syncer.publish(config.rabbitmq.exchange, `alphpool.updates.${config.poolId}`, {
                            event: 'trigger_ban',
                            time: new Date().toISOString(),
                            data: {
                                pool_id: config.poolId,
                                region: config.region,
                                time: new Date().toISOString(),
                                ip: client.remoteAddress,
                                port: client.remotePort
                            },
                        })
                    });
            })
            .on('client.disconnected', function (client) {
                logger.info('Client ' + client.getLabel() + ' disconnected');
                syncer.publish(config.rabbitmq.exchange, `alphpool.updates.${config.poolId}`, {
                    event: 'disconnected',
                    time: new Date().toISOString(),
                    data: {
                        pool_id: config.poolId,
                        region: config.region,
                        time: new Date().toISOString(),
                        ip: client.remoteAddress,
                        port: client.remotePort
                    },
                })
            });
    }
};
pool.prototype.__proto__ = events.EventEmitter.prototype;
