const Pool = require("./pool");
const winston = require('winston');
const bignum = require('bignum');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = process.env.CONFIG_FILE || path.resolve(__dirname, 'config.json');

if (!fs.existsSync(CONFIG_FILE)) {
    console.log(`${CONFIG_FILE} does not exist.`);
    process.exit(1);
}

var config = JSON.parse(fs.readFileSync(CONFIG_FILE, { encoding: 'utf8' }));

config.region = process.env.REGION || config.region;
config.poolId = process.env.POOL_ID || config.poolId;
console.log('Using config file: ' + CONFIG_FILE);
console.log(`Using region: ${config.region}`);
console.log(`Using poolId: ${config.poolId}`);

if (!config.daemon.apiKey || config.daemon.apiKey === '') {
    console.warn("\x1b[31m`apiKey` is not configured, please make sure you don't need an apiKey to access your full node\x1b[0m")
}

global.diff1Target = bignum.pow(2, 256 - config.diff1TargetNumZero).sub(1);

var logger = winston.createLogger({
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(i => `${i.timestamp} | ${i.level} | ${i.message}`)
    ),
    transports: [
        new winston.transports.Console({
            level: 'info'
        })
    ]
});

var pool = new Pool(config, logger);
pool.start();
