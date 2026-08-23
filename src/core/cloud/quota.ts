/** Shared so the lazy wrapper can answer `quota` without loading the client. */
export const CLOUD_QUOTA = { maxTotalBytes: 512 * 1024 * 1024, shareTtlDays: 7 }
