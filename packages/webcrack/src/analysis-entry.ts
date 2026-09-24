export { extractReport } from './analysis/report';
export type {
  EndpointEntry,
  InterestingEntry,
  RegexEntry,
  Report,
  ReportPosition,
  SecretEntry,
  UrlEntry,
} from './analysis/report';
export { callGraph, moduleGraph, toDot, toJSON } from './analysis/graph';
export type { Graph, GraphEdge, GraphNode } from './analysis/graph';
export { detectInterpreters } from './vm-analysis/detect';
export type {
  InterpreterDispatchKind,
  InterpreterHandler,
  InterpreterInfo,
} from './vm-analysis/detect';
export { createNodeSandbox } from './deobfuscate/vm';
export type { NodeSandboxOptions, Sandbox } from './deobfuscate/vm';
