// Tiny stack VM for make.fun's tiny-stack-vm-01 ISA (32-bit wrapping, traps 2-11).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Run one program; returns [output, output length, exit code].
function run(p: Buffer, inp: Buffer) {
  const n = p.length;
  const D = new Int32Array(256), C = new Int32Array(64), M = new Int32Array(256);
  const out = new Uint8Array(65536);
  let sp = 0, csp = 0, pc = 0, steps = 0, olen = 0, ipos = 0;
  const T = (e: number) => [out, olen, e];
  for (;;) {
    if (steps === 1000000) return T(10);
    if (pc < 0 || pc >= n) return T(9);
    const op = p[pc];
    const imm = op === 1 ? 1 : op === 2 ? 4 : op >= 0x30 && op <= 0x33 ? 2 : 0;
    if (pc + imm >= n) return T(9);
    steps++;
    const next = pc + 1 + imm;
    pc = next;
    switch (op) {
      case 0x00: return T(0);
      case 0x01: // PUSH8 sign-extends
        if (sp === 256) return T(3);
        D[sp++] = (p[next - 1] << 24) >> 24;
        break;
      case 0x02: // PUSH32 little-endian
        if (sp === 256) return T(3);
        D[sp++] = p[next - 4] | (p[next - 3] << 8) | (p[next - 2] << 16) | (p[next - 1] << 24);
        break;
      case 0x03:
        if (sp < 1) return T(2);
        sp--;
        break;
      case 0x04:
        if (sp < 1) return T(2);
        if (sp === 256) return T(3);
        D[sp] = D[sp - 1];
        sp++;
        break;
      case 0x05:
        if (sp < 2) return T(2);
        [D[sp - 1], D[sp - 2]] = [D[sp - 2], D[sp - 1]];
        break;
      case 0x06:
        if (sp < 2) return T(2);
        if (sp === 256) return T(3);
        D[sp] = D[sp - 2];
        sp++;
        break;
      case 0x07: // ROT (a b c -- b c a)
        if (sp < 3) return T(2);
        [D[sp - 3], D[sp - 2], D[sp - 1]] = [D[sp - 2], D[sp - 1], D[sp - 3]];
        break;
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x20: case 0x21: case 0x22: {
        if (sp < 2) return T(2);
        const b = D[sp - 1], a = D[sp - 2];
        let r = 0;
        switch (op) {
          case 0x10: r = (a + b) | 0; break;
          case 0x11: r = (a - b) | 0; break;
          case 0x12: r = Math.imul(a, b); break; // exact low 32 bits
          case 0x13: // DIV truncates toward zero
            if (b === 0) return T(4);
            r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
            break;
          case 0x14: // MOD takes sign of a
            if (b === 0) return T(4);
            r = b === -1 ? 0 : (a % b) | 0;
            break;
          case 0x15: // DIVU
            if (b === 0) return T(4);
            r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
            break;
          case 0x16: // MODU
            if (b === 0) return T(4);
            r = ((a >>> 0) % (b >>> 0)) | 0;
            break;
          case 0x18: r = a & b; break;
          case 0x19: r = a | b; break;
          case 0x1a: r = a ^ b; break;
          case 0x1c: r = a << (b & 31); break;
          case 0x1d: r = a >> (b & 31); break; // SHR
          case 0x1e: r = (a >>> (b & 31)) | 0; break; // SHRU
          case 0x20: r = a === b ? 1 : 0; break;
          case 0x21: r = a < b ? 1 : 0; break;
          default: r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU
        }
        sp -= 2;
        D[sp++] = r;
        break;
      }
      case 0x17: // NEG wraps
        if (sp < 1) return T(2);
        D[sp - 1] = (-D[sp - 1]) | 0;
        break;
      case 0x1b:
        if (sp < 1) return T(2);
        D[sp - 1] = ~D[sp - 1];
        break;
      case 0x30: case 0x31: case 0x32: { // JMP/JZ/JNZ
        const rel = ((p[next - 2] | (p[next - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 0x30) {
          if (sp < 1) return T(2);
          const v = D[--sp];
          take = op === 0x31 ? v === 0 : v !== 0;
        }
        if (take) pc = next + rel;
        break;
      }
      case 0x33: // CALL pushes next address
        if (csp === 64) return T(7);
        C[csp++] = next;
        pc = p[next - 2] | (p[next - 1] << 8);
        break;
      case 0x34:
        if (csp === 0) return T(8);
        pc = C[--csp];
        break;
      case 0x40:
        if (sp < 1) return T(2);
        { const addr = D[sp - 1];
          if (addr < 0 || addr > 255) return T(6);
          D[sp - 1] = M[addr]; }
        break;
      case 0x41: // STORE
        if (sp < 2) return T(2);
        { const addr = D[sp - 1], v = D[sp - 2];
          if (addr < 0 || addr > 255) return T(6);
          sp -= 2;
          M[addr] = v; }
        break;
      case 0x50: { // PRINT decimal, no newline
        if (sp < 1) return T(2);
        const s = String(D[sp - 1]);
        if (olen + s.length > 65536) return T(11);
        sp--;
        for (const c of s) out[olen++] = c.charCodeAt(0);
        break;
      }
      case 0x51: // PUTC
        if (sp < 1) return T(2);
        if (olen + 1 > 65536) return T(11);
        out[olen++] = D[--sp] & 255;
        break;
      case 0x52: // IN, -1 at EOF
        if (sp === 256) return T(3);
        D[sp++] = ipos < inp.length ? inp[ipos++] : -1;
        break;
      case 0x53: // EXIT takes low byte
        if (sp < 1) return T(2);
        return T(D[--sp] & 255);
      default: return T(5);
    }
  }
}

// Answer every instance in the input directory.
const read = (f: string): Buffer => {
  try { return readFileSync(f); } catch { return Buffer.alloc(0); }
};
for (const id of readdirSync(I).sort()) {
  const dir = I + '/' + id;
  const [out, olen, exit] = run(read(dir + '/program.bin'), read(dir + '/input.bin'));
  mkdirSync(O + '/' + id, { recursive: true });
  writeFileSync(O + '/' + id + '/stdout.bin', out.subarray(0, olen));
  writeFileSync(O + '/' + id + '/exit.txt', exit + '\n');
}
