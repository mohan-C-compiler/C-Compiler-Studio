
/*
 * Interactive Clang-in-browser worker.
 *
 * Adapted from cpp-forge / clang-in-browser.
 * Original project:
 * https://github.com/nothing12-glitch/cpp-forge
 *
 * Preserve the original MIT license notices.
 */

import { createWasi } from './wasi-host.mjs';

const CLANG_BASE = 'https://cdn.jsdelivr.net/npm/@yowasp/clang@21.1.4-3/';
const MAX_OUTPUT_CHARS = 200000;

const LANGUAGES = {
  c: {
    driver: 'clang',
    file: 'main.c',
    flags: ['-std=c17', '-O2', '-Wall'],
    libs: ['-lm']
  },
  cpp: {
    driver: 'clang++',
    file: 'main.cpp',
    flags: ['-std=c++20', '-O2', '-Wall'],
    libs: ['eh.o']
  }
};

const C_STANDARDS = new Set(['c89', 'c99', 'c11', 'c17', 'c23']);

const ASSETS = new URL('../assets/', import.meta.url);
const PCH = 'cxx20-o2';

const PCH_TROUBLE =
  /precompiled|cxx20-o2|redefinition|conflicting|ambiguous|different kind of symbol/i;

let toolchain = null;
let runtime = null;
let pchFiles = null;
let pchReady = null;

let activeWasi = null;
let isRunning = false;

let written = 0;
let reported = 0;

function emit(stream, text) {
  if (!text || written >= MAX_OUTPUT_CHARS) return;

  const remaining = MAX_OUTPUT_CHARS - written;

  if (text.length > remaining) {
    text = text.slice(0, remaining) + '\n[Output truncated]\n';
  }

  written += text.length;

  self.postMessage({
    type: 'output',
    stream,
    text
  });
}

function progress({ totalLength, doneLength }) {
  if (!totalLength) return;

  const quarter = Math.floor((4 * doneLength) / totalLength);

  if (quarter > reported && quarter < 4) {
    emit('system', `Downloaded ${quarter * 25}%...\n`);
  }

  reported = Math.max(reported, quarter);
}

function lineBuffered(stream, buffer) {
  const decoder = new TextDecoder();

  const send = text =>
    buffer ? text && buffer.push([stream, text]) : emit(stream, text);

  let pending = '';

  const write = data => {
    if (!data) return;

    pending += decoder.decode(data, { stream: true });

    const end = pending.lastIndexOf('\n') + 1;

    if (end > 0) {
      send(pending.slice(0, end));
      pending = pending.slice(end);
    }
  };

  write.end = () => send(pending + decoder.decode());

  return write;
}

async function clang(driver, args, files, buffer) {
  const stdout = lineBuffered('system', buffer);
  const stderr = lineBuffered('stderr', buffer);

  try {
    return await toolchain.commands[driver](
      args,
      files,
      {
        stdout,
        stderr,
        decodeASCII: false,
        fetchProgress: progress
      }
    );
  } catch (error) {
    if (error instanceof toolchain.Exit) return null;
    throw error;
  } finally {
    stdout.end();
    stderr.end();
  }
}

