/** Key/value configuration. Values are JSON documents. */
export interface SettingsTable {
  key: string;
  value: string;
  /** Epoch milliseconds. */
  updated_at: number;
}

/** Every table kubitor stores. Later plans extend this interface. */
export interface Database {
  settings: SettingsTable;
}
