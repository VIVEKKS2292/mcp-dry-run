import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const workspacePath = String.raw`E:\Coding\MCP\workspace`;
const repoPath = String.raw`E:\Coding\MCP`;
const targetFile = "workspace/hello.txt";
const commitMessage = "Hey AI did this commit for you! again";

const filesystemTransport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", workspacePath],
});

const gitTransport = new StdioClientTransport({
  command: "uvx",
  args: ["mcp-server-git", "--repository", repoPath],
});

const filesystemMcp = new Client({
  name: "jarvis-gemini-filesystem-mcp",
  version: "1.0.0",
});

const gitMcp = new Client({
  name: "jarvis-gemini-git-mcp",
  version: "1.0.0",
});

const model = "gemini-2.5-flash";
const mcpClients = [filesystemMcp, gitMcp];

try {
  await Promise.all([
    filesystemMcp.connect(filesystemTransport),
    gitMcp.connect(gitTransport),
  ]);

  console.log("JARVIS connected to Filesystem and Git MCP.");

  const [filesystemToolList, gitToolList] = await Promise.all([
    filesystemMcp.listTools(),
    gitMcp.listTools(),
  ]);

  // Expose only the tools required for this task.
  const allowedFilesystemTools = filesystemToolList.tools.filter((tool) =>
    ["read_file", "edit_file"].includes(tool.name),
  );

  const allowedGitTools = gitToolList.tools.filter((tool) =>
    ["git_status", "git_diff_unstaged", "git_add", "git_commit"].includes(
      tool.name,
    ),
  );

  const toolClients = new Map();

  const allowedTools = [
    ...allowedFilesystemTools.map((tool) => ({
      tool,
      client: filesystemMcp,
    })),
    ...allowedGitTools.map((tool) => ({
      tool,
      client: gitMcp,
    })),
  ].map(({ tool, client }) => {
    if (toolClients.has(tool.name)) {
      throw new Error(`Duplicate MCP tool name: ${tool.name}`);
    }

    toolClients.set(tool.name, client);
    return tool;
  });

  // Verify that all required tools are available.
  for (const requiredTool of [
    "read_file",
    "edit_file",
    "git_status",
    "git_add",
    "git_commit",
  ]) {
    if (!toolClients.has(requiredTool)) {
      throw new Error(`Required MCP tool unavailable: ${requiredTool}`);
    }
  }

  console.log("\nAvailable tools:");
  console.log(allowedTools.map(({ name }) => name).join("\n"));

  const functionDeclarations = allowedTools.map((tool) => ({
    name: tool.name,
    description: tool.description || `MCP tool: ${tool.name}`,
    parametersJsonSchema: tool.inputSchema,
  }));

  const config = {
    tools: [{ functionDeclarations }],
    toolConfig: {
      functionCallingConfig: {
        mode: "AUTO",
      },
    },
  };

  // The AI decides the order of operations.
  const userPrompt = `
You are JARVIS, an AI desktop assistant.

OBJECTIVE:
Update hello.txt so its entire content is exactly:

 Hey Google API's say free tier for 10 API requests per day. How empathetic of them!.

File location:
${workspacePath}\\hello.txt

Git repository:
${repoPath}

Git-relative file path:
${targetFile}

Commit message:
${commitMessage}

INSTRUCTIONS:

1. Read hello.txt using read_file to understand its current content.

2. If its content differs from the requested text, use edit_file
   to replace the existing content with the exact requested text.
   Use the actual current content when constructing the edit.
   Do not use any other editing tool.

3. Read hello.txt again to verify the final content is exactly:
   Hey Google API's say free tier for 10 API requests per day. How empathetic of them!.

4. Inspect Git status and decide whether the target file needs
   to be staged and committed.

5. Only after a successful edit and verification, you may call
   git_add to stage the target file.

6. After successful staging, you may call git_commit.

7. If you decide to commit, use the supplied commit message.
   Do not invent a different message.

8. Never stage or commit unrelated files.

9. If editing or verification fails, do not stage or commit.

10. You must decide which tools to call and when to call them.
    Do not assume that a successful edit automatically means
    a commit is necessary.

Report what you did and whether a commit was created.
`;

  const contents = [
    {
      role: "user",
      parts: [{ text: userPrompt }],
    },
  ];

  // These flags enforce safe ordering.
  let fileEdited = false;
  let fileVerified = false;
  let fileStaged = false;
  let fileCommitted = false;

  for (let turn = 0; turn < 10; turn++) {
    const response = await ai.models.generateContent({
      model,
      contents,
      config,
    });

    const functionCalls = response.functionCalls ?? [];

    if (functionCalls.length === 0) {
      console.log("\nJARVIS:", response.text);
      break;
    }

    // Preserve Gemini's function-call message.
    contents.push(response.candidates[0].content);

    const functionResponses = [];

    // Sequential execution preserves tool-call ordering.
    for (const call of functionCalls) {
      const client = toolClients.get(call.name);

      if (!client) {
        throw new Error(`Tool not permitted: ${call.name}`);
      }

      // Enforce the repository and target file in code.
      let args = call.args ?? {};

      if (call.name === "read_file") {
        args = {
          ...args,
          path: `${workspacePath}\\hello.txt`,
        };
      }

      if (call.name === "edit_file") {
        args = {
          ...args,
          path: `${workspacePath}\\hello.txt`,
        };
      }

      if (call.name === "git_status") {
        args = { repo_path: repoPath };
      }

      if (call.name === "git_diff_unstaged") {
        args = { repo_path: repoPath };
      }

      if (call.name === "git_add") {
        if (!fileEdited || !fileVerified) {
          throw new Error(
            "Cannot stage before the file is edited and verified.",
          );
        }

        args = {
          repo_path: repoPath,
          files: [targetFile],
        };
      }

      if (call.name === "git_commit") {
        if (!fileStaged) {
          throw new Error("Cannot commit before successful staging.");
        }

        args = {
          repo_path: repoPath,
          message: commitMessage,
        };
      }

      console.log(`\nJARVIS is calling: ${call.name}`);
      console.log("Arguments:", args);

      const result = await client.callTool({
        name: call.name,
        arguments: args,
      });

      if (result.isError) {
        throw new Error(
          `MCP tool ${call.name} failed: ${JSON.stringify(result.content)}`,
        );
      }

      if (call.name === "edit_file") {
        fileEdited = true;
        fileVerified = false;
      }

      if (call.name === "read_file") {
        // Verify the actual returned file contents.
        const actualText = result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");

        if (actualText === " Hey Google API's say free tier for 10 API requests per day. How empathetic of them!.") {
          fileVerified = true;
        } else if (
          actualText.includes(" Hey Google API's say free tier for 10 API requests per day. How empathetic of them!.") &&
          actualText.trim().endsWith(" Hey Google API's say free tier for 10 API requests per day. How empathetic of them!.")
        ) {
          // Accommodate a possible tool response wrapper.
          fileVerified = true;
        }
      }

      if (call.name === "git_add") {
        fileStaged = true;
      }

      if (call.name === "git_commit") {
        fileCommitted = true;
      }

      functionResponses.push({
        functionResponse: {
          name: call.name,
          response: {
            result: result.content,
            isError: false,
          },
        },
      });
    }

    // Give Gemini the results so it can decide the next step.
    contents.push({
      role: "user",
      parts: functionResponses,
    });

    if (turn === 9) {
      console.log("Maximum tool-call turns reached.");
    }
  }

  console.log("\n--- Final execution summary ---");
  console.log("File edited:", fileEdited);
  console.log("File verified:", fileVerified);
  console.log("File staged:", fileStaged);
  console.log("Commit created:", fileCommitted);
} catch (error) {
  console.error("\nJARVIS error:", error);
} finally {
  const closeResults = await Promise.allSettled(
    mcpClients.map((client) => client.close()),
  );

  for (const result of closeResults) {
    if (result.status === "rejected") {
      console.error("Failed to close an MCP client:", result.reason);
    }
  }
}
