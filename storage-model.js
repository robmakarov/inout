/**
 * INOUT unified storage model (v1)
 *
 * Principle: every object and every view has a row in *some* database.
 * - Cloud: Supabase Postgres (`entries`, `views`, …) is authoritative for signed-in
 *   and for shared / guest sessions (RLS + temp_session_id).
 * - Local: IndexedDB (`inout_local_store_v1`) is the device database for anonymous
 *   users — same logical shape as cloud rows so export/import and future sync stay trivial.
 *
 * Interop: other users can only read/write the same logical store when the backend
 * is shared and ACL allows it (cloud + visit link / membership). Local-only data on
 * a device is not visible to others until replicated to a shared store (e.g. sign-in
 * or future “publish space”).
 */
(function (global) {
  var STORAGE_MODEL_VERSION = 1;

  /**
   * @typedef {'cloud_authoritative'|'cloud_shared_guest'|'local_authoritative'} StorageAuthority
   */

  /**
   * @param {{ currentUser: object|null, tempSessionId: string|null }} s
   * @returns {{ authority: StorageAuthority, backend: string, interoperable: boolean, note: string }}
   */
  function describeStorageContext(s) {
    var u = s && s.currentUser;
    var t = s && s.tempSessionId;
    if (t) {
      return {
        authority: 'cloud_shared_guest',
        backend: 'supabase',
        interoperable: true,
        note: 'Same Postgres + RLS as owner; guests see channel by temp session.',
      };
    }
    if (u) {
      return {
        authority: 'cloud_authoritative',
        backend: 'supabase',
        interoperable: true,
        note: 'Objects/views in Supabase; sharing via views + visit links.',
      };
    }
    return {
      authority: 'local_authoritative',
      backend: 'indexeddb',
      interoperable: false,
      note: 'Device DB only; export JSON or sign in to share with others.',
    };
  }

  global.INOUT_STORAGE = {
    STORAGE_MODEL_VERSION: STORAGE_MODEL_VERSION,
    describeStorageContext: describeStorageContext,
  };
})(typeof window !== 'undefined' ? window : this);
