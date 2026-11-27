
/*
 * Interactive WASI host for Clang in the browser.
 *
 * Adapted for C Compiler Studio.
 * Supports asynchronous terminal input using JSPI.
 */

export function createWasi({ args = ['main'], write = () => {} } = {}) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let memory = null;
  let inputBuffer = [];
  let inputWaiters = [];
  let inputClosed = false;

  const encoders = new Map();

  class WasiExit extends Error {
    constructor(code) {
      super(`Program exited with code ${code}`);
      this.code = code;
    }
  }

  function getMemory() {
    if (!memory) throw new Error('WASM memory is not ready.');
    return new DataView(memory.buffer);
  }

  function wakeInput() {
    while (inputWaiters.length > 0) {
      const waiter = inputWaiters.shift();
      waiter();
    }
  }

  function pushInput(text) {
    if (inputClosed) return;

    const bytes = encoder.encode(String(text));
    inputBuffer.push(...bytes);
    wakeInput();
  }

  function closeInput() {
    inputClosed = true;
    wakeInput();
  }

  async function readInput() {
    while (inputBuffer.length === 0 && !inputClosed) {
      await new Promise(resolve => inputWaiters.push(resolve));
    }

    if (inputBuffer.length === 0) return null;

    return inputBuffer.shift();
  }

  function fdRead(fd, iovs, iovsLen, nread) {
    return (async () => {
      if (fd !== 0) return 8;

      const view = getMemory();
      let total = 0;

      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);

        let count = 0;

        while (count < len) {
          const byte = await readInput();

          if (byte === null) break;

          new Uint8Array(memory.buffer)[ptr + count] = byte;
          count++;
          total++;
        }

        if (count < len) break;
      }

      getMemory().setUint32(nread, total, true);
      return 0;
    })();
  }

  function fdWrite(fd, iovs, iovsLen, nwritten) {
    if (fd !== 1 && fd !== 2) return 8;

    const view = getMemory();
    const chunks = [];

    let total = 0;

    for (let i = 0; i < iovsLen; i++) {
      const ptr = view.getUint32(iovs + i * 8, true);
      const len = view.getUint32(iovs + i * 8 + 4, true);

      const bytes = new Uint8Array(memory.buffer, ptr, len);
      let text = encoders.get(fd);

      if (!text) {
        text = new TextDecoder();
        encoders.set(fd, text);
      }

      chunks.push(text.decode(bytes, { stream: true }));
      total += len;
    }

    if (chunks.length) write(fd, chunks.join(''));

    getMemory().setUint32(nwritten, total, true);
    return 0;
  }

  function argsSizesGet(argc, argvBufSize) {
    const view = getMemory();
    const strings = args.map(arg => encoder.encode(arg + '\0'));

    view.setUint32(argc, strings.length, true);
    view.setUint32(
      argvBufSize,
      strings.reduce((sum, item) => sum + item.length, 0),
      true
    );

    return 0;
  }

  function argsGet(argv, argvBuf) {
    const view = getMemory();
    let offset = argvBuf;

    args.forEach((arg, index) => {
      const bytes = encoder.encode(arg + '\0');
      view.setUint32(argv + index * 4, offset, true);
      new Uint8Array(memory.buffer).set(bytes, offset);
      offset += bytes.length;
    });

    return 0;
  }

  function environSizesGet(count, size) {
    const view = getMemory();
    view.setUint32(count, 0, true);
    view.setUint32(size, 0, true);
    return 0;
  }

  function environGet() {
    return 0;
  }

  function fdClose() {
    return 0;
  }

  function fdSeek(fd, offset, whence, newOffset) {
    if (fd <= 2) return 70;

    getMemory().setBigUint64(newOffset, 0n, true);
    return 0;
  }

  function fdFdstatGet(fd, result) {
    if (fd > 2) return 8;

    const view = getMemory();

    new Uint8Array(memory.buffer, result, 24).fill(0);

    view.setUint8(result, 2);
    view.setBigUint64(result + 8, 0n, true);
    view.setBigUint64(result + 16, 0n, true);

    return 0;
  }

  function clockTimeGet(clockId, precision, time) {
    const now = BigInt(Date.now()) * 1000000n;
    getMemory().setBigUint64(time, now, true);
    return 0;
  }

  function randomGet(ptr, len) {
    const target = new Uint8Array(memory.buffer, ptr, len);

    for (let i = 0; i < len; i += 65536) {
      crypto.getRandomValues(target.subarray(i, Math.min(i + 65536, len)));
    }

    return 0;
  }

  function procExit(code) {
    throw new WasiExit(code);
  }

  const imports = {
    wasi_snapshot_preview1: {
      args_sizes_get: argsSizesGet,
      args_get: argsGet,
      environ_sizes_get: environSizesGet,
      environ_get: environGet,

      fd_read: new WebAssembly.Suspending(fdRead),
      fd_write: fdWrite,
      fd_close: fdClose,
      fd_seek: fdSeek,
      fd_fdstat_get: fdFdstatGet,

      clock_time_get: clockTimeGet,
      random_get: randomGet,
      proc_exit: procExit,

      sched_yield: () => 0,

      fd_sync: () => 0,
      fd_datasync: () => 0,
      fd_advise: () => 0,
      fd_allocate: () => 0,
      fd_filestat_get: () => 8,
      fd_prestat_get: () => 8,
      fd_prestat_dir_name: () => 8,

      path_open: () => 44,
      path_filestat_get: () => 44,
      path_create_directory: () => 44,
      path_unlink_file: () => 44,
      path_remove_directory: () => 44,
      path_rename: () => 44,
    }
  };

  async function start(instance) {
    memory = instance.exports.memory;

    if (!memory) {
      throw new Error('Program does not export WASM memory.');
    }

    try {
      const run = WebAssembly.promising(instance.exports._start);
      await run();
      return 0;
    } catch (error) {
      if (error instanceof WasiExit) {
        return error.code;
      }

      throw error;
    } finally {
      for (const [fd, textDecoder] of encoders) {
        const remaining = textDecoder.decode();
        if (remaining) write(fd, remaining);
      }

      encoders.clear();
    }
  }

  return {
    imports,
    start,
    pushInput,
    closeInput
  };
}
      
