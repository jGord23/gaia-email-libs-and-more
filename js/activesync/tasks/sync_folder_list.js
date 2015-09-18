define(function(require) {
'use strict';

const evt = require('evt');
const TaskDefiner = require('../../task_definer');

const normalizeFolder = require('../normalize_folder');
const AccountSyncStateHelper = require('../account_sync_state_helper');

const enumerateHierarchyChanges = require('../smotocol/enum_hierarchy_changes');

/**
 * Sync the folder list for an ActiveSync account.  We leverage IMAP's mix-in
 * for the infrastructure (that wants to move someplace less IMAPpy.)
 */
return TaskDefiner.defineSimpleTask([
  require('../../imap/vanilla_tasks/mix_sync_folder_list'),
  {
    essentialOfflineFolders: [
      // Although the inbox is an online folder, we aren't daring enough to
      // predict its server id, so it will be fixed up later, so we just
      // leave it starting out as offline.  (For Microsoft servers, I believe
      // the inbox does have a consistent guid, but we can't assume Microsoft.)
      {
        type: 'inbox',
        displayName: 'Inbox'
      },
      {
        type: 'outbox',
        displayName: 'outbox'
      },
      {
        type: 'localdrafts',
        displayName: 'localdrafts'
      },
    ],

    syncFolders: function*(ctx, req) {
      let account = yield ctx.universe.acquireAccount(ctx, req.accountId);
      let foldersTOC = account.foldersTOC;
      let conn = yield account.ensureConnection();
      let newFolders = [];
      let modifiedFolders = new Map();

      let fromDb = yield ctx.beginMutate({
        syncStates: new Map([[req.accountId, null]])
      });

      let rawSyncState = fromDb.syncStates.get(req.accountId);
      let syncState = new AccountSyncStateHelper(
        ctx, rawSyncState, req.accountId);

      let emitter = new evt.Emitter();
      let deferredFolders = [];

      function tryAndAddFolder(folderArgs) {
        let maybeFolderInfo = normalizeFolder(
          {
            idMaker: foldersTOC.issueFolderId.bind(syncState),
            serverIdToFolderId: syncState.serverIdToFolderId,
            folderIdToFolderInfo: foldersTOC.foldersById
          },
          {
            serverId: folderArgs.ServerId,
            parentServerId: folderArgs.ParentId,
            displayName: folderArgs.DisplayName,
            typeNum: folderArgs.Type
          }
        );
        if (maybeFolderInfo === null) {
          deferredFolders.push(folderArgs);
        } else if (maybeFolderInfo === true) {
          // - we updated the inbox!
          // tell the sync state about our ID mapping.
          syncState.addedFolder(maybeFolderInfo);
          modifiedFolders.set(maybeFolderInfo.id, maybeFolderInfo);
        } else {
          // - totally new folder
          // the syncState needs to know the mapping
          syncState.addedFolder(maybeFolderInfo);
          // plus we should actually surface the folder to the UI
          newFolders.push(maybeFolderInfo);
        }
      }

      emitter.on('add', (folderArgs) => {
        tryAndAddFolder(folderArgs);
      });
      emitter.on('remove', (serverId) => {
        syncState.removedFolder(serverId);
        let folderId = syncState.serverIdToFolderId.get(serverId);
        modifiedFolders.set(folderId, null);
      });

      syncState.hierarchySyncKey = (yield* enumerateHierarchyChanges(
        conn,
        { hierarchySyncKey: syncState.hierarchySyncKey, emitter }
      )).hierarchySyncKey;

      // It's possible we got some folders in an inconvenient order (i.e. child
      // folders before their parents). Keep trying to add folders until we're
      // done.
      while (deferredFolders.length) {
        let processFolders = deferredFolders;
        deferredFolders = [];
        for (let folder of processFolders) {
          tryAndAddFolder(folder);
        }
        if (processFolders.length === deferredFolders.length) {
          throw new Error('got some orphaned folders');
        }
      }

      return {
        newFolders,
        modifiedFolders,
        modifiedSyncStates: new Map([[req.accountId, syncState.rawSyncState]])
      };
    }
  }
]);
});
