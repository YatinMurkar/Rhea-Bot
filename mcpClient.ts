import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// We use lazy-loading to save RAM!
let mcpClient: Client | null = null;
let transport: StdioClientTransport | null = null;
let notionToolsCache: any[] = [];

/**
 * Flattens JSON Schema to remove $defs and $ref, which Gemini API rejects.
 */
function resolveSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema;
    
    const resolved = JSON.parse(JSON.stringify(schema));
    const defs = resolved.$defs || resolved.definitions || {};
    
    function walk(node: any) {
        if (!node || typeof node !== 'object') return;
        
        if (node.$ref) {
            const refPath = node.$ref.replace('#/$defs/', '').replace('#/definitions/', '');
            const def = defs[refPath];
            if (def) {
                const defCopy = JSON.parse(JSON.stringify(def));
                delete node.$ref;
                Object.assign(node, defCopy);
                walk(node);
            } else {
                delete node.$ref;
                node.type = "object"; // fallback
            }
        } else {
            for (const key in node) {
                if (typeof node[key] === 'object') {
                    walk(node[key]);
                }
            }
        }
    }
    
    walk(resolved);
    delete resolved.$defs;
    delete resolved.definitions;
    
    // Quick sanitization of unsupported keywords for Gemini
    function sanitize(node: any) {
        if (!node || typeof node !== 'object') return;
        if (node.anyOf || node.oneOf || node.allOf) {
            delete node.anyOf;
            delete node.oneOf;
            delete node.allOf;
            if (!node.type) node.type = "string"; // Gemini needs a basic type
        }
        for (const key in node) {
            if (typeof node[key] === 'object') {
                sanitize(node[key]);
            }
        }
    }
    sanitize(resolved);
    
    return resolved;
}

/**
 * Initializes the Notion MCP Server on-demand, fetches tools, and saves them.
 * This is meant to be run once at boot to cache the tool schemas.
 */
export async function initializeMcpTools(): Promise<any[]> {
    if (notionToolsCache.length > 0) return notionToolsCache;

    try {
        console.log("Starting Notion MCP Server to fetch tools...");
        const client = await startMcpClient();
        
        const toolsResponse = await client.listTools();
        notionToolsCache = toolsResponse.tools.map(tool => ({
            name: tool.name,
            description: tool.description || `Execute ${tool.name} via Notion MCP`,
            // @google/genai tool schemas expect parameters
            parameters: resolveSchema(tool.inputSchema)
        }));
        
        console.log(`Successfully fetched ${notionToolsCache.length} tools from Notion MCP.`);
        
        // Instantly kill it to save RAM
        await killMcpClient();
        
        return notionToolsCache;
    } catch (error) {
        console.error("Failed to initialize Notion MCP tools:", error);
        return [];
    }
}

export function getMcpToolsCache() {
    return notionToolsCache;
}

/**
 * Starts the MCP client connection
 */
async function startMcpClient(): Promise<Client> {
    if (mcpClient) return mcpClient;

    const token = process.env.NOTION_TOKEN;
    if (!token) {
        console.warn("NOTION_TOKEN environment variable is missing.");
    }

    // We use the direct node entrypoint to avoid the 'npx' wrapper process overhead!
    transport = new StdioClientTransport({
        command: "node",
        args: ["node_modules/@notionhq/notion-mcp-server/bin/cli.mjs"],
        env: {
            ...process.env,
            NOTION_TOKEN: token || ""
        }
    });

    mcpClient = new Client({
        name: "rhea-mcp-client",
        version: "1.0.0"
    }, {
        capabilities: {}
    });

    await mcpClient.connect(transport);
    return mcpClient;
}

/**
 * Kills the MCP client and releases RAM
 */
async function killMcpClient() {
    if (transport) {
        await transport.close();
        transport = null;
    }
    mcpClient = null;
    console.log("Notion MCP Server killed to save memory.");
}

/**
 * Executes a tool on-demand via the MCP server
 */
export async function executeMcpTool(toolName: string, args: any): Promise<any> {
    try {
        console.log(`Executing MCP Tool [${toolName}]...`);
        const client = await startMcpClient();
        
        const result = await client.callTool({
            name: toolName,
            arguments: args
        });
        
        // Immediately kill the server again to release RAM!
        await killMcpClient();
        
        return result;
    } catch (error) {
        console.error(`Error executing MCP tool ${toolName}:`, error);
        await killMcpClient(); // Clean up on error too
        throw error;
    }
}
