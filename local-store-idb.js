/**
 * Local authoritative store: IndexedDB mirror of object-by-view map.
 * Multiple named databases (vaults) + legacy default `inout_local_store_v1`.
 * Migrates legacy localStorage `inout_anon_objects_v1` once on the default DB only.
 */
(function (global) {
  var LEGACY_DB_NAME = 'inout_local_store_v1';
  var DB_VERSION = 1;
  var LEGACY_LS_KEY = 'inout_anon_objects_v1';
  var META_MIGRATED = 'anon_migrated_v1';

  function sanitizeVaultId(id) {
    var s = String(id || 'default').trim().slice(0, 48);
    if (!s) s = 'default';
    if (s === 'default') return 'default';
    s = s.replace(/[^a-zA-Z0-9_-]/g, '_');
    return s || 'vault';
  }

  function dbNameForVault(vaultId) {
    var s = sanitizeVaultId(vaultId);
    if (s === 'default') return LEGACY_DB_NAME;
    return 'inout_local_v1__' + s;
  }

  /**
   * @param {string} dbName
   * @param {{ migrateLegacy?: boolean }} opts
   */
  function createLocalStore(dbName, opts) {
    opts = opts || {};
    var runLegacyMigration = !!opts.migrateLegacy;

    var _dbPromise = null;
    var _initPromise = null;

    function openDb() {
      if (_dbPromise) return _dbPromise;
      _dbPromise = new Promise(function (resolve, reject) {
        var req = indexedDB.open(dbName, DB_VERSION);
        req.onerror = function () {
          reject(req.error);
        };
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains('objects')) {
            var os = db.createObjectStore('objects', { keyPath: 'id' });
            os.createIndex('channel', 'channel', { unique: false });
          }
          if (!db.objectStoreNames.contains('meta')) {
            db.createObjectStore('meta');
          }
        };
        req.onsuccess = function () {
          resolve(req.result);
        };
      });
      return _dbPromise;
    }

    function getByViewMap() {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction('objects', 'readonly');
          var os = tx.objectStore('objects');
          var req = os.getAll();
          req.onsuccess = function () {
            var all = req.result || [];
            var byView = {};
            for (var i = 0; i < all.length; i++) {
              var o = all[i];
              var ch = o.channel || 'main';
              if (!byView[ch]) byView[ch] = [];
              byView[ch].push(o);
            }
            var keys = Object.keys(byView);
            for (var k = 0; k < keys.length; k++) {
              byView[keys[k]].sort(function (a, b) {
                return String(a.created_at || '').localeCompare(String(b.created_at || ''));
              });
            }
            resolve(byView);
          };
          req.onerror = function () {
            reject(req.error);
          };
        });
      });
    }

    function setByViewMap(byView) {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction('objects', 'readwrite');
          var os = tx.objectStore('objects');
          os.clear();
          var ch;
          for (ch in byView) {
            if (!Object.prototype.hasOwnProperty.call(byView, ch)) continue;
            var list = byView[ch];
            if (!Array.isArray(list)) continue;
            for (var i = 0; i < list.length; i++) {
              var o = list[i];
              if (!o || typeof o !== 'object') continue;
              var row = {};
              for (var p in o) {
                if (Object.prototype.hasOwnProperty.call(o, p)) row[p] = o[p];
              }
              row.channel = row.channel || ch;
              if (row.id == null) continue;
              os.put(row);
            }
          }
          tx.oncomplete = function () {
            resolve();
          };
          tx.onerror = function () {
            reject(tx.error);
          };
        });
      });
    }

    function migrateLegacyLocalStorageOnce(db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('meta', 'readonly');
        var getReq = tx.objectStore('meta').get(META_MIGRATED);
        getReq.onsuccess = function () {
          var already = getReq.result;
          setTimeout(function () {
            if (already) {
              resolve(false);
              return;
            }
            var raw = null;
            try {
              raw = localStorage.getItem(LEGACY_LS_KEY);
            } catch (_) {}
            if (!raw || !raw.trim()) {
              var wtx = db.transaction('meta', 'readwrite');
              wtx.objectStore('meta').put(1, META_MIGRATED);
              wtx.oncomplete = function () {
                resolve(false);
              };
              wtx.onerror = function () {
                reject(wtx.error);
              };
              return;
            }
            try {
              var byView = JSON.parse(raw);
              if (!byView || typeof byView !== 'object') byView = {};
              setByViewMap(byView)
                .then(function () {
                  try {
                    localStorage.removeItem(LEGACY_LS_KEY);
                  } catch (_) {}
                  var wtx2 = db.transaction('meta', 'readwrite');
                  wtx2.objectStore('meta').put(1, META_MIGRATED);
                  wtx2.oncomplete = function () {
                    resolve(true);
                  };
                  wtx2.onerror = function () {
                    reject(wtx2.error);
                  };
                })
                .catch(reject);
            } catch (e) {
              reject(e);
            }
          }, 0);
        };
        getReq.onerror = function () {
          reject(getReq.error);
        };
      });
    }

    function init() {
      if (_initPromise) return _initPromise;
      _initPromise = openDb().then(function (db) {
        if (runLegacyMigration) {
          return migrateLegacyLocalStorageOnce(db);
        }
        return false;
      }).catch(function (e) {
        console.error('INOUT_LOCAL_DB.init', dbName, e);
        _initPromise = null;
        throw e;
      });
      return _initPromise;
    }

    function exportJsonString() {
      return getByViewMap().then(function (byView) {
        return JSON.stringify(byView || {});
      });
    }

    function deleteDatabase() {
      _dbPromise = null;
      _initPromise = null;
      return new Promise(function (resolve, reject) {
        var req = indexedDB.deleteDatabase(dbName);
        req.onsuccess = function () {
          resolve();
        };
        req.onerror = function () {
          reject(req.error);
        };
        req.onblocked = function () {
          resolve();
        };
      });
    }

    return {
      DB_NAME: dbName,
      init: init,
      getByViewMap: getByViewMap,
      setByViewMap: setByViewMap,
      exportJsonString: exportJsonString,
      deleteDatabase: deleteDatabase,
    };
  }

  var defaultStore = createLocalStore(LEGACY_DB_NAME, { migrateLegacy: true });

  function forVault(vaultId) {
    var name = dbNameForVault(vaultId);
    var migrateLegacy = name === LEGACY_DB_NAME;
    return createLocalStore(name, { migrateLegacy: migrateLegacy });
  }

  global.INOUT_LOCAL_DB = Object.assign(defaultStore, {
    forVault: forVault,
    sanitizeVaultId: sanitizeVaultId,
    dbNameForVault: dbNameForVault,
    LEGACY_DB_NAME: LEGACY_DB_NAME,
    LEGACY_LS_KEY: LEGACY_LS_KEY,
  });
})(typeof window !== 'undefined' ? window : this);
