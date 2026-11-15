#!/usr/bin/env node
/**
 * O .exe da versão Windows 7 RODA no Windows 7? — respondido lendo o próprio arquivo.
 *
 * O Windows recusa abrir um programa que IMPORTA uma função que ele não tem: a mensagem é
 * "o ponto de entrada não foi localizado" ou "falta api-ms-win-....dll", e o app nem chega a
 * abrir. Não temos um Windows 7 na esteira de build, então a garantia é ler a TABELA DE
 * IMPORTAÇÃO do executável pronto (e das DLLs que vão junto no instalador) e reprovar o build
 * se aparecer qualquer coisa que só existe do Windows 8 em diante.
 *
 *   node .github/scripts/win7-exe-check.mjs <arquivo.exe|.dll> [...]
 *
 * Sai com código 1 quando algum arquivo tem problema OU não pôde ser lido: leitura que falhou
 * nunca vira "ok" (é o build que segura a publicação de um instalador quebrado).
 *
 * Sem dependências (roda no runner com o Node puro) e exporta as funções para a trava do
 * monorepo (src/lib/desktop-win7-build.test.ts) testar o leitor com um PE montado à mão.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** i386: a versão Windows 7 é de 32 bits para rodar também em Windows 7/8 de 32 bits. */
export const PE_MACHINE_I386 = 0x014c;

/**
 * DLLs que o Windows 7 não tem (ou só tem com atualização opcional que o cliente pode não ter).
 * `api-ms-win-*` e `ext-ms-*` são os "conjuntos de API": quase todos nasceram no Windows 8+, e o
 * UCRT (`api-ms-win-crt-*`) só existe no Windows 7 com a KB2999226 — por isso o build liga o
 * runtime de C ESTÁTICO (`+crt-static`) e qualquer um deles aqui é sinal de que algo escapou.
 */
export const WIN7_FORBIDDEN_DLL_PREFIXES = ['api-ms-win-', 'ext-ms-'];
export const WIN7_FORBIDDEN_DLLS = [
  'combase.dll', // WinRT (Windows 8+)
  'shcore.dll', // DPI por monitor (Windows 8.1+)
  'dcomp.dll', // DirectComposition (Windows 8+)
  'vcruntime140.dll', // pediria o "Visual C++ Redistributable" instalado
  'vcruntime140_1.dll',
  'msvcp140.dll',
  'ucrtbase.dll',
];

/**
 * Funções que só existem do Windows 8 em diante (nomes vistos em crates Rust e no std).
 *
 * `EventSetInformation` (advapi32) fica de fora DE PROPÓSITO: vem do carregador do WebView2 da
 * própria Microsoft (WebView2LoaderStatic.lib) e existe no Windows 7 SP1 atualizado (KB3080149) —
 * o mesmo Windows 7 que o WebView2 109 já exige.
 */
export const WIN7_FORBIDDEN_FUNCTIONS = [
  'WaitOnAddress',
  'WakeByAddressSingle',
  'WakeByAddressAll',
  'GetSystemTimePreciseAsFileTime',
  'ProcessPrng',
  'CreateFile2',
  'CopyFile2',
  'SetThreadDescription',
  'GetThreadDescription',
  'GetCurrentThreadStackLimits',
  'PrefetchVirtualMemory',
  'GetOverlappedResultEx',
  'GetFirmwareType',
  'CoIncrementMTAUsage',
  'CoDecrementMTAUsage',
  'RoGetActivationFactory',
  'RoInitialize',
  'RoUninitialize',
  'RoGetAgileReference',
  'WindowsCreateString',
  'WindowsDeleteString',
  'SetProcessDpiAwarenessContext',
  'SetThreadDpiAwarenessContext',
  'GetDpiForWindow',
  'GetDpiForSystem',
  'GetDpiForMonitor',
  'GetSystemMetricsForDpi',
  'AdjustWindowRectExForDpi',
  'EnableNonClientDpiScaling',
  'SetProcessDpiAwareness',
  'GetProcessDpiAwareness',
  'EnableMouseInPointer',
  'GetPointerType',
  'DiscardVirtualMemory',
  'OfferVirtualMemory',
  'ReclaimVirtualMemory',
  'GetCurrentPackageFullName',
  'GetCurrentPackageId',
  'GetPackageFamilyName',
];

/** Windows 7 é a versão 6.1 do núcleo. Cabeçalho pedindo mais que isso o Windows 7 recusa. */
const WIN7_VERSION = [6, 1];

function fail(message) {
  throw new Error(message);
}

function readCString(buf, offset) {
  if (offset < 0 || offset >= buf.length) fail(`texto fora do arquivo (posição ${offset})`);
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end += 1;
  return buf.toString('latin1', offset, end);
}

/**
 * Lê o cabeçalho e a tabela de importação de um PE (32 ou 64 bits).
 * Lança quando o arquivo não é um PE válido — quem chama trata como reprovação.
 */
