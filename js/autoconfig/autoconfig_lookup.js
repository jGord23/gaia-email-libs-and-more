define(function(require) {
'use strict';

const logic = require('logic');
const { latchedWithRejections } = require('../allback');

const { AUTOCONFIG_TIMEOUT_MS, ISPDB_AUTOCONFIG_ROOT } = require('../syncbase');

const testingHacks = require('./testing_hacks');
const fillConfigPlaceholders = require('./fill_config_placeholders');

/**
 * Autoconfiguration logic, implemented as a class for historical reasons and
 * THIS CLASS IS NOT EXPOSED OUTSIDE THIS FILE, only autoconfigLookup is
 * exposed!  Note that if we ever introduce the ability to interrupt the
 * autoconfig, the class implementation may be handy.
 *
 * The Autoconfigurator tries to automatically determine account settings, in
 * large part by taking advantage of Thunderbird's prior work on autoconfig:
 * <https://developer.mozilla.org/en-US/docs/Thunderbird/Autoconfiguration>.
 * There are some important differences, however, since we support ActiveSync
 * whereas Thunderbird does not.
 *
 * The v2 process is as follows.  All of this is done without a password (since
 * it might turn out we don't need a password in the case of OAuth2-based auth.)
 *
 *  1) Get the domain from the user's email address
 *  2) Check hardcoded-into-GELAM account settings for the domain (useful for
 *     unit tests)
 *  3) Check locally stored XML config files in Gaia for the domain at
 *     `/autoconfig/<domain>`
 *  4) In parallel:
 *     - Do server-hosted autoconfig checks at URLs, passing the user's email
 *       address in the query string (as `emailaddress`)
 *       - `https://autoconfig.<domain>/mail/config-v1.1.xml` and
 *       - `https://<domain>/.well-known/autoconfig/mail/config-v1.1.xml`,
 *     - Check the Mozilla ISPDB for the domain:
 *       - `https://live.mozillamessaging.com/autoconfig/v1.1/<domain>`
 *     - Having the Mozilla ISPDB do an MX lookup.
 *  5) If we didn't reach a conclusion in step 4, check the MX lookup result.
 *     If it differed from the domain, then re-lookup the locally stored XML
 *     config and failing that, check the ISPDB for that domain.
 *  6) If that didn't net us anything, look for evidence of ActiveSync
 *     AutoDiscover endpoints at the following locations in parallel:
 *     `https://<domain>/autodiscover/autodiscover.xml`
 *     `https://autodiscover.<domain>/autodiscover/autodiscover.xml`
 *
 * This differs from the v1 process in that:
 * - v1 did everything in serial not parallel
 * - v1 used http, not httpS, to look for self-hosted autoconfig servers.
 * - v1 ran autodiscover before checking with the ISPDB but after local and
 *   server-hosted ISPDB autoconfig files.
 * - v1 actually ran autodiscover.  Now we just look for evidence of
 *   autodiscover.  AutoDiscover requires being able to authenticate the user
 *   which implies having the password.  Since we're not sure if we need a
 *   password or not, we can't do that yet.  We leave AutoDiscover up to the
 *   ActiveSync configurator to perform.
 * - v1 wanted the user's password
 *
 * These changes were informed by the following needs and observations:
 * - http was a bad idea security-wise, but was done for consistency with
 *   Thunderbird.  The Thunderbird rationale involved DNS also being insecure,
 *   so an attacker could already win with local network control.  However,
 *   Thunderbird also allowed autoconfig to return settings that didn't
 *   use SSL/TLS, whereas we do not.  (We ignore them).
 *
 *   Thunderbird has recently come around to the use of https instead of http
 *   for this purpose.  It's also worth noting that as far as we know, almost
 *   no one actually hosts their own autoconfig servers.
 *
 * - AutoDiscover can be very slow, especially if we're waiting for our requests
 *   to timeout.
 *
 * - It's become common to see servers that implement ActiveSync (which we
 *   strongly dislike) as well as IMAP (which we strongly prefer).  By letting
 *   ActiveSync derail the decision-making process we rob ourselves of the
 *   ability to have the ISPDB indicate the IMAP is an option.
 *
 * - If the user's server supports OAuth2, there's no need to make them type in
 *   their password; it might even be confusing to them.
 *
 * Our ConfigInfo structures look like the following:
 *
 * {
 *   type: 'imap+smtp',
 *   incoming: {
 *     hostname: <imap hostname>,
 *     port: <imap port number>,
 *     socketType: <one of 'plain', 'SSL', 'STARTTLS'>,
 *     username: <imap username>,
 *     authentication: <one of 'password-cleartext', 'xoauth2'>
 *   },
 *   outgoing: {
 *     hostname: <smtp hostname>,
 *     port: <smtp port>,
 *     socketType: <one of 'plain', 'SSL', 'STARTTLS'>,
 *     username: <smtp username>,
 *     authentication: <one of 'password-cleartext', 'xoauth2'>
 *   },
 *   oauth2Settings: null or {
 *     secretGroup: <group identify which app secrets should be used>,
 *     authEndpoint: <auth url of the page to show to the user>,
 *     tokenEndpoint: <url for getting/refreshing tokens (no user ui)>,
 *     scope: <space-delimited scopes to request>
 *   }
 * }
 *
 * POP3 is similar to IMAP/SMTP but it's 'pop3+smtp'.  ActiveSync looks
 * like:
 *
 * {
 *   type: 'activesync',
 *   displayName: <display name>, (optional)
 *   incoming: {
 *     server: 'https://<activesync hostname>'
 *   },
 * }
 */
function Autoconfigurator() {
  this.timeout = AUTOCONFIG_TIMEOUT_MS;
  logic.defineScope(this, 'Autoconfigurator');
}
Autoconfigurator.prototype = {
  /**
   * The list of fatal error codes.
   *
   * What's fatal and why:
   * - bad-user-or-pass: We found a server, it told us the credentials were
   *     bogus.  There is no point going on.
   * - not-authorized: We found a server, it told us the credentials are fine
   *     but the access rights are insufficient.  There is no point going on.
   *
   * Non-fatal and why:
   * - unknown: If something failed we should keep checking other info sources.
   * - no-config-info: The specific source had no details; we should keep
   *     checking other sources.
   */
  _fatalErrors: ['bad-user-or-pass', 'not-authorized'],

  /**
   * Check the supplied error and return true if it's really a "success" or if
   * it's a fatal error we can't recover from.
   *
   * @param error the error code
   * @return true if the error is a "success" or if it's a fatal error
   */
  _isSuccessOrFatal: function(error) {
    return !error || this._fatalErrors.indexOf(error) !== -1;
  },

  /**
   * Get an XML config file from the supplied url. The format is defined at
   * <https://wiki.mozilla.org/Thunderbird:Autoconfiguration:ConfigFileFormat>.
   *
   * @param url the URL to fetch the config file from
   * @param callback a callback taking an error string (if any) and the config
   *        info, formatted as JSON
   */
  _getXmlConfig: function getXmlConfig(url) {
    return new Promise((resolve, reject) => {
      var scope = logic.subscope(this, { method: 'GET', url: url });
      logic(scope, 'xhr:start');
      var xhr = new XMLHttpRequest({mozSystem: true});
      xhr.open('GET', url, true);
      xhr.timeout = this.timeout;

      xhr.onload = function() {
        logic(scope, 'xhr:end', { status: xhr.status });
        if (xhr.status < 200 || xhr.status >= 300) {
          reject('status' + xhr.status);
          return;
        }
        // XXX: For reasons which are currently unclear (possibly a platform
        // issue), trying to use responseXML results in a SecurityError when
        // running XPath queries. So let's just do an end-run around the
        // "security".
        self.postMessage({
          uid: 0,
          type: 'configparser',
          cmd: 'accountcommon',
          args: [xhr.responseText]
        });

        self.addEventListener('message', function onworkerresponse(evt) {
          var data = evt.data;
          if (data.type !== 'configparser' || data.cmd !== 'accountcommon') {
            return;
          }
          self.removeEventListener(evt.type, onworkerresponse);
          var args = data.args;
          var config = args[0];
          resolve(config);
        });
      };

      // Caution: don't overwrite ".onerror" twice here. Just be careful
      // to only assign that once until <http://bugzil.la/949722> is fixed.

      xhr.ontimeout = function() {
        logic(scope, 'xhr:end', { status: 'timeout' });
        reject('timeout');
      };

      xhr.onerror = function() {
        logic(scope, 'xhr:end', { status: 'error' });
        reject('error');
      };

      // At least in the past, Gecko might synchronously throw when we call
      // send for a locally-hosted file, so we're sticking with this until the
      // end of time.
      try {
        xhr.send();
      }
      catch(e) {
        logic(scope, 'xhr:end', { status: 'sync-error' });
        reject('status404');
      }
    });
  },

  /**
   * Attempt to get an XML config file locally.
   *
   * @param domain the domain part of the user's email address
   * @param callback a callback taking an error string (if any) and the config
   *        info, formatted as JSON
   */
  _getConfigFromLocalFile: function getConfigFromLocalFile(domain) {
    return this._getXmlConfig('/autoconfig/' + encodeURIComponent(domain));
  },

  /**
   * Check whether it looks like there's an AutoDiscover endpoint at the given
   * URL.  AutoDiscover wants us to be authenticated, so we treat a 401 status
   * as success and anything else as failure.
   *
   * For maximum realism we perform a POST.
   */
  _checkAutodiscoverUrl: function(url) {
    return new Promise((resolve, reject) => {
      var scope = logic.subscope(this, { method: 'POST', url: url });
      logic(scope, 'autodiscoverProbe:start');
      var xhr = new XMLHttpRequest({mozSystem: true});
      xhr.open('POST', url, true);
      xhr.timeout = this.timeout;

      var victory = () => {
        resolve({
          type: 'activesync',
          incoming: {
            autodiscoverEndpoint: url
          }
        });
      };

      xhr.onload = function() {
        logic(scope, 'autodiscoverProbe:end', { status: xhr.status });
        if (xhr.status === 401) {
          victory();
          return;
        }
        reject('status' + xhr.status);
      };

      xhr.ontimeout = function() {
        logic(scope, 'autodiscoverProbe:end', { status: 'timeout' });
        reject('timeout');
      };

      xhr.onerror = function() {
        logic(scope, 'autodiscoverProbe:end', { status: 'error' });
        reject('error');
      };

      try {
        xhr.send(null);
      }
      catch(e) {
        logic(scope, 'autodiscoverProbe:end', { status: 'sync-error' });
        reject('status404');
      }
    });
  },

  /**
   * Look for AutoDiscover endpoints for the given domain.  If we find one, we
   * return what amounts to pseudo-config information.  We don't actually know
   * enough information to do a full autodiscover at this point, so we need to
   * return enough for our ActiveSync account's tryToCreateAccount method to
   * handle things from there.
   */
  _probeForAutodiscover: function(domain) {
    var subdirUrl = 'https://' + domain + '/autodiscover/autodiscover.xml';
    var domainUrl = 'https://autodiscover.' + domain +
                      '/autodiscover/autodiscover.xml';
    return latchedWithRejections({
      subdir: this._checkAutodiscoverUrl(subdirUrl),
      domain: this._checkAutodiscoverUrl(domainUrl)
    }).then((results) => {
      // Favor the subdirectory discovery point.
      if (results.subdir.resolved && results.subdir.value) {
        return results.subdir.value;
      }
      if (results.domain.resolved && results.domain.value) {
        return results.domain.value;
      }
      // Yeah, no AutoDiscover possible.
      return null;
    });
  },

  /**
   * Attempt to get an XML config file from the Mozilla ISPDB.
   *
   * @param domain the domain part of the user's email address
   */
  _getConfigFromISPDB: function(domain) {
    return this._getXmlConfig(ISPDB_AUTOCONFIG_ROOT +
                              encodeURIComponent(domain));
  },

  /**
   * Look up the DNS MX record for a domain. This currently uses a web service
   * instead of querying it directly.
   *
   * @param domain the domain part of the user's email address
   *
   * @return {Promise}
   *   If we locate a MX domain and that domain differs from our own domain, we
   *   will resolve the promise with that String.  If there is no MX domain or
   *   it is the same as our existing domain, we will resolve with a null value.
   *   In the event of a problem contacting the ISPDB server, we will reject
   *   the promise.
   */
  _getMX: function getMX(domain) {
    return new Promise((resolve, reject) => {
      var scope = logic.subscope(this, { domain: domain });
      logic(scope, 'mxLookup:begin');
      var xhr = new XMLHttpRequest({mozSystem: true});
      xhr.open('GET', 'https://live.mozillamessaging.com/dns/mx/' +
               encodeURIComponent(domain), true);
      xhr.timeout = this.timeout;

      xhr.onload = function() {
        var reportDomain = null;
        if (xhr.status === 200) {
          var normStr = xhr.responseText.split('\n')[0];
          if (normStr) {
            normStr = normStr.toLowerCase();
            // XXX: We need to normalize the domain here to get the base domain,
            // but that's complicated because people like putting dots in
            // TLDs. For now, let's just pretend no one would do such a horrible
            // thing.
            var mxDomain = normStr.split('.').slice(-2).join('.');
            if (mxDomain !== domain) {
              reportDomain = mxDomain;
            }
          }
        }
        logic(scope, 'mxLookup:end',
            { 'raw': normStr, normalized: mxDomain, reporting: reportDomain });
        resolve(reportDomain);
      };

      xhr.ontimeout = function() {
        logic(scope, 'mxLookup:end', { status: 'timeout' });
        reject('timeout');
      };
      xhr.onerror = function() {
        logic(scope, 'mxLookup:end', { status: 'error' });
        reject('error');
      };

      xhr.send();
    });
  },

  _getHostedAndISPDBConfigs: function(domain, emailAddress) {
    var commonAutoconfigSuffix = '/mail/config-v1.1.xml?emailaddress=' +
          encodeURIComponent(emailAddress);
    // subdomain autoconfig URL
    var subdomainAutoconfigUrl =
      'https://autoconfig.' + domain + commonAutoconfigSuffix;
    // .well-known autoconfig URL
    var wellKnownAutoconfigUrl =
          'https://' + domain + '/.well-known/autoconfig' +
          commonAutoconfigSuffix;

    return latchedWithRejections({
      autoconfigSubdomain: this._getXmlConfig(subdomainAutoconfigUrl),
      autoconfigWellKnown: this._getXmlConfig(wellKnownAutoconfigUrl),
      ispdb: this._getConfigFromISPDB(domain),
      mxDomain: this._getMX(domain)
    }).then((results) => {
      // Favor the autoconfig subdomain for historical reasons
      if (results.autoconfigSubdomain.resolved &&
          results.autoconfigSubdomain.value) {
        return { type: 'config', source: 'autoconfig-subdomain',
                 config: results.autoconfigSubdomain.value };
      }
      // Then the well-known
      if (results.autoconfigWellKnown.resolved &&
          results.autoconfigWellKnown.value) {
        return { type: 'config', source: 'autoconfig-wellknown',
                 config: results.autoconfigWellKnown.value };
      }
      // Then the ISPDB
      if (results.ispdb.resolved &&
          results.ispdb.value) {
        return { type: 'config', source: 'ispdb',
                 config: results.ispdb.value };
      }
      if (results.mxDomain.resolved &&
          results.mxDomain.value &&
          results.mxDomain.value !== domain) {
        return { type: 'mx', domain: results.mxDomain.value };
      }
      return { type: null };
    });
  },

  /**
   * Attempt to get an XML config file by checking the DNS MX record and
   * querying the Mozilla ISPDB.
   *
   * @param domain the domain part of the user's email address
   * @param callback a callback taking an error string (if any) and the config
   *        info, formatted as JSON
   */
  _getConfigFromMX: function getConfigFromMX(domain, callback) {
    this._getMX(domain, (mxError, mxDomain, mxErrorDetails) => {
      if (mxError) {
        return callback(mxError, null, mxErrorDetails);
      }

      console.log('  Found MX for', mxDomain);

      if (domain === mxDomain) {
        return callback('no-config-info', null, { status: 'mxsame' });
      }

      // If we found a different domain after MX lookup, we should look in our
      // local file store (mostly to support Google Apps domains) and, if that
      // doesn't work, the Mozilla ISPDB.
      console.log('  Looking in local file store');
      this._getConfigFromLocalFile(mxDomain, (error, config, errorDetails) => {
        // (Local XML lookup should not have any fatal errors)
        if (!error) {
          callback(error, config, errorDetails);
          return;
        }

        console.log('  Looking in the Mozilla ISPDB');
        this._getConfigFromDB(mxDomain, callback);
      });
    });
  },

  _checkGelamConfig: function(domain) {
    if (testingHacks.has(domain)) {
      return testingHacks.get(domain);
    }
    return null;
  },

  /**
   * See the MailAPI.learnAboutAccount documentation for detailed information,
   * but the nutshell is that we return a Promise that is resolved with an
   * object of the form { result, source, configInfo }.
   *
   * If we found useful configuration information, result will be 'need-oauth2'
   * or 'need-password'.  If we failed to find config information for any
   * reason, the result will be 'no-config-info'.  This means we conflate the
   * "something's not working right, so we're just saying there's no config"
   * case with "everything worked but we couldn't find any configuration info."
   * This is done because "try again later" isn't particularly helpful to the
   * user unless they're offline.  And we leave that up to the UI to handle
   * itself.  For now.  We can change that if needed.
   *
   * @return {Promise}
   *   A Promise resolved with an object of the form
   *   .
   */
  learnAboutAccount: function(details) {
    return new Promise((resolve) => {
      var emailAddress = details.emailAddress;
      var emailParts = emailAddress.split('@');
      var emailDomainPart = emailParts[1];
      var domain = emailDomainPart.toLowerCase();
      var scope = logic.subscope(this, { domain: domain });
      logic(scope, 'autoconfig:begin');

      var selfHostedAndISPDBHandler, mxLocalHandler, autodiscoverHandler,
          mxISPDBHandler;

      // Call this when we find a usable config setting to perform appropriate
      // normalization, logging, and promise resolution.
      var victory = (sourceConfigInfo, source) => {
        var configInfo = null, result;
        if (sourceConfigInfo) {
          configInfo = fillConfigPlaceholders(details, sourceConfigInfo);
          if (configInfo.incoming &&
              configInfo.incoming.authentication === 'xoauth2') {
            result = 'need-oauth2';
          } else {
            result = 'need-password';
          }
        } else {
          result = 'no-config-info';
        }
        logic(scope, 'autoconfig:end', {
          result: result,
          source: source,
          configInfo: configInfo
        });
        resolve({ result: result, source: source, configInfo: configInfo });
      };
      // Call this if we can't find a configuration.
      var failsafeFailure = (err) => {
        logic(this, 'autoconfig:end', { err: {
          message: err && err.message,
          stack: err && err.stack
        }});
        resolve({ result: 'no-config-info', configInfo: null });
      };

      // Helper that turns a rejection into a null and outputs a log entry.
      var coerceRejectionToNull = (err) => {
        logic(scope, 'autoconfig:coerceRejection', { err: err });
        return null;
      };

      // -- Synchronous logic
      // - Group 0: hardcoded in GELAM (testing only)
      var hardcodedConfig = this._checkGelamConfig(domain);
      if (hardcodedConfig) {
        victory(hardcodedConfig, 'hardcoded');
        return;
      }

      // -- Asynchronous setup
      // This all wants to be a generator.  It doesn't make a lot of sense to
      // structure this as a chain of then's since we do want an early return.
      // This is a good candidate for 'koa' or something like it in the near
      // future.

      // - Group 1: local config
      var localConfigHandler = (info) => {
        if (info) {
          victory(info, 'local');
          return null;
        }

        // We don't need to coerce because there will be no rejections.
        return this._getHostedAndISPDBConfigs(domain, emailAddress)
          .then(selfHostedAndISPDBHandler);
      };

      // - Group 2: self-hosted autoconfig, ISPDB first checks
      var mxDomain;
      selfHostedAndISPDBHandler = (typedResult) => {
        if (typedResult.type === 'config') {
          victory(typedResult.config, typedResult.source);
          return null;
        }
        // Did we get a different MX result?
        if (typedResult.type === 'mx') {
          mxDomain = typedResult.domain;
          return this._getConfigFromLocalFile(mxDomain)
            .catch(coerceRejectionToNull)
            .then(mxLocalHandler);
        }
        // No MX result, probe autodiscover.
        return this._probeForAutodiscover(domain)
          .then(autodiscoverHandler);
      };

      // - Group 3: MX-derived lookups
      mxLocalHandler = (info) => {
        if (info) {
          victory(info, 'mx local');
          return null;
        }
        // We didn't know about it locally, ask the ISPDB
        return this._getConfigFromISPDB(mxDomain)
          .catch(coerceRejectionToNull)
          .then(mxISPDBHandler);
      };

      mxISPDBHandler = (info) => {
        if (info) {
          victory(info, 'mx ispdb');
          return null;
        }
        // The ISPDB didn't know, probe for autodiscovery.  No coercion needed.
        return this._probeForAutodiscover(domain)
          .then(autodiscoverHandler);
      };

      // - Group 4: Autodiscover probing
      autodiscoverHandler = (info) => {
        // This is either success or we're simply done.
        victory(info, info ? 'autodiscover' : null);
        return null;
      };

      // -- Kick it off.
      this._getConfigFromLocalFile(domain)
        // Coerce the rejection for our then handler's purpose.
        .catch(coerceRejectionToNull)
        .then(localConfigHandler)
        // Register a catch-handler against localConfigHandler and all of the
        // follow-on handlers we associate.  Technically we should never call
        // this, but better safe than sorry.
        .catch(failsafeFailure);
    });
  },
};

/**
 * Run autoconfiguration against th
 */
return function autoconfigLookup(details) {
  let autoconfigurator = new Autoconfigurator();
  return autoconfigurator.learnAboutAccount(details);
};
});
