import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const workspacePath = String.raw`E:\Coding\MCP\workspace`;

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", workspacePath],
});

const client = new Client({
  name: "jarvis-mcp-client",
  version: "1.0.0",
});

try {
  await client.connect(transport);

  // Discover tools exposed by the MCP server
  const { tools } = await client.listTools();

  console.log("\nAvailable MCP tools:");
  console.log(tools.map((tool) => tool.name));

  const result = await client.callTool({
    name: "read_file",
    arguments: {
      path: String.raw`E:\Coding\MCP\workspace\hello.txt`,
    },
  });

  console.log("File contents:", result.content);
} catch (error) {
  console.error("MCP test failed:", error);
} finally {
  await client.close();
}
