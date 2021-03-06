define(function(require) {
'use strict';

return {
  /**
   * Gathers message given messageId, but this never needs to be specified as
   * a gather path by filters/friends.  It's harmless if specified, but in a
   * case where this wasn't already provided for by the context, the
   * data-ordering is certain to cause failures.
   *
   * In the message context case, this will be specified as the bootstrapKey and
   * so automatically used.  Explicit mentions of it are idempotently moot at
   * gather hierarchy build time since the key will already match.
   *
   * In the conversations "messages" case, the "conv_messages" gatherer will
   * have provided the "message" object directly into the context already.  In
   * that case this gatherer will be added but will be inhibited from running
   * by the key already being present in the "gatherInto".
   */
  message: {
    constructor: require('./gatherers/message'),
    params: null,
    nested: null
  },
  bodyContents: {
    constructor: require('./gatherers/message_bodies'),
    params: null,
    nested: null
  }
};
});
