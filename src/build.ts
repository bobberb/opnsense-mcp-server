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
      // Client URL templates interpolate every path param ("/toggle_job/\${uuid}/\${enabled}"), so an
      // omitted trailing optional param would reach OPNsense as the literal "undefined". Drop those.
      this.client.http.client.interceptors.request.use((cfg) => {
        if (typeof cfg.url === 'string') cfg.url = cfg.url.replace(/(?:[/]undefined)+(?=$|[?])/, '');
        return cfg;
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
      // 26.7 additions (UUID-based full-replacement Set endpoints)
      'groupSettingsSet': 'groupSettingsGet',
      'dhcpv4SetOption': 'dhcpv4GetOption',
      'dhcpv6SetOption': 'dhcpv6GetOption',
      // 26.7.x additions
      'wirelessSettingsSetItem': 'wirelessSettingsGetItem',
      // 26.7.9 additions
      'tapSettingsSetItem': 'tapSettingsGetItem',
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
        // OPNsense only reads the model root key (e.g. "rule", "wireless") from the POST
        // body. If the caller sent flat fields, wrap them under that key instead of
        // silently sending a no-op update.
        const rootKeys = flattened && typeof flattened === 'object' ? Object.keys(flattened) : [];
        const incoming = callParams.data;
        if (rootKeys.length === 1 && incoming && typeof incoming === 'object' && !Array.isArray(incoming)
            && !(rootKeys[0] in incoming)) {
          console.error(\`Safe merge: wrapping flat data under "\${rootKeys[0]}"\`);
          callParams.data = { [rootKeys[0]]: incoming };
        }
        callParams.data = deepMerge(flattened, callParams.data);
        console.error(\`Safe merge: complete rule assembled with \${Object.keys(Object.values(callParams.data)[0] || {}).length} fields\`);
      }
    }

    // ── Positional path parameters, derived from the client method's own signature ──
    // Client methods look like:
    //   async settingsSetJob(uuid, data, config) { return this.http.post('/api/cron/settings/set_job/' + uuid, data, config); }
    // Each named parameter is filled from params by name (plus a few aliases). The signature is read
    // off the actual method being called, so a name shared by many modules with different signatures
    // (serviceRestart, settingsToggleRule, ...) always maps correctly. Regexes use character classes
    // instead of backslash escapes because this code is emitted from a template literal.
    const PARAM_ALIASES = {
      uuids: ['uuid'], selectedUuid: ['uuid'], sids: ['sid'], filenames: ['filename'],
      ifnames: ['ifname'], ips: ['ip'], name: ['alias'],
    };
    // Trailing path params that may be omitted on write endpoints: toggle without "enabled" flips,
    // service actions without an instance id act on the default instance.
    const OPTIONAL_PARAMS = new Set(['enabled', 'disabled', 'id', 'service', 'serviceId']);

    const fnSrc = Function.prototype.toString.call(method);
    const sigMatch = fnSrc.match(/^[^(]*[(]([^)]*)[)]/);
    const sigParams = sigMatch
      ? sigMatch[1].split(',').map((s) => s.split('=')[0].trim()).filter(Boolean)
      : [];
    const verbMatch = fnSrc.match(/this[.]http[.](get|post|put|delete|patch)[(]/);
    const isRead = verbMatch ? verbMatch[1] === 'get' : false;
    const pathParams = sigParams.filter((p) => p !== 'data' && p !== 'config');

    if (pathParams.length === 0) {
      // Body-only methods: unwrap data if present, otherwise pass params as the body
      if (Object.keys(callParams).length > 0) {
        return await method.call(moduleObj, callParams.data || callParams);
      }
      return await method.call(moduleObj);
    }

    const present = (v) => v !== undefined && v !== null && v !== '';
    // Endpoints whose toggle takes "disabled" (e.g. firewall d_nat/toggle_rule/{uuid}/{disabled})
    // accept the caller's "enabled" inverted; passing it through as-is would disable on enabled=1.
    if (pathParams.includes('disabled') && !present(callParams.disabled)
        && (String(callParams.enabled) === '0' || String(callParams.enabled) === '1')) {
      callParams.disabled = String(callParams.enabled) === '1' ? '0' : '1';
    }
    const lookup = (name) => {
      if (present(callParams[name])) return String(callParams[name]);
      for (const alt of PARAM_ALIASES[name] || []) {
        if (present(callParams[alt])) return String(callParams[alt]);
      }
      return undefined;
    };
    const values = pathParams.map(lookup);
    let lastProvided = -1;
    values.forEach((v, i) => { if (v !== undefined) lastProvided = i; });
    // A param may be left out only from the end (the URL cleanup interceptor drops the trailing
    // "/undefined" segments), and only on reads or for OPTIONAL_PARAMS.
    const missing = pathParams.filter((p, i) => values[i] === undefined
      && (i < lastProvided || !(isRead || OPTIONAL_PARAMS.has(p))));
    if (missing.length > 0) {
      throw new Error(\`Method '\${args.method}' requires parameter(s): \${missing.join(', ')}\`);
    }
    const callArgs = sigParams
      .filter((p) => p !== 'config')
      .map((p) => (p === 'data' ? (callParams.data || {}) : values[pathParams.indexOf(p)]));
    return await method.call(moduleObj, ...callArgs);
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