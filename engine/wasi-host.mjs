
/*
 * Interactive WASI host for C/C++ programs running in WebAssembly.
 * Uses JSPI to pause a program while it waits for terminal input.
 *
 * Based on tiny-wasi-host (MIT):
 * https://github.com/devtoolry/tiny-wasi-host
 */

const ESUCCESS = 0;
const EBADF = 8;
const EINVAL = 28;
const ENOSYS = 52;
const ESPIPE = 70;

export class WasiExit extends Error {
  constructor(code) {
    super(`exit(${code})`);
    this.code = code;
  }
}

export function createWasi({ args = ["main"], write }) {
  let memory = null;
  let inputBuffer = [];
  let inputWaiters = [];
  let inputClosed = false;

  const encoder = new TextEncoder();
  const decoders = {
    1: new TextDecoder(),
    2: new TextDecoder()
  };

  const argBytes = args.map(arg => encoder.encode(`${arg}\0`));

  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);

  function iovecs(ptr, count) {
    const dv = view();
    const list = [];

    for (let i = 0; i < count; i++) {
      list.push([
        dv.getUint32(ptr + i * 8, true),
        dv.getUint32(ptr + i * 8 + 4, true)
      ]);
    }

    return list;
  }

  function writeStrings(list, ptrs, buffer) {
    const dv = view();
    let offset = buffer;

    list.forEach((item, i) => {
      dv.setUint32(ptrs + i * 4, offset, true);
      bytes().set(item, offset);
      offset += item.length;
    });

    return ESUCCESS;
  }

  function pushInput(text) {
    if (inputClosed) return;

    const encoded = encoder.encode(String(text));

    for (const byte of encoded) {
      inputBuffer.push(byte);
    }

    while (inputWaiters.length && inputBuffer.length) {
      inputWaiters.shift()();
    }
  }

  function closeInput() {
    inputClosed = true;

    while (inputWaiters.length) {
      inputWaiters.shift()();
    }
  }

  async function waitForInput() {
    while (inputBuffer.length === 0 && !inputClosed) {
      await new Promise(resolve => inputWaiters.push(resolve));
    }
  }

  async function readInput(ptr, length) {
    await waitForInput();

    const count = Math.min(length, inputBuffer.length);

    for (let i = 0; i < count; i++) {
      bytes()[ptr + i] = inputBuffer.shift();
    }

    return count;
  }

  const wasi = {
    args_sizes_get(countPtr, sizePtr) {
      view().setUint32(countPtr, argBytes.length, true);
      view().setUint32(
        sizePtr,
        argBytes.reduce((sum, item) => sum + item.length, 0),
        true
      );
      return ESUCCESS;
    },

    args_get: (ptrs, buffer) =>
      writeStrings(argBytes, ptrs, buffer),

    environ_sizes_get(countPtr, sizePtr) {
      view().setUint32(countPtr, 0, true);
      view().setUint32(sizePtr, 0, true);
      return ESUCCESS;
    },

    environ_get: () => ESUCCESS,

    fd_write(fd, iovs, count, writtenPtr) {
      if (fd !== 1 && fd !== 2) return EBADF;

      let written = 0;

      for (const [ptr, length] of iovecs(iovs, count)) {
        const chunk = bytes().subarray(ptr, ptr + length);

        write(
          fd,
          decoders[fd].decode(chunk, { stream: true })
        );

        written += length;
      }

      view().setUint32(writtenPtr, written, true);
      return ESUCCESS;
    },

    async fd_read(fd, iovs, count, readPtr) {
      if (fd !== 0) return EBADF;

      let totalRead = 0;

      for (const [ptr, length] of iovecs(iovs, count)) {
        const amount = await readInput(ptr, length);
        totalRead += amount;

        if (amount < length || amount === 0) break;
      }

      view().setUint32(readPtr, totalRead, true);
      return ESUCCESS;
    },

    fd_fdstat_get(fd, ptr) {
      if (fd > 2) return EBADF;

      const dv = view();
      dv.setUint8(ptr, 2);
      dv.setUint16(ptr + 2, 0, true);
      dv.setBigUint64(ptr + 8, 0n, true);
      dv.setBigUint64(ptr + 16, 0n, true);

      return ESUCCESS;
    },

    fd_close: fd => fd <= 2 ? ESUCCESS : EBADF,
    fd_seek: fd => fd <= 2 ? ESPIPE : EBADF,

    fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF,

    clock_res_get(id, ptr) {
      view().setBigUint64(ptr, 1000n, true);
      return ESUCCESS;
    },

    clock_time_get(id, precision, ptr) {
      if (id > 3) return EINVAL;

      const ns = id === 0
        ? BigInt(Date.now()) * 1000000n
        : BigInt(Math.round(performance.now() * 1000000));

      view().setBigUint64(ptr, ns, true);
      return ESUCCESS;
    },

    random_get(ptr, length) {
      for (let offset = 0; offset < length; offset += 65536) {
        crypto.getRandomValues(
          bytes().subarray(
            ptr + offset,
            ptr + Math.min(length, offset + 65536)
          )
        );
      }

      return ESUCCESS;
    },

    sched_yield: () => ESUCCESS,

    proc_exit(code) {
      throw new WasiExit(code);
    }
  };

  // JSPI allows WASI fd_read to wait for terminal input
  // without blocking the worker's message handling.
  const imports = {
    wasi_snapshot_preview1: new Proxy(wasi, {
      get(target, name) {
        if (name === "fd_read") {
          return new WebAssembly.Suspending(target.fd_read);
        }

        return target[name] ?? (() => ENOSYS);
      }
    })
  };

  async function start(instance) {
    memory = instance.exports.memory;

    try {
      const run = WebAssembly.promising(instance.exports._start);
      return await run();
    } catch (error) {
      if (error instanceof WasiExit) {
        return error.code;
      }

      throw error;
    } finally {
      for (const fd of [1, 2]) {
        const rest = decoders[fd].decode();
        if (rest) write(fd, rest);
      }
    }
  }

  return {
    imports,
    start,
    pushInput,
    closeInput
  };
}
