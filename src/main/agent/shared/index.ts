export { interpolateTemplate, interpolateTaskTemplate } from './template-utils';
export { resolveBridgeScript } from './bridge-utils';
export { execVersion } from './exec-version';
export { AgentDetector, type AgentDetectorConfig } from './agent-detector';
export { escapeXml, buildTaskXml, buildHandoffXml, type TaskXmlInput, type HandoffXmlInput } from './prompt-xml';
export { resolveTaskTemplateVars, TASK_TEMPLATE_RESOLVERS, type TaskTemplateContext } from './task-template-resolvers';
// NOTE: relocation-utils is intentionally NOT re-exported here. Several unit
// suites mock this barrel (`vi.mock('.../agent/shared')`); routing a
// module-load-time `createSerialLock()` call through the barrel would break
// those mocks. Consumers import from './relocation-utils' directly instead.
