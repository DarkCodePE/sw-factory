import { close, fchmod, fstat, fsync, read, writeFile, type Stats } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { getSystemErrorName } from 'node:util';

interface NativeFs {
  openAt(parent: number, name: string, flags: number, mode: number): number;
  mkdirAt(parent: number, name: string, mode: number): number;
  renameAt(parent: number, from: string, to: string): number;
  unlinkAt(parent: number, name: string): number;
}
export interface CapabilityHandle {
  readonly fd: number;
  stat(): Promise<Stats>;
  read(buffer: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesRead: number; buffer: Buffer }>;
  writeFile(data: string | Uint8Array): Promise<void>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
function adoptDescriptor(fd: number): CapabilityHandle {
  let closing: Promise<void> | undefined, descriptor = fd;
  const active = () => { if (closing || descriptor < 0) throw Object.assign(new Error('Descriptor closed'), { code: 'EBADF' }); return descriptor; };
  return {
    get fd() { return descriptor; },
    stat: () => new Promise((resolve, reject) => fstat(active(), (error, value) => error ? reject(error) : resolve(value))),
    read: (buffer, offset, length, position) => new Promise((resolve, reject) => read(active(), buffer, offset, length, position, (error, bytesRead) => error ? reject(error) : resolve({ bytesRead, buffer }))),
    writeFile: data => new Promise((resolve, reject) => writeFile(active(), data, error => error ? reject(error) : resolve())),
    chmod: mode => new Promise((resolve, reject) => fchmod(active(), mode, error => error ? reject(error) : resolve())),
    sync: () => new Promise((resolve, reject) => fsync(active(), error => error ? reject(error) : resolve())),
    close() {
      if (!closing) closing = new Promise((resolve, reject) => close(descriptor, error => { descriptor = -1; error ? reject(error) : resolve(); }));
      return closing;
    },
  };
}
let library: NativeFs | undefined;
const native = () => library ??= require('./native/posix.node') as NativeFs;
function component(name: string) {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw new Error('Invalid file capability component');
  return name;
}
const descriptorPath = (parent: CapabilityHandle, name: string) => `/proc/self/fd/${parent.fd}/${component(name)}`;
function checked(value: number, operation: string) {
  if (value < 0) throw Object.assign(new Error(`${operation}: ${getSystemErrorName(value)}`), { code: getSystemErrorName(value), errno: value });
  return value;
}
export async function openRelative(parent: CapabilityHandle, name: string, flags: number, mode = 0o600): Promise<CapabilityHandle> {
  component(name);
  if (process.platform !== 'darwin') return open(descriptorPath(parent, name), flags, mode);
  // Node's fd APIs operate directly on the openat descriptor; no path is reopened.
  return adoptDescriptor(checked(native().openAt(parent.fd, name, flags, mode), 'openat'));
}
export async function mkdirRelative(parent: CapabilityHandle, name: string) {
  component(name);
  if (process.platform === 'darwin') checked(native().mkdirAt(parent.fd, name, 0o755), 'mkdirat');
  else await mkdir(descriptorPath(parent, name));
}
export async function renameRelative(parent: CapabilityHandle, from: string, to: string) {
  component(from); component(to);
  if (process.platform === 'darwin') checked(native().renameAt(parent.fd, from, to), 'renameat');
  else await rename(descriptorPath(parent, from), descriptorPath(parent, to));
}
export async function unlinkRelative(parent: CapabilityHandle, name: string) {
  component(name);
  if (process.platform === 'darwin') checked(native().unlinkAt(parent.fd, name), 'unlinkat');
  else await unlink(descriptorPath(parent, name));
}
