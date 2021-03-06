/**
 * Customized shim for browserbox to use logic with configurable logging level
 * that can be cranked up.
 */
define(function() {
'use strict';

const logic = require('logic');
const scope = logic.scope('BrowserBox');

return {
  /**
   * Provide a .debug for things that are *only* logged when
   * sensitive logging is enabled. This exists right now mainly for
   * the benefit of the email.js libs. We're tying "debug" to
   * logSensitiveData both because we haven't audited the use of
   * debug and also because it is indeed a bit chatty.
   *
   * TODO: Address the logging detail level as a separate issue,
   * ideally while working with whiteout.io to fancify the email.js
   * logging slightly.
   */
  debug: function(ignoredTag, msg) {
    if (!logic.isCensored) {
      logic(scope, 'debug', { msg });
    }
  },
  log: function(ignoredTag, msg) {
    logic(scope, 'log', { msg });
  },
  warn: function(ignoredTag, msg) {
    logic(scope, 'warn', { msg });
  },
  error: function(ignoredTag, msg) {
    logic(scope, 'error', { msg });
  }
};
});
