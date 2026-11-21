// Nombre de inventario compartido entre SQLite y los perfiles inmutables.
export const isRunnerName = (name: string): boolean => /^[a-z0-9][a-z0-9-]{0,40}$/.test(name);
