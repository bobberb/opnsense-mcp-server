#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read the tools data from parent directory
const toolsData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools-generated.json'), 'utf8'));

// Generate the single-file server with modular tools
const serverCode = `#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { OPNsenseClient } from '@richard-stovall/opnsense-typescript-client';

// Embedded modular tool definitions
const TOOLS = ${JSON.stringify(toolsData.tools, null, 2)};

// Method documentation for help
const METHOD_DOCS = ${JSON.stringify(toolsData.methodDocs, null, 2)};

class OPNsenseMCPServer {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.server = new Server(
      {
        name: 'opnsense-mcp-server',
        version: '0.6.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  ensureClient() {
    if (!this.client) {
      this.client = new OPNsenseClient({
        baseUrl: this.config.url,
        apiKey: this.config.apiKey,
        apiSecret: this.config.apiSecret,
        verifySsl: this.config.verifySsl ?? true,
      });
    }
    return this.client;
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.getAvailableTools(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      
      const tool = TOOLS.find(t => t.name === name);
      if (!tool) {
        throw new McpError(ErrorCode.MethodNotFound, \`Tool \${name} not found\`);
      }

      // Skip plugin tools if not enabled
      if (tool.module === 'plugins' && !this.config.includePlugins) {
        throw new McpError(ErrorCode.MethodNotFound, \`Plugin tools not enabled. Use --plugins flag to enable.\`);
      }

      try {
        const result = await this.callModularTool(tool, args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        console.error('Tool call error:', {
          tool: tool.name,
          module: tool.module,
          method: args.method,
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        let errorMessage = 'Unknown error';
        if (error instanceof Error) {
          errorMessage = error.message;
          // Check for HTTP response errors (fetch/axios-style)
          if ('response' in error && error.response && typeof error.response === 'object') {
            const response = error.response;
            errorMessage = \`HTTP \${response.status}: \${response.statusText || 'Error'}\\n\`;
            if (response.data) {
              errorMessage += \`Response: \${JSON.stringify(response.data, null, 2)}\`;
            }
          }
        }

        return {
          content: [{
            type: 'text',
            text: \`Error calling \${tool.name}.\${args.method || 'unknown'}: \${errorMessage}\`
          }],
        };
      }
    });
  }

  getAvailableTools() {
    return TOOLS.filter(tool => {
      // Include all non-plugin tools
      if (tool.module !== 'plugins') return true;
      // Include plugin tools only if enabled
      return this.config.includePlugins;
    }).map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
  }

  async callModularTool(tool, args) {
    const client = this.ensureClient();

    // Validate method parameter
    if (!args.method) {
      throw new Error(\`Missing required parameter 'method'. Available methods: \${tool.methods.join(', ')}\`);
    }

    if (!tool.methods.includes(args.method)) {
      throw new Error(\`Invalid method '\${args.method}'. Available methods: \${tool.methods.join(', ')}\`);
    }

    const params = args.params || {};

    // Destructive methods require explicit confirmation
    const DESTRUCTIVE_METHODS = new Set([
      'systemHalt', 'systemReboot',
      'backupRevertBackup', 'backupDeleteBackup',
    ]);

    if (DESTRUCTIVE_METHODS.has(args.method) && params.confirm !== true) {
      return {
        warning: \`\${args.method} is a destructive operation that cannot be undone. Pass "confirm": true in params to proceed.\`,
        method: args.method,
        confirmed: false,
      };
    }

    // Get the module
    let moduleObj;
    if (tool.module === 'plugins' && tool.submodule) {
      moduleObj = client.plugins[tool.submodule];
    } else {
      moduleObj = client[tool.module];
    }

    if (!moduleObj) {
      throw new Error(\`Module \${tool.module} not found\`);
    }

    // Get the method
    const method = moduleObj[args.method];
    if (!method || typeof method !== 'function') {
      throw new Error(\`Method \${args.method} not found in module \${tool.module}\`);
    }

    console.error(\`Calling \${tool.module}.\${args.method}\`);

    // Strip meta-fields from params before passing to API
    const { confirm: _confirm, ...callParams } = params;

    // HTTP method overrides: client library uses GET but OPNsense 26.1 requires POST
    const httpOverrides = {
      'filterToggleRuleLog': (p) => client.http.post(\`/api/firewall/filter/toggle_rule_log/\${p.uuid}/\${p.enabled || ''}\`, {}),
      'dNatToggleRuleLog':   (p) => client.http.post(\`/api/firewall/d_nat/toggle_rule_log/\${p.uuid}/\${p.enabled || ''}\`, {}),
    };

    if (httpOverrides[args.method]) {
      return await httpOverrides[args.method](callParams);
    }

    // ── Safe read-modify-write for UUID-based Set methods ──
    // OPNsense "set" endpoints do FULL REPLACEMENT (PUT semantics), not partial update.
    // Sending { rule: { log: "1" } } will WIPE all other fields (interface, protocol, etc).
    // This interceptor auto-fetches current state, flattens dropdown fields to simple
    // values, deep-merges the caller's changes on top, then sends the complete object.
    const SET_GET_PAIRS = {
      'filterSetRule': 'filterGetRule',
      'aliasSetItem': 'aliasGetItem',
      'categorySetItem': 'categoryGetItem',
      'groupSetItem': 'groupGetItem',
      'nptSetRule': 'nptGetRule',
      'oneToOneSetRule': 'oneToOneGetRule',
      'sourceNatSetRule': 'sourceNatGetRule',
      'dNatSetRule': 'dNatGetRule',
    };

    const getMethodName = SET_GET_PAIRS[args.method];
    if (getMethodName && callParams.uuid && callParams.data) {
      const getMethod = moduleObj[getMethodName];
      if (getMethod) {
        console.error(\`Safe merge: fetching current state via \${getMethodName}(\${callParams.uuid})\`);
        const current = await getMethod.call(moduleObj, callParams.uuid);

        // Flatten OPNsense dropdown objects to their selected key(s).
        // Dropdowns look like: { "TCP": { value: "TCP", selected: 0 }, "any": { value: "any", selected: 1 } }
        // Result: "any" (single-select) or "key1,key2" (multi-select)
        function flattenDropdowns(obj) {
          if (obj === null || obj === undefined) return obj;
          if (typeof obj !== 'object' || Array.isArray(obj)) return obj;
          const vals = Object.values(obj);
          if (vals.length > 0 && vals.every(v => v && typeof v === 'object' && 'selected' in v && 'value' in v)) {
            const selected = Object.entries(obj)
              .filter(([, v]) => v.selected === 1 || v.selected === true)
              .map(([k]) => k);
            return selected.join(',');
          }
          const result = {};
          for (const [k, v] of Object.entries(obj)) {
            result[k] = flattenDropdowns(v);
          }
          return result;
        }

        // Deep merge: caller's values override base, recurse into nested objects
        function deepMerge(base, overlay) {
          if (overlay === null || overlay === undefined) return base;
          if (typeof overlay !== 'object' || Array.isArray(overlay)) return overlay;
          if (typeof base !== 'object' || Array.isArray(base)) return overlay;
          const result = { ...base };
          for (const [k, v] of Object.entries(overlay)) {
            result[k] = deepMerge(result[k], v);
          }
          return result;
        }

        const currentData = current.data || current;
        const flattened = flattenDropdowns(currentData);
        callParams.data = deepMerge(flattened, callParams.data);
        console.error(\`Safe merge: complete rule assembled with \${Object.keys(Object.values(callParams.data)[0] || {}).length} fields\`);
      }
    }

    // Methods that take positional path parameters instead of a single object.
    // Each entry maps method name to { required: [...], mapper: (params) => args[] }.
    const positionalMethods = {
      // Core - backup operations
      'backupBackups':       { required: ['host'],                     mapper: (p) => [p.host] },
      'backupDeleteBackup':  { required: ['backup'],                   mapper: (p) => [p.backup] },
      'backupDiff':          { required: ['host', 'backup1', 'backup2'], mapper: (p) => [p.host, p.backup1, p.backup2] },
      'backupDownload':      { required: ['host'],                     mapper: (p) => [p.host, p.backup] },
      'backupRevertBackup':  { required: ['backup'],                   mapper: (p) => [p.backup] },
      // Core - HA sync operations
      'hasyncStatusRemoteService': { required: ['action', 'service', 'serviceId'], mapper: (p) => [p.action, p.service, p.serviceId] },
      'hasyncStatusRestart':    { required: [], mapper: (p) => [p.service, p.serviceId, p.data || {}] },
      'hasyncStatusRestartAll': { required: [], mapper: (p) => [p.service, p.serviceId, p.data || {}] },
      'hasyncStatusStart':      { required: [], mapper: (p) => [p.service, p.serviceId, p.data || {}] },
      'hasyncStatusStop':       { required: [], mapper: (p) => [p.service, p.serviceId, p.data || {}] },
      // Core - service operations
      'serviceRestart': { required: ['name'], mapper: (p) => [p.name, p.id, p.data || {}] },
      'serviceStart':   { required: ['name'], mapper: (p) => [p.name, p.id, p.data || {}] },
      'serviceStop':    { required: ['name'], mapper: (p) => [p.name, p.id, p.data || {}] },
      // Core - snapshot operations
      'snapshotsActivate': { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      'snapshotsDel':      { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      'snapshotsGet':      { required: [],       mapper: (p) => p.uuid ? [p.uuid] : [] },
      'snapshotsSet':      { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      // Core - tunable operations
      'tunablesDelItem':  { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      'tunablesGetItem':  { required: [],       mapper: (p) => p.uuid ? [p.uuid] : [] },
      'tunablesSetItem':  { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      // IDS - ruleset operations
      'settingsToggleRuleset': { required: ['filenames', 'enabled'], mapper: (p) => [p.filenames, p.enabled, p.data || {}] },
      'settingsSetRuleset':    { required: ['filename'],             mapper: (p) => [p.filename, p.data || {}] },
      'settingsToggleRule':    { required: ['sid', 'enabled'],       mapper: (p) => [p.sid, p.enabled] },
      // Firewall - filter rules
      'filterGetRule':        { required: [],       mapper: (p) => p.uuid ? [p.uuid] : [] },
      'filterSetRule':        { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      'filterDelRule':        { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      'filterToggleRule':     { required: ['uuid'], mapper: (p) => [p.uuid, p.enabled, p.data || {}] },
      'filterToggleRuleLog':  { required: ['uuid'], mapper: (p) => [p.uuid, p.enabled || ''] },
      'filterMoveRuleBefore': { required: ['uuid', 'targetUuid'], mapper: (p) => [p.uuid, p.targetUuid, p.data || {}] },
      'filterBaseApply':      { required: [], mapper: (p) => p.rollbackRevision ? [p.rollbackRevision, p.data || {}] : [] },
      'filterBaseCancelRollback': { required: ['rollbackRevision'], mapper: (p) => [p.rollbackRevision, p.data || {}] },
      'filterBaseRevert':     { required: ['revision'], mapper: (p) => [p.revision, p.data || {}] },
      // Firewall - aliases
      'aliasGetItem':     { required: [],       mapper: (p) => p.uuid ? [p.uuid] : [] },
      'aliasSetItem':     { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      'aliasDelItem':     { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      'aliasToggleItem':  { required: ['uuid'], mapper: (p) => [p.uuid, p.enabled, p.data || {}] },
      'aliasGetAliasUUID': { required: ['name'], mapper: (p) => [p.name] },
      'aliasUtilAdd':     { required: ['alias'], mapper: (p) => [p.alias, p.data || {}] },
      'aliasUtilDelete':  { required: ['alias'], mapper: (p) => [p.alias, p.data || {}] },
      'aliasUtilFlush':   { required: ['alias'], mapper: (p) => [p.alias, p.data || {}] },
      'aliasUtilList':    { required: ['alias'], mapper: (p) => [p.alias] },
      // Firewall - categories
      'categoryGetItem':  { required: [],       mapper: (p) => p.uuid ? [p.uuid] : [] },
      'categorySetItem':  { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      'categoryDelItem':  { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      // Firewall - groups
      'groupGetItem':     { required: [],       mapper: (p) => p.uuid ? [p.uuid] : [] },
      'groupSetItem':     { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      'groupDelItem':     { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      // Firewall - NAT rules (NPT, 1:1, SNAT, DNAT)
      'nptGetRule':       { required: [],       mapper: (p) => p.uuid ? [p.uuid] : [] },
      'nptSetRule':       { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      'nptDelRule':       { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      'nptToggleRule':    { required: ['uuid'], mapper: (p) => [p.uuid, p.enabled, p.data || {}] },
      'oneToOneGetRule':  { required: [],       mapper: (p) => p.uuid ? [p.uuid] : [] },
      'oneToOneSetRule':  { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      'oneToOneDelRule':  { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      'oneToOneToggleRule': { required: ['uuid'], mapper: (p) => [p.uuid, p.enabled, p.data || {}] },
      'sourceNatGetRule':   { required: [],       mapper: (p) => p.uuid ? [p.uuid] : [] },
      'sourceNatSetRule':   { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      'sourceNatDelRule':   { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      'sourceNatToggleRule': { required: ['uuid'], mapper: (p) => [p.uuid, p.enabled, p.data || {}] },
      'dNatGetRule':      { required: [],       mapper: (p) => p.uuid ? [p.uuid] : [] },
      'dNatSetRule':      { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      'dNatDelRule':      { required: ['uuid'], mapper: (p) => [p.uuid, p.data || {}] },
      'dNatToggleRule':   { required: ['uuid'], mapper: (p) => [p.uuid, p.enabled, p.data || {}] },
      'dNatToggleRuleLog': { required: ['uuid'], mapper: (p) => [p.uuid, p.enabled || ''] },
      'dNatMoveRuleBefore': { required: ['uuid', 'targetUuid'], mapper: (p) => [p.uuid, p.targetUuid, p.data || {}] },
      'dNatRevert':       { required: ['revision'], mapper: (p) => [p.revision, p.data || {}] },
    };

    const positionalDef = positionalMethods[args.method];
    if (positionalDef) {
      // Validate required positional parameters
      const missing = positionalDef.required.filter(r => callParams[r] === undefined || callParams[r] === null);
      if (missing.length > 0) {
        throw new Error(\`Method '\${args.method}' requires parameter(s): \${missing.join(', ')}\`);
      }
      const positionalArgs = positionalDef.mapper(callParams);
      return await method.call(moduleObj, ...positionalArgs);
    }

    // For non-positional methods: unwrap data if present, otherwise pass params as-is
    if (Object.keys(callParams).length > 0) {
      return await method.call(moduleObj, callParams.data || callParams);
    } else {
      return await method.call(moduleObj);
    }
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('OPNsense MCP server v0.6.0 (modular) started');
    console.error(\`Core tools: ${toolsData.coreTools} modules\`);
    console.error(\`Plugin tools: ${toolsData.pluginTools} modules (\${this.config.includePlugins ? 'enabled' : 'disabled'})\`);
    console.error(\`Total available: \${this.config.includePlugins ? '${toolsData.totalTools}' : '${toolsData.coreTools}'} modules\`);
  }
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    url: '',
    apiKey: '',
    apiSecret: '',
    verifySsl: true,
    includePlugins: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url':
      case '-u':
        config.url = args[++i];
        break;
      case '--api-key':
      case '-k':
        config.apiKey = args[++i];
        break;
      case '--api-secret':
      case '-s':
        config.apiSecret = args[++i];
        break;
      case '--no-verify-ssl':
        config.verifySsl = false;
        break;
      case '--plugins':
        config.includePlugins = true;
        break;
      case '--help':
      case '-h':
        showHelp();
        process.exit(0);
        break;
    }
  }

  return config;
}

function showHelp() {
  console.log(\`
OPNsense MCP Server v0.6.0 (Modular Edition)

Usage: opnsense-mcp-server --url <url> --api-key <key> --api-secret <secret> [options]

Required:
  -u, --url <url>           OPNsense API URL (e.g., https://192.168.1.1)
  -k, --api-key <key>       API Key for authentication
  -s, --api-secret <secret> API Secret for authentication

Options:
  --no-verify-ssl           Disable SSL certificate verification
  --plugins                 Include plugin tools (adds ${toolsData.pluginTools} plugin modules)
  -h, --help                Show this help message

Environment Variables:
  OPNSENSE_URL              OPNsense API URL
  OPNSENSE_API_KEY          API Key
  OPNSENSE_API_SECRET       API Secret
  OPNSENSE_VERIFY_SSL       Set to 'false' to disable SSL verification
  INCLUDE_PLUGINS           Set to 'true' to include plugin tools

Examples:
  # Basic usage (${toolsData.coreTools} core modules)
  opnsense-mcp-server --url https://192.168.1.1 --api-key mykey --api-secret mysecret

  # With plugins enabled (${toolsData.totalTools} total modules)
  opnsense-mcp-server --url https://192.168.1.1 --api-key mykey --api-secret mysecret --plugins

Tool Usage:
  Each tool represents a module and accepts a 'method' parameter to specify the operation.
  
  Example: firewall_manage
  - method: "aliasSearchItem" - Search firewall aliases
  - method: "aliasAddItem" - Add a new alias
  - method: "aliasSetItem" - Update an existing alias (requires uuid in params)
  
  Parameters are passed in the 'params' object:
  {
    "method": "aliasSearchItem",
    "params": {
      "searchPhrase": "web",
      "current": 1,
      "rowCount": 20
    }
  }

Based on @richard-stovall/opnsense-typescript-client v0.5.3
\`);
}

// Main entry point
async function main() {
  const config = parseArgs();
  
  // Use environment variables as fallback
  config.url = config.url || process.env.OPNSENSE_URL || '';
  config.apiKey = config.apiKey || process.env.OPNSENSE_API_KEY || '';
  config.apiSecret = config.apiSecret || process.env.OPNSENSE_API_SECRET || '';
  if (!config.verifySsl || process.env.OPNSENSE_VERIFY_SSL === 'false') {
    config.verifySsl = false;
  }
  if (config.includePlugins || process.env.INCLUDE_PLUGINS === 'true') {
    config.includePlugins = true;
  }

  // Validate required arguments
  if (!config.url || !config.apiKey || !config.apiSecret) {
    console.error('Error: Missing required arguments\\n');
    showHelp();
    process.exit(1);
  }

  // Create and start server
  const server = new OPNsenseMCPServer(config);
  await server.start();
}

// Run the server
main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
`;

// Write the single-file server to parent directory
fs.writeFileSync(path.join(__dirname, '..', 'index.js'), serverCode);
console.log('Built index.js successfully');
console.log(`Total tools: ${toolsData.totalTools} modules`);
console.log(`Core tools: ${toolsData.coreTools} modules`);
console.log(`Plugin tools: ${toolsData.pluginTools} modules`);