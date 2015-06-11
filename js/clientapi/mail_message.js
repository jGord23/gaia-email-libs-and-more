define(function(require) {
'use strict';

var evt = require('evt');
var ContactCache = require('./contact_cache');
var MailAttachment = require('./mail_attachment');

function revokeImageSrc() {
  // see showBlobInImg below for the rationale for useWin.
  var useWin = this.ownerDocument.defaultView || window;
  useWin.URL.revokeObjectURL(this.src);
}
function showBlobInImg(imgNode, blob) {
  // We need to look at the image node because object URLs are scoped per
  // document, and for HTML e-mails, we use an iframe that lives in a different
  // document than us.
  //
  // the "|| window" is for our shimmed testing environment and should not
  // happen in production.
  var useWin = imgNode.ownerDocument.defaultView || window;
  imgNode.src = useWin.URL.createObjectURL(blob);
  // We can revoke the URL after we are 100% sure the image has resolved the URL
  // to get at the underlying blob.  Once autorevoke URLs are supported, we can
  // stop doing this.
  imgNode.addEventListener('load', revokeImageSrc);
}

function filterOutBuiltinFlags(flags) {
  // so, we could mutate in-place if we were sure the wire rep actually came
  // over the wire.  Right now there is de facto rep sharing, so let's not
  // mutate and screw ourselves over.
  var outFlags = [];
  for (var i = flags.length - 1; i >= 0; i--) {
    if (flags[i][0] !== '\\') {
      outFlags.push(flags[i]);
    }
  }
  return outFlags;
}

/**
 * Email overview information for displaying the message in the list as planned
 * for the current UI.  Things that we don't need (ex: to/cc/bcc) for the list
 * end up on the body, currently.  They will probably migrate to the header in
 * the future.
 *
 * Events are generated if the metadata of the message changes or if the message
 * is removed.  The `BridgedViewSlice` instance is how the system keeps track
 * of what messages are being displayed/still alive to need updates.
 */
function MailMessage(api, wireRep, slice) {
  evt.Emitter.call(this);
  this._api = api;
  this._slice = slice;

  // Store the wireRep so it can be used for caching.
  this._wireRep = wireRep;

  this.id = wireRep.id;
  this.guid = wireRep.guid;

  this.author = ContactCache.resolvePeep(wireRep.author);
  this.to = ContactCache.resolvePeeps(wireRep.to);
  this.cc = ContactCache.resolvePeeps(wireRep.cc);
  this.bcc = ContactCache.resolvePeeps(wireRep.bcc);
  this.replyTo = wireRep.replyTo;

  this.date = new Date(wireRep.date);

  this.attachments = null;
  if (wireRep.attachments) {
    this.attachments = [];
    for (var iAtt = 0; iAtt < wireRep.attachments.length; iAtt++) {
      this.attachments.push(
        new MailAttachment(this, wireRep.attachments[iAtt]));
    }
  }
  this._relatedParts = wireRep.relatedParts;
  this.bodyReps = wireRep.bodyReps;
  // references is included for debug/unit testing purposes, hence is private
  this._references = wireRep.references;

  this.__update(wireRep);
  this.hasAttachments = wireRep.hasAttachments;

  this.subject = wireRep.subject;
  this.snippet = wireRep.snippet;
}
MailMessage.prototype = evt.mix({
  toString: function() {
    return '[MailHeader: ' + this.id + ']';
  },
  toJSON: function() {
    return {
      type: 'MailHeader',
      id: this.id
    };
  },

  __update: function(wireRep, detail) {
    this._wireRep = wireRep;
    if (wireRep.snippet !== null) {
      this.snippet = wireRep.snippet;
    }

    this.isRead = wireRep.flags.indexOf('\\Seen') !== -1;
    this.isStarred = wireRep.flags.indexOf('\\Flagged') !== -1;
    this.isRepliedTo = wireRep.flags.indexOf('\\Answered') !== -1;
    this.isForwarded = wireRep.flags.indexOf('$Forwarded') !== -1;
    this.isJunk = wireRep.flags.indexOf('$Junk') !== -1;
    this.tags = filterOutBuiltinFlags(wireRep.flags);
    this.labels = this._api._mapLabels(this.id, wireRep.folderIds);

    // Messages in the outbox will have `sendStatus` populated like so:
    // {
    //   state: 'pending', 'error', 'success', 'sending', or 'syncDone'
    //   err: null,
    //   badAddresses: null,
    //   sendFailures: 2
    // }
    this.sendStatus = wireRep.sendStatus || {};

    // Related parts and bodyReps have no state we need to maintain.  Just
    // replace them with the new copies for simplicity.
    this._relatedParts = wireRep.relatedParts;
    this.bodyReps = wireRep.bodyReps;

    // detaching an attachment is special since we need to splice the attachment
    // out.
    if (detail && detail.changeDetails &&
        detail.changeDetails.detachedAttachments) {
      var indices = detail.changeDetails.detachedAttachments;
      for (var iSplice = 0; iSplice < indices.length; iSplice++) {
        this.attachments.splice(indices[iSplice], 1);
      }
    }

    // Attachment instances need to be updated rather than replaced.
    if (wireRep.attachments) {
      var i, attachment;
      for (i = 0; i < this.attachments.length; i++) {
        attachment = this.attachments[i];
        attachment.__update(wireRep.attachments[i]);
      }
      // If we added new attachments, construct them now.
      for (i = this.attachments.length; i < wireRep.attachments.length; i++) {
        this.attachments.push(
          new MailAttachment(this, wireRep.attachments[i]));
      }
      // We don't handle the fictional case where wireRep.attachments
      // decreases in size, because that doesn't currently happen and
      // probably won't ever, apart from detachedAttachments above
      // which are a different thing.
    }

  },

  /**
   * Release subscriptions associated with the header; currently this just means
   * tell the ContactCache we no longer care about the `MailPeep` instances.
   */
  release: function() {
    ContactCache.forgetPeepInstances([this.author], this.to, this.cc, this.bcc);
  },

  /**
   * In Gmail, removes the \Inbox label from a message.  For other account
   * types, this currently does nothing.  But I guess the idea would be that
   * we'd trigger a move to an archive folder.
   */
  archiveFromInbox: function() {

  },

  /**
   * Delete this message by moving the messages to the trash folder if not
   * currently in the trash folder.  Permanent deletion is triggered if the
   * message is already in the trash folder.
   */
  deleteMessage: function() {
    return this._api.deleteMessages([this]);
  },

  /*
   * Copy this message to another folder.
   */
  /*
  copyMessage: function(targetFolder) {
    return this._slice._api.copyMessages([this], targetFolder);
  },
  */

  /**
   * Move this message to another folder.  This should *not* be used on gmail,
   * instead modifyLabels should be used.
   */
  moveMessage: function(targetFolder) {
    return this._api.moveMessages([this], targetFolder);
  },

  /**
   * Set or clear the read status of this message.
   */
  setRead: function(beRead) {
    return this._api.markMessagesRead([this], beRead);
  },

  /**
   * Set or clear the starred/flagged status of this message.
   */
  setStarred: function(beStarred) {
    return this._api.markMessagesStarred([this], beStarred);
  },

  /**
   * Add and/or remove tags/flags from this message.
   *
   * @param {String[]} [addTags]
   * @param {String[]} [removeTags]
   */
  modifyTags: function(addTags, removeTags) {
    return this._api.modifyMessageTags([this], addTags, removeTags);
  },

  /**
   * And and/or remove gmail labels from this message.  This only makes sense
   * for gmail, and we expose lables as Folders.
   *
   * @param {MailFolder[]} [addFolders]
   * @param {MailFolder[]} [removeFolders]
   */
  modifyLabels: function(addFolders, removeFolders) {
    return this._api.modifyMessageLabels([this], addFolders, removeFolders);
  },

  /**
   * Returns the number of bytes needed before we can display the full
   * body. If this value is large, we should warn the user that they
   * may be downloading a large amount of data. For IMAP, this value
   * is the amount of data we need to render bodyReps and
   * relatedParts; for POP3, we need the whole message.
   */
  get bytesToDownloadForBodyDisplay() {
    // If this is unset (old message), default to zero so that we just
    // won't show any warnings (rather than prompting incorrectly).
    return this._wireRep.bytesToDownloadForBodyDisplay || 0;
  },

  /**
   * Assume this is a draft message and return a MessageComposition object
   * that will be asynchronously populated.  The provided callback will be
   * notified once all composition state has been loaded.
   *
   * The underlying message will be replaced by other messages as the draft
   * is updated and effectively deleted once the draft is completed.  (A
   * move may be performed instead.)
   */
  editAsDraft: function(callback) {
    var composer = this._slice._api.resumeMessageComposition(this, callback);
    composer.hasDraft = true;
    return composer;
  },

  /**
   * Start composing a reply to this message.
   *
   * @args[
   *   @param[replyMode @oneof[
   *     @default[null]{
   *       To be specified...
   *     }
   *     @case['sender']{
   *       Reply to the author of the message.
   *     }
   *     @case['list']{
   *       Reply to the mailing list the message was received from.  If there
   *       were other mailing lists copied on the message, they will not
   *       be included.
   *     }
   *     @case['all']{
   *       Reply to the sender and all listed recipients of the message.
   *     }
   *   ]]{
   *     The not currently used reply-mode.
   *   }
   * ]
   * @return[MessageComposition]
   */
  replyToMessage: function(replyMode, callback) {
    return this._slice._api.beginMessageComposition(
      this, null, { replyTo: this, replyMode: replyMode }, callback);
  },

  /**
   * Start composing a forward of this message.
   *
   * @args[
   *   @param[forwardMode @oneof[
   *     @case['inline']{
   *       Forward the message inline.
   *     }
   *   ]]
   * ]
   * @return[MessageComposition]
   */
  forwardMessage: function(forwardMode, callback) {
    return this._slice._api.beginMessageComposition(
      this, null, { forwardOf: this, forwardMode: forwardMode }, callback);
  },

  /**
   * true if this is an HTML document with inline images sent as part of the
   * messages.
   */
  get embeddedImageCount() {
    if (!this._relatedParts) {
      return 0;
    }
    return this._relatedParts.length;
  },

  /**
   * Trigger download of the body parts for this message if they're not already
   * downloaded.  This method does not currently return any value.  The idea is
   * that you wait for events on the message to know when things happen.  We'll
   * probably add something like `bodyDownloadPending` to help you convey that
   * something's happening.
   */
  downloadBodyReps: function() {
    this._api._downloadBodyReps(this.id, this.date.valueOf());
  },

  /**
   * true if all the bodyReps are downloaded.
   */
  get bodyRepsDownloaded() {
    var i = 0;
    var len = this.bodyReps.length;

    for (; i < len; i++) {
      if (!this.bodyReps[i].isDownloaded) {
        return false;
      }
    }
    return true;
  },

  /**
   * true if all of the images are already downloaded.
   */
  get embeddedImagesDownloaded() {
    for (var i = 0; i < this._relatedParts.length; i++) {
      var relatedPart = this._relatedParts[i];
      if (!relatedPart.file) {
        return false;
      }
    }
    return true;
  },

  /**
   * Trigger the download of any inline images sent as part of the message.
   * Once the images have been downloaded, invoke the provided callback.
   */
  downloadEmbeddedImages: function(callWhenDone, callOnProgress) {
    var relPartIndices = [];
    for (var i = 0; i < this._relatedParts.length; i++) {
      var relatedPart = this._relatedParts[i];
      if (relatedPart.file) {
        continue;
      }
      relPartIndices.push(i);
    }
    if (!relPartIndices.length) {
      if (callWhenDone) {
        callWhenDone();
      }
      return;
    }
    this._api._downloadAttachments(this, relPartIndices, [], [],
                                   callWhenDone, callOnProgress);
  },

  /**
   * Synchronously trigger the display of embedded images.
   *
   * The loadCallback allows iframe resizing logic to fire once the size of the
   * image is known since Gecko still doesn't have seamless iframes.
   */
  showEmbeddedImages: function(htmlNode, loadCallback) {
    var i, cidToBlob = {};
    // - Generate object URLs for the attachments
    for (i = 0; i < this._relatedParts.length; i++) {
      var relPart = this._relatedParts[i];
      // Related parts should all be stored as Blobs-in-IndexedDB
      if (relPart.file && !Array.isArray(relPart.file)) {
        cidToBlob[relPart.contentId] = relPart.file;
      }
    }

    // - Transform the links
    var nodes = htmlNode.querySelectorAll('.moz-embedded-image');
    for (i = 0; i < nodes.length; i++) {
      var node = nodes[i],
          cid = node.getAttribute('cid-src');

      if (!cidToBlob.hasOwnProperty(cid)) {
        continue;
      }
      showBlobInImg(node, cidToBlob[cid]);
      if (loadCallback) {
        node.addEventListener('load', loadCallback, false);
      }

      node.removeAttribute('cid-src');
      node.classList.remove('moz-embedded-image');
    }
  },

  /**
   * @return[Boolean]{
   *   True if the given HTML node sub-tree contains references to externally
   *   hosted images.  These are detected by looking for markup left in the
   *   image by the sanitization process.  The markup is not guaranteed to be
   *   stable, so don't do this yourself.
   * }
   */
  checkForExternalImages: function(htmlNode) {
    var someNode = htmlNode.querySelector('.moz-external-image');
    return someNode !== null;
  },

  /**
   * Transform previously sanitized references to external images into live
   * references to images.  This un-does the operations of the sanitization step
   * using implementation-specific details subject to change, so don't do this
   * yourself.
   */
  showExternalImages: function(htmlNode, loadCallback) {
    // querySelectorAll is not live, whereas getElementsByClassName is; we
    // don't need/want live, especially with our manipulations.
    var nodes = htmlNode.querySelectorAll('.moz-external-image');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (loadCallback) {
        node.addEventListener('load', loadCallback, false);
      }
      node.setAttribute('src', node.getAttribute('ext-src'));
      node.removeAttribute('ext-src');
      node.classList.remove('moz-external-image');
    }
  },
});

return MailMessage;
});