/**
 * Sync active local IndexedDB vault to a user-chosen folder via File System Access API.
 * Writes inout-sync.json; Import reads it back. Chromium/Edge desktop typically required.
 */
(function (global) {
  var SYNC_FILE = 'inout-sync.json';
  var DB_NAME = 'inout_folder_sync_v1';
  var STORE = 'meta';
  var KEY_DIR = 'directory';

  var dirHandle = null;
  var writeTimer = null;

  function openDb() {
    return new Promise(function (resolve, reject) {
      var r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
      };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  function persistHandle(h) {
    return openDb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(h, KEY_DIR);
        tx.oncomplete = res;
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  function loadPersistedHandle() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).get(KEY_DIR);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function clearPersistedHandle() {
    return openDb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(KEY_DIR);
        tx.oncomplete = res;
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  function getSyncPayload() {
    var gv = global.getActiveVaultId;
    var gm = global.getLocalObjectByViewMap;
    if (typeof gv !== 'function' || typeof gm !== 'function') return Promise.resolve(null);
    return gm().then(function (byView) {
      return {
        version: 1,
        vaultId: gv(),
        updatedAt: new Date().toISOString(),
        objectsByView: byView || {},
      };
    });
  }

  function writeFile() {
    if (!dirHandle) return Promise.resolve();
    return getSyncPayload().then(function (payload) {
      if (!payload) return;
      return dirHandle.getFileHandle(SYNC_FILE, { create: true }).then(function (fh) {
        return fh.createWritable().then(function (writable) {
          return writable.write(JSON.stringify(payload, null, 2)).then(function () {
            return writable.close();
          });
        });
      });
    });
  }

  function scheduleWrite() {
    if (!dirHandle) return;
    if (typeof global.usesIndexedDbForObjectData === 'function' && !global.usesIndexedDbForObjectData()) return;
    clearTimeout(writeTimer);
    writeTimer = setTimeout(function () {
      writeFile().catch(function (e) { console.warn('[folder-sync] write', e); });
    }, 900);
  }

  function readAndParse() {
    if (!dirHandle) return Promise.reject(new Error('no dir'));
    return dirHandle.getFileHandle(SYNC_FILE, { create: false }).then(function (fh) {
      return fh.getFile().then(function (file) {
        return file.text().then(function (text) { return JSON.parse(text); });
      });
    });
  }

  function importFromFile(toastFn) {
    if (!dirHandle) {
      if (toastFn) toastFn('Choose a folder first.');
      return Promise.resolve();
    }
    return readAndParse()
      .then(function (data) {
        if (!data || typeof data.objectsByView !== 'object') {
          if (toastFn) toastFn('Invalid inout-sync.json');
          return;
        }
        var gv = global.getActiveVaultId;
        if (typeof gv === 'function' && data.vaultId && data.vaultId !== gv()) {
          var msg = 'File vault "' + data.vaultId + '" ≠ active "' + gv() + '". Import anyway?';
          if (global.confirm && !global.confirm(msg)) return;
        }
        var save = global.saveLocalObjectByViewMap;
        if (typeof save !== 'function') return;
        return save(data.objectsByView).then(function () {
          if (typeof global.loadObjects === 'function') return global.loadObjects();
        }).then(function () {
          if (toastFn) toastFn('Imported from folder.');
        });
      })
      .catch(function () {
        if (toastFn) toastFn('Could not read inout-sync.json in this folder.');
      });
  }

  function updateStatusEl() {
    var el = document.getElementById('secret-folder-sync-status');
    if (!el) return;
    if (!dirHandle || !dirHandle.name) {
      el.textContent = 'Not connected';
      return;
    }
    el.textContent = 'Folder: ' + dirHandle.name + ' → ' + SYNC_FILE;
  }

  function connectChooseFolder(toastFn) {
    if (!global.showDirectoryPicker) {
      if (toastFn) toastFn('Folder sync needs a supported browser (e.g. Chrome or Edge on desktop).');
      return Promise.resolve();
    }
    return global.showDirectoryPicker()
      .then(function (h) {
        return h.requestPermission({ mode: 'readwrite' }).then(function (perm) {
          if (perm !== 'granted') {
            if (toastFn) toastFn('Folder access not granted.');
            return;
          }
          dirHandle = h;
          return persistHandle(h).then(function () {
            return dirHandle.getFileHandle(SYNC_FILE, { create: false })
              .then(function () { return true; })
              .catch(function () { return false; });
          }).then(function (exists) {
            if (!exists) {
              return writeFile().then(function () {
                if (toastFn) toastFn('Connected. Created ' + SYNC_FILE + ' from this device.');
              });
            }
            if (toastFn) {
              toastFn('Connected. File exists — use Import to load it, or keep editing; saves update the file.');
            }
          });
        });
      })
      .then(function () { updateStatusEl(); })
      .catch(function (e) {
        if (e && e.name === 'AbortError') return;
        console.error(e);
        if (toastFn) toastFn('Could not open folder.');
      });
  }

  function disconnectFolder(toastFn) {
    dirHandle = null;
    clearTimeout(writeTimer);
    return clearPersistedHandle()
      .then(function () {
        updateStatusEl();
        if (toastFn) toastFn('Folder sync disconnected.');
      })
      .catch(function (e) {
        console.warn(e);
        updateStatusEl();
      });
  }

  function initRestore() {
    if (!global.showDirectoryPicker) return Promise.resolve();
    return loadPersistedHandle()
      .then(function (h) {
        if (!h) return;
        return h.queryPermission({ mode: 'readwrite' }).then(function (q) {
          if (q === 'granted') dirHandle = h;
        });
      })
      .catch(function (e) { console.warn('[folder-sync] restore', e); })
      .then(function () { updateStatusEl(); });
  }

  function wireSecretPanel(toastFn) {
    var btnChoose = document.getElementById('secret-folder-choose');
    var btnPull = document.getElementById('secret-folder-pull');
    var btnDisc = document.getElementById('secret-folder-disconnect');
    if (btnChoose) {
      btnChoose.addEventListener('click', function () {
        connectChooseFolder(toastFn);
      });
    }
    if (btnPull) {
      btnPull.addEventListener('click', function () {
        importFromFile(toastFn);
      });
    }
    if (btnDisc) {
      btnDisc.addEventListener('click', function () {
        disconnectFolder(toastFn);
      });
    }
  }

  global.INOUT_FOLDER_SYNC = {
    scheduleWrite: scheduleWrite,
    initRestore: initRestore,
    wireSecretPanel: wireSecretPanel,
    refreshStatus: updateStatusEl,
  };
})(typeof window !== 'undefined' ? window : this);
