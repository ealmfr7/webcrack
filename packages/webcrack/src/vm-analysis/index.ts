export {
  detectInterpreters,
  type InterpreterDispatchKind,
  type InterpreterHandler,
  type InterpreterInfo,
} from './detect.js';
export {
  labelHandlers,
  type HandlerKind,
  type HandlerLabel,
  type HandlerLabelKind,
} from './handlers.js';
export {
  disassemble,
  formatDisassembly,
  type BytecodeInput,
  type DisassembledInstruction,
  type Disassembly,
} from './disasm.js';
