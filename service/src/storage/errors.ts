export class StorageError extends Error {
  override readonly name: string = "StorageError";
}

export class StorageConstraintError extends StorageError {
  override readonly name = "StorageConstraintError";
}

export class StorageMigrationError extends StorageError {
  override readonly name = "StorageMigrationError";
}

export class StorageUnsupportedError extends StorageError {
  override readonly name = "StorageUnsupportedError";
}

export class StorageUnavailableError extends StorageError {
  override readonly name = "StorageUnavailableError";
}