async function fetchBytes(name) {
  const response = await fetch(new URL(name, ASSETS));

  if (!response.ok) {
    throw new Error(`${name}: HTTP ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function gunzip(data) {
  if (data[0] !== 0x1f || data[1] !== 0x8b) {
    return data;
  }

  const stream = new Blob([data])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));

  return new Uint8Array(
    await new Response(stream).arrayBuffer()
  );
}

function loadPch() {
  pchFiles ??= (async () => {
    const manifest = JSON.parse(
      new TextDecoder().decode(
        await fetchBytes('manifest.json')
      )
    );

    if (!CLANG_BASE.includes(`@${manifest.clang}/`)) {
      return null;
    }

    const [header, pch] = await Promise.all([
      fetchBytes(`${PCH}.hpp`),
      fetchBytes(`${PCH}.pch.gz`).then(gunzip)
    ]);

    pchReady = {
      [`${PCH}.hpp`]: header,
      [`${PCH}.pch`]: pch
    };

    return pchReady;
  })().catch(() => null);

  return pchFiles;
}

async function cppRuntime() {
  if (runtime) return runtime;

  const [eh, header] = await Promise.all([
    fetchBytes('eh.o').catch(async () => {
      const source = new TextDecoder().decode(
        await fetchBytes('eh.cpp')
      );

      return (
        await clang(
          'clang++',
          ['-std=c++20', '-O2', '-c', 'eh.cpp', '-o', 'eh.o'],
          { 'eh.cpp': source }
        )
      )?.['eh.o'];
    }),

    fetchBytes(`${PCH}.hpp`).catch(() => null)
  ]);

  if (!eh) {
    throw new Error('Could not prepare the C++ runtime.');
  }

  runtime = {
    'eh.o': eh,
    ...(header && {
      include: {
        bits: {
          'stdc++.h': header
        }
      }
    })
  };

  return runtime;
}

function flagsFor(language, standard) {
  const flags = LANGUAGES[language].flags;

  if (language !== 'c' || !C_STANDARDS.has(standard)) {
    return flags;
  }

  return [`-std=${standard}`, ...flags.slice(1)];
}

async function compile(language, code, flags) {
  if (language === 'cpp') {
    loadPch();
  }

  const { driver, file, libs } = LANGUAGES[language];

  const files = {
    [file]: code
  };

  if (language === 'cpp') {
    Object.assign(files, await cppRuntime());
  }

  const include = files.include
    ? ['-isystem', '/include']
    : [];

  const args = [
    ...flags,
    ...include,
    '-fno-color-diagnostics',
    file,
    ...libs,
    '-o',
    'main.wasm'
  ];

  if (language === 'cpp' && pchReady) {
    const diagnostics = [];

    const output = await clang(
      driver,
      ['-include-pch', `${PCH}.pch`, ...args],
      { ...files, ...pchReady },
      diagnostics
    );

    const diagnosticText = diagnostics
      .map(([, chunk]) => chunk)
      .join('');

    if (output?.['main.wasm'] || !PCH_TROUBLE.test(diagnosticText)) {
      for (const [stream, chunk] of diagnostics) {
        emit(stream, chunk);
      }

      return output?.['main.wasm'] ?? null;
    }
  }

  const output = await clang(driver, args, files);

  return output?.['main.wasm'] ?? null;
}

self.onmessage = async event => {
  const data = event.data || {};

  // Receive terminal input.
  if (data.type === 'input') {
    if (activeWasi) {
      activeWasi.pushInput(String(data.text ?? '') + '\n');
    }
    return;
  }

  // Close terminal input.
  if (data.type === 'close-input') {
    if (activeWasi) {
      activeWasi.closeInput();
    }
    return;
  }

  if (data.type !== 'run') return;

  if (isRunning) {
    emit('system', 'A program is already running.\n');
    return;
  }

  isRunning = true;
  written = 0;
  reported = 0;

  let exitCode = 0;

  try {
    if (
      typeof WebAssembly.Suspending !== 'function' ||
      typeof WebAssembly.promising !== 'function'
    ) {
      throw new Error(
        'This browser does not support JSPI interactive input.'
      );
    }

    const language = data.language === 'c' ? 'c' : 'cpp';
    const flags = flagsFor(language, data.standard);

    self.postMessage({
      type: 'status',
      status: 'busy'
    });

    if (!toolchain) {
      self.postMessage({
        type: 'status',
        status: 'loading'
      });

      toolchain = await import(
        `${CLANG_BASE}gen/bundle.js`
      );
    }

    emit(
      'system',
      `Compiling ${LANGUAGES[language].file} with Clang 21...\n`
    );

    const binary = await compile(
      language,
      String(data.code ?? ''),
      flags
    );

    if (!binary) {
      emit('system', 'Compilation failed.\n');
      exitCode = 1;
    } else {
      const program = await WebAssembly.compile(binary);

      activeWasi = createWasi({
        args: ['main'],
        write: (fd, text) => {
          emit(fd === 2 ? 'stderr' : 'stdout', text);
        }
      });

      const instance = await WebAssembly.instantiate(
        program,
        activeWasi.imports
      );

      self.postMessage({
        type: 'status',
        status: 'ready'
      });

      // Run the program and wait for interactive input.
      const result = await activeWasi.start(instance);

      // Normal WASI completion may return undefined.
      // Convert that normal completion to exit code 0.
      exitCode = Number.isFinite(result) ? result : 0;
    }
  } catch (error) {
    const message = error?.message || String(error);

    if (error instanceof WebAssembly.RuntimeError) {
      exitCode = message.includes('unreachable') ? 134 : 139;

      emit(
        'stderr',
        exitCode === 134
          ? 'Program aborted.\n'
          : `Runtime error: ${message}\n`
      );
    } else {
      exitCode = 1;
      emit('stderr', `${message}\n`);
    }
  } finally {
    if (activeWasi) {
      activeWasi.closeInput();
      activeWasi = null;
    }

    isRunning = false;

    self.postMessage({
      type: 'done',
      exitCode
    });
  }
};
