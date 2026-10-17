/** Executed inside the VM. Nothing returned to user code is a host object/function. */
export const BOOTSTRAP = String.raw`
(() => {
  'use strict';
  const host = globalThis.__scriptBootstrap;
  delete globalThis.__scriptBootstrap;
  const parse = JSON.parse.bind(JSON);
  const stringify = JSON.stringify.bind(JSON);
  const create = Object.create.bind(Object);
  const define = Object.defineProperty.bind(Object);
  const freeze = Object.freeze.bind(Object);
  const keys = Object.keys.bind(Object);
  const own = Object.hasOwn.bind(Object);
  const S = String, E = Error, T = TypeError, R = RangeError;
  const isFinite = Number.isFinite.bind(Number);
  const promise = Promise.resolve.bind(Promise);
  const then = Function.prototype.call.bind(Promise.prototype.then);
  const bindings = parse(globalThis.__scriptBindings);
  delete globalThis.__scriptBindings;
  const pending = new Map();
  const timers = new Map();
  let nextCall = 0, nextTimer = 0;

  function send(frame) {
    const error = host(stringify(frame));
    if (error !== null) throw new E(error);
  }
  function message(error) {
    try { return error instanceof E ? S(error.message) : S(error); }
    catch { return 'Unknown program error'; }
  }
  function fail(error) {
    send({ type: 'program_error', message: message(error) });
  }
  function display(value) {
    if (typeof value === 'string') return value;
    const encoded = stringify(value);
    return encoded === undefined ? S(value) : encoded;
  }
  function callTool(toolName, input) {
    return new Promise((resolve, reject) => {
      const toolUseId = 'tool-' + (++nextCall);
      pending.set(toolUseId, { resolve, reject });
      try { send({ type: 'tool_call', toolUseId, toolName, input: input === undefined ? null : input }); }
      catch (error) { pending.delete(toolUseId); reject(error); }
    });
  }
  const tree = create(null);
  for (const binding of bindings) {
    let node = tree;
    for (let i = 0; i < binding.path.length; i++) {
      const key = binding.path[i];
      if (i === binding.path.length - 1) {
        node[key] = (input) => callTool(binding.toolName, input);
      } else {
        if (!own(node, key)) node[key] = create(null);
        node = node[key];
      }
    }
  }
  function guard(node) {
    for (const key of keys(node)) {
      if (typeof node[key] !== 'function') node[key] = guard(node[key]);
      else freeze(node[key]);
    }
    return new Proxy(freeze(node), {
      get(target, key) {
        if (typeof key === 'symbol') return undefined;
        if (!own(target, key)) throw new T('Unknown Script tool binding');
        return target[key];
      },
    });
  }
  function expose(name, value) {
    define(globalThis, name, { value, writable: false, configurable: false });
  }
  // Standard ECMAScript intrinsics stay in this realm; runtime/host globals do not.
  for (const name of ['require', 'process', 'Bun', 'module', 'exports', 'global',
      'fetch', 'WebAssembly', 'SharedArrayBuffer', 'Atomics']) expose(name, undefined);
  expose('tools', guard(tree));
  expose('text', (value) => send({ type: 'content', content: { type: 'text', text: display(value) } }));
  expose('image', (mime, data) => {
    if ((mime !== 'image/png' && mime !== 'image/jpeg') || typeof data !== 'string' ||
        !data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      throw new T('image() requires PNG/JPEG and canonical base64');
    }
    send({ type: 'content', content: { type: 'image', mime, data } });
  });
  expose('notify', (value) => {
    if (typeof value !== 'string' || !value.trim()) throw new T('notify() requires non-empty text');
    send({ type: 'notify', message: value });
  });
  const capturedConsole = create(null);
  for (const name of ['log', 'info', 'warn', 'error', 'debug', 'dir', 'trace']) {
    capturedConsole[name] = (...args) => send({
      type: 'content', content: { type: 'text', text: args.map(display).join(' ') },
    });
  }
  expose('console', freeze(capturedConsole));
  expose('setTimeout', (callback, delay = 0, ...args) => {
    if (typeof callback !== 'function') throw new T('setTimeout requires a callback');
    if (typeof delay !== 'number' || !isFinite(delay) || delay < 0 || delay > 86400000) {
      throw new R('Script timer delay must be in 0..86400000 ms');
    }
    const timerId = ++nextTimer;
    timers.set(timerId, { callback, args });
    try { send({ type: 'schedule_timer', timerId, delay }); }
    catch (error) { timers.delete(timerId); throw error; }
    return timerId;
  });
  return freeze({
    observe(value) {
      then(promise(value), output => {
        try { send({ type: 'program_complete', output: output === undefined ? null : output }); }
        catch (error) { fail(error); }
      }, fail);
    },
    deliver(encoded) {
      const result = parse(encoded);
      const call = pending.get(result.toolUseId);
      if (!call) return;
      pending.delete(result.toolUseId);
      if (result.isError) call.reject(new E(display(result.content)));
      else call.resolve(result.content);
    },
    fire(timerId) {
      const timer = timers.get(timerId);
      if (!timer) return;
      timers.delete(timerId);
      try {
        then(promise(timer.callback(...timer.args)),
          () => send({ type: 'timer_done', timerId }), fail);
      } catch (error) { fail(error); }
    },
  });
})()
`;