export function readPe(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) fail('não é um executável do Windows (falta "MZ")');
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 24 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) {
    fail('assinatura "PE" ausente');
  }

  const coff = peOffset + 4;
  const machine = buf.readUInt16LE(coff);
  const numberOfSections = buf.readUInt16LE(coff + 2);
  const sizeOfOptionalHeader = buf.readUInt16LE(coff + 16);

  const opt = coff + 20;
  const magic = buf.readUInt16LE(opt);
  if (magic !== 0x10b && magic !== 0x20b) fail(`cabeçalho opcional desconhecido (0x${magic.toString(16)})`);
  const is64 = magic === 0x20b;

  const osVersion = [buf.readUInt16LE(opt + 40), buf.readUInt16LE(opt + 42)];
  const subsystemVersion = [buf.readUInt16LE(opt + 48), buf.readUInt16LE(opt + 50)];
  const sizeOfHeaders = buf.readUInt32LE(opt + 60);

  const dataDirectories = opt + (is64 ? 112 : 96);
  const numberOfRvaAndSizes = buf.readUInt32LE(opt + (is64 ? 108 : 92));
  const importRva = numberOfRvaAndSizes > 1 ? buf.readUInt32LE(dataDirectories + 8) : 0;

  const sections = [];
  const sectionTable = opt + sizeOfOptionalHeader;
  for (let i = 0; i < numberOfSections; i += 1) {
    const s = sectionTable + i * 40;
    sections.push({
      virtualSize: buf.readUInt32LE(s + 8),
      virtualAddress: buf.readUInt32LE(s + 12),
      sizeOfRawData: buf.readUInt32LE(s + 16),
      pointerToRawData: buf.readUInt32LE(s + 20),
    });
  }

  const rvaToOffset = (rva) => {
    if (rva < sizeOfHeaders) return rva;
    for (const s of sections) {
      const size = Math.max(s.virtualSize, s.sizeOfRawData);
      if (rva >= s.virtualAddress && rva < s.virtualAddress + size) {
        return rva - s.virtualAddress + s.pointerToRawData;
      }
    }
    fail(`endereço 0x${rva.toString(16)} fora das seções`);
  };

  const imports = [];
  if (importRva !== 0) {
    let descriptor = rvaToOffset(importRva);
    for (;;) {
      if (descriptor + 20 > buf.length) fail('tabela de importação cortada');
      const originalFirstThunk = buf.readUInt32LE(descriptor);
      const nameRva = buf.readUInt32LE(descriptor + 12);
      const firstThunk = buf.readUInt32LE(descriptor + 16);
      if (nameRva === 0 && firstThunk === 0) break;

      const dll = readCString(buf, rvaToOffset(nameRva));
      const functions = [];
      let thunk = rvaToOffset(originalFirstThunk || firstThunk);
      for (;;) {
        if (is64) {
          const value = buf.readBigUInt64LE(thunk);
          if (value === 0n) break;
          if (value & 0x8000000000000000n) functions.push(`#${Number(value & 0xffffn)}`);
          else functions.push(readCString(buf, rvaToOffset(Number(value & 0x7fffffffn)) + 2));
          thunk += 8;
        } else {
          const value = buf.readUInt32LE(thunk);
          if (value === 0) break;
          if (value & 0x80000000) functions.push(`#${value & 0xffff}`);
          else functions.push(readCString(buf, rvaToOffset(value & 0x7fffffff) + 2));
          thunk += 4;
        }
      }
      imports.push({ dll, functions });
      descriptor += 20;
    }
  }

  return { machine, is64, osVersion, subsystemVersion, imports };
}

const newerThanWin7 = ([major, minor]) =>
  major > WIN7_VERSION[0] || (major === WIN7_VERSION[0] && minor > WIN7_VERSION[1]);

/** O que impede este PE de abrir num Windows 7 de 32 bits. Lista vazia = pode seguir. */
export function win7Problems(pe) {
  const problems = [];
  if (pe.machine !== PE_MACHINE_I386 || pe.is64) {
    problems.push(`não é de 32 bits (máquina 0x${pe.machine.toString(16)}): não abre em Windows de 32 bits`);
  }
  if (newerThanWin7(pe.osVersion)) {
    problems.push(`cabeçalho pede Windows ${pe.osVersion.join('.')} (o Windows 7 é 6.1)`);
  }
  if (newerThanWin7(pe.subsystemVersion)) {
    problems.push(`subsistema pede Windows ${pe.subsystemVersion.join('.')} (o Windows 7 é 6.1)`);
  }

  const forbiddenFunctions = new Set(WIN7_FORBIDDEN_FUNCTIONS);
  for (const { dll, functions } of pe.imports) {
    const name = dll.toLowerCase();
    if (WIN7_FORBIDDEN_DLL_PREFIXES.some((prefix) => name.startsWith(prefix)) || WIN7_FORBIDDEN_DLLS.includes(name)) {
      problems.push(`importa ${dll} (não existe no Windows 7): ${functions.join(', ')}`);
      continue;
    }
    const bad = functions.filter((fn) => forbiddenFunctions.has(fn));
    if (bad.length > 0) problems.push(`importa de ${dll} função do Windows 8+: ${bad.join(', ')}`);
  }
  return problems;
}

function main(files) {
  if (files.length === 0) {
    console.error('Uso: node win7-exe-check.mjs <arquivo.exe|.dll> [...]');
    return 1;
  }
  let failed = false;
  for (const file of files) {
    let pe;
    try {
      pe = readPe(readFileSync(file));
    } catch (err) {
      console.error(`::error::${file}: não consegui ler como executável do Windows (${err.message}).`);
      failed = true;
      continue;
    }
    console.log(`== ${file} (${pe.is64 ? '64' : '32'} bits, SO ${pe.osVersion.join('.')}, subsistema ${pe.subsystemVersion.join('.')})`);
    for (const { dll, functions } of pe.imports) console.log(`   ${dll}: ${functions.length} função(ões)`);
    const problems = win7Problems(pe);
    for (const problem of problems) console.error(`::error::${file}: ${problem}`);
    if (problems.length > 0) failed = true;
    else console.log('   OK para Windows 7 (32 bits).');
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
