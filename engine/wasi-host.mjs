
/*
 * Interactive WASI Preview 1 host.
 * Supports asynchronous stdin using WebAssembly JSPI.
 *
 * Adapted for C Compiler Studio.
 * Based on the MIT-licensed tiny-wasi-host project.
 */

export function createWasi({ args = [], write = () => {} } = {}) {
  let memory = null;
  let inputBuffer = new Uint8Array(0);
  let inputClosed = false;
  const inputWaiters = [];

  const encoder = new TextEncoder();
  const decoders = {
    1: new TextDecoder(),
    2: new TextDecoder()
  };

  class WasiExit extends Error {
    constructor(code) {
      super("WASI process exited");
      this.code = code;
    }
  }

  function getView() {
    if (!memory) throw new Error("WASM memory is not ready");
    return new DataView(memory.buffer);
  }

  function provideInput(value) {
    if (inputClosed) return;

    const bytes = encoder.encode(String(value));
    if (!bytes.length) return;

    const combined = new Uint8Array(inputBuffer.length + bytes.length);
    combined.set(inputBuffer);
    combined.set(bytes, inputBuffer.length);
    inputBuffer = combined;

    while (inputWaiters.length) {
      inputWaiters.shift()();
    }
  }

  function closeInput() {
    inputClosed = true;
    while (inputWaiters.length) {
      inputWaiters.shift()();
    }
  }

  async function readInput(maxBytes) {
    while (inputBuffer.length === 0 && !inputClosed) {
      await new Promise(resolve => inputWaiters.push(resolve));
    }

    const count = Math.min(maxBytes, inputBuffer.length);
    const result = inputBuffer.slice(0, count);
    inputBuffer = inputBuffer.slice(count);
    return result;
  }

  function fd_write(fd, iovs, iovsLen, nwritten) {
    if (fd !== 1 && fd !== 2) return 8;

    const view = getView();
    const decoder = decoders[fd];
    let total = 0;

    for (let i = 0; i < iovsLen; i++) {
      const ptr = view.getUint32(iovs + i * 8, true);
      const len = view.getUint32(iovs + i * 8 + 4, true);

      const bytes = new Uint8Array(memory.buffer, ptr, len);
      const text = decoder.decode(bytes, { stream: true });

      if (text) write(fd === 1 ? "stdout" : "stderr", text);
      total += len;
    }

    view.setUint32(nwritten, total, true);
    return 0;
  }

  async function fd_read(fd, iovs, iovsLen, nread) {
    if (fd !== 0) return 8;

    let view = getView();
    let totalCapacity = 0;
    const buffers = [];

    for (let i = 0; i < iovsLen; i++) {
      const ptr = view.getUint32(iovs + i * 8, true);
      const len = view.getUint32(iovs + i * 8 + 4, true);
      buffers.push({ ptr, len });
      totalCapacity += len;
    }

    const bytes = await readInput(totalCapacity);

    // Reacquire memory after awaiting input.
    view = getView();

    let offset = 0;

    for (const buffer of buffers) {
      const count = Math.min(
        buffer.len,
        bytes.length - offset
      );

      if (count <= 0) break;

      new Uint8Array(
        memory.buffer,
        buffer.ptr,
        count
      ).set(bytes.subarray(offset, offset + count));

      offset += count;
    }

    view.setUint32(nread, offset, true);
    return 0;
  }

  function args_sizes_get(argc, argvBufSize) {
    const view = getView();
    const strings = args.map(String);

    view.setUint32(argc, strings.length, true);

    const size = strings.reduce(
      (sum, item) => sum + encoder.encode(item).length + 1,
      0
    );

    view.setUint32(argvBufSize, size, true);
    return 0;
  }

  function args_get(argv, argvBuf) {
    const view = getView();
    let offset = argvBuf;

    args.map(String).forEach((item, i) => {
      const bytes = encoder.encode(item);
      view.setUint32(argv + i * 4, offset, true);

      new Uint8Array(memory.buffer, offset, bytes.length).set(bytes);
      new Uint8Array(memory.buffer)[offset + bytes.length] = 0;

      offset += bytes.length + 1;
    });

    return 0;
  }

  function environ_sizes_get(countPtr, sizePtr) {
    const view = getView();
    view.setUint32(countPtr, 0, true);
    view.setUint32(sizePtr, 0, true);
    return 0;
  }

  function environ_get() {
    return 0;
  }

  function fd_close() {
    return 0;
  }

  function fd_fdstat_get(fd, ptr) {
    const view = getView();

    view.setUint8(ptr, 2);
    view.setUint16(ptr + 2, 0, true);
    view.setBigUint64(ptr + 8, 0n, true);
    view.setBigUint64(ptr + 16, 0n, true);

    return 0;
  }

  function fd_seek() {
    return 70;
  }

  function clock_time_get(id, precision, ptr) {
    const view = getView();

    const time = id === 0
      ? BigInt(Date.now()) * 1000000n
      : BigInt(Math.floor(performance.now() * 1000000));

    view.setBigUint64(ptr, time, true);
    return 0;
  }

  function random_get(ptr, len) {
    const bytes = new Uint8Array(memory.buffer, ptr, len);

    for (let offset = 0; offset < len; offset += 65536) {
      crypto.getRandomValues(
        bytes.subarray(offset, Math.min(offset + 65536, len))
      );
    }

    return 0;
  }

  function sched_yield() {
    return 0;
  }

  function proc_exit(code) {
    throw new WasiExit(code);
  }

  const wasi = {
    args_sizes_get,
    args_get,
    environ_sizes_get,
    environ_get,
    fd_read,
    fd_write,
    fd_close,
    fd_fdstat_get,
    fd_seek,
    clock_time_get,
    random_get,
    sched_yield,
    proc_exit
  };

  // JSPI allows WASM to pause while waiting for keyboard input.
  const imports = {
    wasi_snapshot_preview1: {
      ...wasi,
      fd_read: new WebAssembly.Suspending(fd_read)
    }
  };

  async function start(instance) {
    memory = instance.exports.memory;

    if (!memory) {
      throw new Error("WASM memory export not found");
    }

    const promisingStart = WebAssembly.promising(
      instance.exports._start
    );

    try {
      await promisingStart();
      return 0;
    } catch (error) {
      if (error instanceof WasiExit) {
        return error.code;
      }
      throw error;
    }
  }

  return {
    imports,
    start,
    provideInput,
    closeInput
  };
      }
    
