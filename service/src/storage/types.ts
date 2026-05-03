export type StorageDriver = "memory" | "sqlite" | "postgres";

export interface StorageAdapterLifecycle {
  readonly driver: StorageDriver;
  close(): Promise<void>;
}

export interface TransactionalStorage {
  withTransaction<T>(operation: () => Promise<T>): Promise<T>;
}

export type StorageJsonValue =
  | null
  | boolean
  | number
  | string
  | bigint
  | readonly StorageJsonValue[]
  | { readonly [key: string]: StorageJsonValue | undefined };
