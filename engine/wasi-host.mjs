
/*
 * Interactive WASI host for Clang in the browser.
 *
 * Adapted for C Compiler Studio.
 * Supports asynchronous terminal input using WebAssembly JSPI.
 */

export function createWasi({
  args = ['main'],
  write = () => {},
  onInputRequest = () => {}
} = {}) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let memory = null;
  let inputBuffer = [];
  let inputWaiters = [];
  let inputClosed = false;

  function getMemory() {
    return new DataView(memory.buffer);
  }

  function wakeInputWaiters() {
    const waiters = inputWaiters;
    inputWaiters = [];

    for (const resolve of waiters) {
      resolve();
    }
  }

  function pushInput(text) {
    if (inputClosed) return;

    const bytes = encoder.encode(text);

    for (const byte of bytes) {
      inputBuffer.push(byte);
    }

    wakeInputWaiters();
  }

  function closeInput() {
    inputClosed = true;
    wakeInputWaiters();
  }

  function fdWrite(fd, iovs, iovsLen, nwritten) {
    const view = getMemory();
    let total = 0;

    for (let i = 0; i < iovsLen; i++) {
      const ptr = view.getUint32(iovs + i * 8, true);
      const len = view.getUint32(iovs + i * 8 + 4, true);

      const bytes = new Uint8Array(memory.buffer, ptr, len);

      write(fd, decoder.decode(bytes));

      total += len;
    }

    getMemory().setUint32(nwritten, total, true);
    return 0;
  }

  async function fdRead(fd, iovs, iovsLen, nread) {
    if (fd !== 0) return 8;

    // Tell the webpage that the C program needs input.
    if (inputBuffer.length === 0 && !inputClosed) {
      onInputRequest();

      // Wait until the user submits input.
      while (inputBuffer.length === 0 && !inputClosed) {
        await new Promise(resolve => inputWaiters.push(resolve));
      }
    }

    const view = getMemory();
    let total = 0;

    // Copy available input into WASI memory.
    for (let i = 0; i < iovsLen; i++) {
      const ptr = view.getUint32(iovs + i * 8, true);
      const len = view.getUint32(iovs + i * 8 + 4, true);

      let count = 0;

      while (count < len && inputBuffer.length > 0) {
        const byte = inputBuffer.shift();

        new Uint8Array(memory.buffer)[ptr + count] = byte;

        count++;
        total++;
      }

      if (count < len) break;
    }

    getMemory().setUint32(nread, total, true);
    return 0;
  }

  function fdClose() {
    return 0;
  }

  function fdSeek() {
    return 70;
  }

  function fdFdstatGet(fd, ptr) {
    const view = getMemory();

    view.setUint8(ptr, fd <= 2 ? 2 : 0);
    view.setUint16(ptr + 2, 0, true);
    view.setUint16(ptr + 4, 0, true);
    view.setUint16(ptr + 6, 0, true);
    view.setUint16(ptr + 8, 0, true);
    view.setUint16(ptr + 10, 0, true);
    view.setUint16(ptr + 12, 0, true);

    return 0;
  }

  function clockTimeGet(id, precision, timePtr) {
    const view = getMemory();
    const now = BigInt(Date.now()) * 1000000n;

    view.setBigUint64(timePtr, now, true);
    return 0;
  }

  function randomGet(ptr, len) {
    const bytes = new Uint8Array(memory.buffer, ptr, len);

    for (let offset = 0; offset < len; offset += 65536) {
      crypto.getRandomValues(
        bytes.subarray(offset, Math.min(offset + 65536, len))
      );
    }

    return 0;
  }

  const wasiImport = {
    args_sizes_get(argc, argvBufSize) {
      const view = getMemory();

      view.setUint32(argc, args.length, true);

      const size = args.reduce(
        (sum, arg) => sum + encoder.encode(arg).length + 1,
        0
      );

      view.setUint32(argvBufSize, size, true);
      return 0;
    },

    args_get(argv, argvBuf) {
      const view = getMemory();
      let offset = argvBuf;

      args.forEach((arg, i) => {
        const bytes = encoder.encode(arg);

        view.setUint32(argv + i * 4, offset, true);

        new Uint8Array(memory.buffer, offset, bytes.length).set(bytes);
        new Uint8Array(memory.buffer)[offset + bytes.length] = 0;

        offset += bytes.length + 1;
      });

      return 0;
    },

    environ_sizes_get(count, size) {
      const view = getMemory();

      view.setUint32(count, 0, true);
      view.setUint32(size, 0, true);

      return 0;
    },

    environ_get() {
      return 0;
    },

    fd_write: fdWrite,

    // JSPI is required for asynchronous terminal input.
    fd_read: new WebAssembly.Suspending(fdRead),

    fd_close: fdClose,
    fd_seek: fdSeek,
    fd_fdstat_get: fdFdstatGet,

    clock_time_get: clockTimeGet,
    random_get: randomGet,

    proc_exit(code) {
      throw new Error(`Program exited with code ${code}`);
    },

    sched_yield() {
      return 0;
    }
  };

  return {
    imports: {
      wasi_snapshot_preview1: wasiImport
    },

    setMemory(wasmMemory) {
      memory = wasmMemory;
    },

    async start(wasmInstance) {
      const startFunction = wasmInstance.exports._start;

      if (typeof WebAssembly.promising !== 'function') {
        throw new Error('WebAssembly JSPI is not supported.');
      }

      const promisingStart = WebAssembly.promising(startFunction);

      return await promisingStart();
    },

    pushInput,
    closeInput
  };
}
