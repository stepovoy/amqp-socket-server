#!/usr/bin/env node
let fs = require('fs');
let app = require('express')();
let path = require('path');
let amqp = require('amqplib');
let mongoose = require('mongoose');

let http = require('http').createServer(app);
let https = require('https').createServer({
  cert: fs.readFileSync('./ssl/amqp.crt'),
  key: fs.readFileSync('./ssl/amqp.key')
}, app);

let ws = require('socket.io')(http, {
  path: '/',
  serveClient: false,
  pingInterval: 10000,
  pingTimeout: 5000,
  cookie: false
});

let wss = require('socket.io')(https, {
  path: '/',
  serveClient: false,
  // below are engine.IO options
  pingInterval: 10000,
  pingTimeout: 5000,
  cookie: false
});

let port = process.env.port || 3000;
let port_ssl = process.env.port_ssl || 3100;

http.listen(port, 'localhost', () => {
  console.log("Http server listening on port localhost:%s", port);
});

https.listen(port_ssl, 'localhost', () => {
  console.log("Https server listening on port localhost:%s", port_ssl);
});

let queue_env = JSON.parse(process.env.queue);
let amqp_env = JSON.parse(process.env.amqp);
let mongodb_env = JSON.parse(process.env.mongodb);
let amqp_connection_string = `amqp://${amqp_env.login}:${amqp_env.password}@${amqp_env.host}:${amqp_env.port}${amqp_env.vhost}?heartbeat=60&connection_timeout=5000`;
let mongodb_connection_string = `mongodb://${mongodb_env.host}:${mongodb_env.port}/${mongodb_env.collection}`;

mongoose.connect(mongodb_connection_string, {autoIndex: true, autoReconnect: true, keepAlive: 120}, (err, _) => {
  if (err) {
    console.log('Unable to connect to the MongoDB server. Please start the server. Error:', err);
  } else {
    console.log('Connected to MongoDB server successfully!');
  }
});

let User = mongoose.model('User', new mongoose.Schema({
    uuid: {type: String, trim: true, index: true, unique: true},
    connections: [{
      _id: {type: String, index: true},
      created: {type: Date, default: Date.now}
    }]
  })
);

let processData = (socket, socket_connect) => {
  console.log("[Socket] User connected. ID: " + socket.id);

  amqp.connect(amqp_connection_string)
    .then(conn => {
      socket.on('disconnect', () => {
        console.log(' [Socket] user disconnected');
        console.log(' [MQ] connection closed');
        conn.close();
      });
      console.log(' [MQ] connection created');
      socket.on('data', (message) => {
        console.log(socket.id);
        console.log(' [Socket] message: ' + message);
        // JSON.parse(message) and find uuid property
        let parsedMessage = JSON.parse(message);
        let uuid = parsedMessage.uuid;
        console.log(' [Socket] message.uuid:', uuid);
        let rabbit = parsedMessage.rabbit !== undefined ? parsedMessage.rabbit : true;

        // check file exist with uuid name
        let findOrUpdatePromise = new Promise(resolve => {
          User.findOne({uuid: uuid}, (err, res) => {
            if (err) console.log(err);

            if (res && res.connections && res.connections.length) { // if exist - append socket connection id to this file
              console.log(' [MongoDB] found in db records:', res.connections.length);

              if (res.connections.findIndex(connection => connection._id === socket.id) === -1) {
                User.update({uuid: uuid}, {$addToSet: {connections: {_id: socket.id}}}, (err) => {
                  if (err) console.log(err);
                  console.log(' [MongoDB] user updated');
                })
              }
            } else { // else create file and put content (socket connection id)
              let newUser = new User({uuid: uuid, connections: {_id: socket.id}});
              newUser.save(() => {
                console.log(' [MongoDB] newUser created');
              });
            }
            resolve(true);
          });
        });

        findOrUpdatePromise.then(() => {
          console.log(" [Socket] Socket '%s' received '%s' data.. ", socket.id, message);
          if (rabbit) {
            return conn.createChannel()
              .then(channel => {
                let ok = channel.assertQueue(queue_env.in, {durable: false});
                console.log(" [MQ] Assert a queue '%s'", queue_env.in);
                ok.then(() => {
                  channel.sendToQueue(queue_env.in, Buffer.from(message)); // push to queue
                  console.log(" [MQ] Sent '%s' to queue '%s'", message, queue_env.in);
                });
              });
          }
          else {
            console.log(mongodb_env);
            User.findOne({uuid: uuid}, (err, res) => {
              if (err) console.log(err);

              if (res && res.connections && res.connections.length) {
                res.connections.forEach(connection => {
                  try {
                    console.log(' [Socket] connection: ', connection);
                    if (socket_connect.sockets.connected[connection._id]) {
                      socket_connect.sockets.connected[connection._id].emit('data', message);
                    }
                  } catch (e) {
                    console.log(" [Socket][" + connection._id + "] Error: ", e);
                  }
                })
              }
            })
          }
        });
        conn.createConfirmChannel()
          .then(channel => {
            let ok = channel.assertQueue(queue_env.out, {durable: false}); // define which queue to listen
            ok = ok.then(() => {
              channel.prefetch(1);
              console.log(' [MQ.out] prefetched successfully');
            });

            return ok.then(() => {
              channel.consume(queue_env.out, doWork, {noAck: false}); // worker, receives message
              console.log(' [MQ.out] consumed successfully');
              // consumer.then(() => {
              //   console.log(" [MQ] Waiting for messages. To exit press CTRL+C");
              //   console.log(' [MQ] consumer:', consumer);
              // });

              function doWork(message) {
                let body = message.content.toString();
                console.log(" [MQ] Received '%s'", body);
                // let secs = body.split('.').length - 1;
                // setTimeout(() => {
                console.log(" [MQ] Done");
                channel.ack(message);

                let parsedMessage = JSON.parse(body);
                let uuid = parsedMessage.request.uuid;
                console.log(' [MQ] doWork: message.uuid:', uuid);
                User.findOne({uuid: uuid}, (err, res) => {
                  if (err) console.log(err);

                  if (res && res.connections && res.connections.length) { // if exist - send all of the _id body of a message
                    console.log(" [MongoDB] found connections in db records: %s", res.connections.length);

                    res.connections.forEach(connection => {
                      try {
                        console.log(' [MongoDB] connection', connection);
                        if (socket_connect.sockets.connected[connection._id]) {
                          socket_connect.sockets.connected[connection._id].emit('data', body);
                        }
                      } catch (e) {
                        console.log(" [MongoDB][" + connection + "] Error: ", e);
                      }
                    })
                    // update user, add new _id to connections
                  } else {
                    console.log(" [MongoDB] No '%s' found in MongoDB", uuid);
                  }
                });
                // }, secs);
              }

            }).catch(console.warn);
          });
      });
    }).catch(console.warn);
};

ws.on('connection', (socket) => {
  return processData(socket, ws);
});

wss.on('connection', (socket) => {
  return processData(socket, wss);
});
