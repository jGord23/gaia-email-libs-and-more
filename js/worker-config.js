/*global requirejs, setTimeout */
// Note: No AMD module here since this file configures RequireJS.
(function(root) {
  'use strict';

  // inlined from the query_string module.
  function queryToObject(value) {
    if (!value) {
      return null;
    }

    var result = {};

    value.split('&').forEach(function(keyValue) {
      var pair = keyValue.split('=');
      result[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1]);
    });
    return result;
  }

  var params = queryToObject(self.location.href.split('#')[1]);

  requirejs.config({
    baseUrl: '.',
    scriptType: 'application/javascript;version=1.7',
    packages: [{
      name: 'wo-imap-handler',
      location: 'ext/imap-handler/src',
      main: 'imap-handler'
    }],

    map: {
      'browserbox': {
        'axe': 'axeshim-browserbox'
      },
      'browserbox-imap': {
        'axe': 'axeshim-browserbox'
      },
      'ext/smtpclient': {
        'axe': 'axeshim-smtpclient'
      },
    },

    paths: {
      // Configure any manual paths here:
      'bleach': 'ext/bleach.js/lib/bleach',
      'imap-formal-syntax': 'ext/imap-handler/src/imap-formal-syntax',
      'smtpclient-response-parser':
        'ext/smtpclient/src/smtpclient-response-parser',
      'tests': '../test/unit',
      'wbxml': 'ext/activesync-lib/wbxml/wbxml',
      'activesync/codepages': 'ext/activesync-lib/codepages',
      'activesync/protocol': 'ext/activesync-lib/protocol',
      'gelam': '.',

      // This lists every top-level module in GELAM/js/ext.
      // CAUTION: It is automatically updated during the build step;
      // don't change or your edits will be as sticky as a dusty post-it.
      // If you see changes here because you modified our deps, commit it!
      // <gelam-ext>
      'activesync-lib': 'ext/activesync-lib',
      'addressparser': 'ext/addressparser',
      'alameda': 'ext/alameda',
      'axe': 'ext/axe',
      'axe-logger': 'ext/axe-logger',
      'axeshim-browserbox': 'ext/axeshim-browserbox',
      'axeshim-smtpclient': 'ext/axeshim-smtpclient',
      'bleach.js': 'ext/bleach.js',
      'browserbox': 'ext/browserbox',
      'browserbox-compression': 'ext/browserbox-compression',
      'browserbox-compression-worker': 'ext/browserbox-compression-worker',
      'browserbox-imap': 'ext/browserbox-imap',
      'browserbox-pako': 'ext/browserbox-pako',
      'co': 'ext/co',
      'equal': 'ext/equal',
      'evt': 'ext/evt',
      'fibonacci-heap': 'ext/fibonacci-heap',
      'imap-handler': 'ext/imap-handler',
      'jsmime': 'ext/jsmime',
      'mailbuild': 'ext/mailbuild',
      'md5': 'ext/md5',
      'mimefuncs': 'ext/mimefuncs',
      'mimeparser': 'ext/mimeparser',
      'mimeparser-tzabbr': 'ext/mimeparser-tzabbr',
      'mimetypes': 'ext/mimetypes',
      'mix': 'ext/mix',
      'punycode': 'ext/punycode',
      'safe-base64': 'ext/safe-base64',
      'smtpclient': 'ext/smtpclient',
      'streams': 'ext/streams',
      'stringencoding': 'ext/stringencoding',
      'tcp-socket': 'ext/tcp-socket',
      'utf7': 'ext/utf7',
      'wo-utf7': 'ext/wo-utf7'
      // </gelam-ext>
    },
    // Timeouts are mostly to detect 404 errors, however, there are erorrs
    // generated in the logs in those cases, so the main concern is slow
    // devices taking a while/email app competing with other apps for time,
    // so set this to zero always.
    waitSeconds: 0
  });

  // Separate out this config since it is runtime-specific, not a static config
  // that can be parsed by build tools.
  if (params.appLogic) {
    requirejs.config({
      paths: {
        'app_logic': params.appLogic
      }
    });
  }

  // Allow baseUrl override for things like tests
  if (typeof gelamWorkerBaseUrl === 'string') {
    requirejs.config({
      baseUrl: gelamWorkerBaseUrl
    });
  }

  // Install super-simple shims here.
  root.setZeroTimeout = function(fn) {
    setTimeout(function() { fn(); }, 0);
  };
})(this);
