"use strict";

const syncService = require('../../services/sync');
const syncUpdateService = require('../../services/sync_update');
const syncTableService = require('../../services/sync_table');
const sql = require('../../services/sql');
const sqlInit = require('../../services/sql_init');
const optionService = require('../../services/options');
const contentHashService = require('../../services/content_hash');
const log = require('../../services/log');
const syncOptions = require('../../services/sync_options');
const dateUtils = require('../../services/date_utils');
const entityConstructor = require('../../entities/entity_constructor');
const utils = require('../../services/utils');

function testSync() {
    try {
        if (!syncOptions.isSyncSetup()) {
            return { success: false, message: "Sync server host is not configured. Please configure sync first." };
        }

        syncService.login();

        // login was successful so we'll kick off sync now
        // this is important in case when sync server has been just initialized
        syncService.sync();

        return { success: true, message: "Sync server handshake has been successful, sync has been started." };
    }
    catch (e) {
        return {
            success: false,
            message: e.message
        };
    }
}

function getStats() {
    if (!sqlInit.schemaExists()) {
        // fail silently but prevent errors from not existing options table
        return {};
    }

    return {
        initialized: optionService.getOption('initialized') === 'true',
        stats: syncService.stats
    };
}

function checkSync() {
    return {
        entityHashes: contentHashService.getEntityHashes(),
        maxSyncId: sql.getValue('SELECT MAX(id) FROM sync WHERE isSynced = 1')
    };
}

function syncNow() {
    log.info("Received request to trigger sync now.");

    return syncService.sync();
}

function fillSyncRows() {
    syncTableService.fillAllSyncRows();

    log.info("Sync rows have been filled.");
}

function forceFullSync() {
    optionService.setOption('lastSyncedPull', 0);
    optionService.setOption('lastSyncedPush', 0);

    log.info("Forcing full sync.");

    // not awaiting for the job to finish (will probably take a long time)
    syncService.sync();
}

function forceNoteSync(req) {
    const noteId = req.params.noteId;

    const now = dateUtils.utcNowDateTime();

    sql.execute(`UPDATE notes SET utcDateModified = ? WHERE noteId = ?`, [now, noteId]);
    syncTableService.addNoteSync(noteId);

    sql.execute(`UPDATE note_contents SET utcDateModified = ? WHERE noteId = ?`, [now, noteId]);
    syncTableService.addNoteContentSync(noteId);

    for (const branchId of sql.getColumn("SELECT branchId FROM branches WHERE noteId = ?", [noteId])) {
        sql.execute(`UPDATE branches SET utcDateModified = ? WHERE branchId = ?`, [now, branchId]);

        syncTableService.addBranchSync(branchId);
    }

    for (const attributeId of sql.getColumn("SELECT attributeId FROM attributes WHERE noteId = ?", [noteId])) {
        sql.execute(`UPDATE attributes SET utcDateModified = ? WHERE attributeId = ?`, [now, attributeId]);

        syncTableService.addAttributeSync(attributeId);
    }

    for (const noteRevisionId of sql.getColumn("SELECT noteRevisionId FROM note_revisions WHERE noteId = ?", [noteId])) {
        sql.execute(`UPDATE note_revisions SET utcDateModified = ? WHERE noteRevisionId = ?`, [now, noteRevisionId]);
        syncTableService.addNoteRevisionSync(noteRevisionId);

        sql.execute(`UPDATE note_revision_contents SET utcDateModified = ? WHERE noteRevisionId = ?`, [now, noteRevisionId]);
        syncTableService.addNoteRevisionContentSync(noteRevisionId);
    }

    syncTableService.addRecentNoteSync(noteId);

    log.info("Forcing note sync for " + noteId);

    // not awaiting for the job to finish (will probably take a long time)
    syncService.sync();
}

function getChanged(req) {
    const startTime = Date.now();

    const lastSyncId = parseInt(req.query.lastSyncId);

    const syncs = sql.getRows("SELECT * FROM sync WHERE isSynced = 1 AND id > ? LIMIT 1000", [lastSyncId]);

    const ret = {
        syncs: syncService.getSyncRecords(syncs),
        maxSyncId: sql.getValue('SELECT MAX(id) FROM sync WHERE isSynced = 1')
    };

    if (ret.syncs.length > 0) {
        log.info(`Returning ${ret.syncs.length} sync records in ${Date.now() - startTime}ms`);
    }

    return ret;
}

function update(req) {
    const sourceId = req.body.sourceId;
    const entities = req.body.entities;

    for (const {sync, entity} of entities) {
        syncUpdateService.updateEntity(sync, entity, sourceId);
    }
}

function syncFinished() {
    // after first sync finishes, the application is ready to be used
    // this is meaningless but at the same time harmless (idempotent) for further syncs
    sqlInit.setDbAsInitialized();
}

function queueSector(req) {
    const entityName = utils.sanitizeSqlIdentifier(req.params.entityName);
    const sector = utils.sanitizeSqlIdentifier(req.params.sector);

    const entityPrimaryKey = entityConstructor.getEntityFromEntityName(entityName).primaryKeyName;

    syncTableService.addEntitySyncsForSector(entityName, entityPrimaryKey, sector);
}

module.exports = {
    testSync,
    checkSync,
    syncNow,
    fillSyncRows,
    forceFullSync,
    forceNoteSync,
    getChanged,
    update,
    getStats,
    syncFinished,
    queueSector
};
