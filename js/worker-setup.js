define(function(require) {
'use strict';

let logic = require('logic');

let $router = require('./worker-router');
let MailBridge = require('./mailbridge');
let MailUniverse = require('./mailuniverse');

let routerBridgeMaker = $router.registerInstanceType('bridge');

let bridgeUniqueIdentifier = 0;
function createBridgePair(universe) {
  var uid = bridgeUniqueIdentifier++;

  var TMB = new MailBridge(universe, universe.db, uid);
  var routerInfo = routerBridgeMaker.register(function(data) {
    TMB.__receiveMessage(data.msg);
  });
  var sendMessage = routerInfo.sendMessage;

  TMB.__sendMessage = function(msg) {
    logic(TMB, 'send', { type: msg.type, msg: msg });
    sendMessage(null, msg);
  };

  // Let's say hello to the main thread in order to generate a
  // corresponding mailAPI.
  TMB.__sendMessage({
    type: 'hello',
    config: universe.exposeConfigForClient()
  });
}

let universe = null;

function onUniverse() {
  createBridgePair(universe);
  console.log("Mail universe/bridge created and notified!");
}

var sendControl = $router.registerSimple('control', function(data) {
  var args = data.args;
  switch (data.cmd) {
    case 'hello':
      universe = new MailUniverse(args[0]);
      universe.init().then(onUniverse);
      break;
    case 'online':
    case 'offline':
      universe._onConnectionChange(args[0]);
      break;
    default:
      break;
  }
});
sendControl('hello');

////////////////////////////////////////////////////////////////////////////////
});
