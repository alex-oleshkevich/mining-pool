const amqplib = require('amqplib');

function AMQPSyncer(url) {
    let connection = null;
    let channel = null;

    const connect = async () => {
        connection = await amqplib.connect(url);
        connection.on('error', (err) => {
            if (err.message !== 'Connection closing') {
                connect();
                console.error('[AMQP] conn error', err.message);
            }
        });
        connection.on('close', () => {
            connect();
            console.error('[AMQP] connection closed');
        });

        // create channel
        channel = await connection.createChannel();
        channel.on('error', async (err) => {
            console.error('[AMQP] channel error', err.message);
            channel = await connection.createChannel()
        });
        channel.on('close', () => {
            console.log('[AMQP] channel closed');
        });
    }

    connect()
        .then(() => {
            console.log('[AMQP] connected');
        })
        .catch(err => {
            console.error('[AMQP] connect error', err.message);
        });

    this.publish = async (exchange, routingKey, content) => {
        try {
            await channel.assertExchange(exchange, 'topic', { durable: true });
            await channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(content)));
        } catch (error) {
            console.error('[AMQP] publish', error.message);
        }
    }

    this.close = async () => {
        await channel.close();
        await connection.close();
    }

    return this;
}

exports.AMQPSyncer = AMQPSyncer;
