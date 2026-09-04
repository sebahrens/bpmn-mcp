import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('agent client installation documentation', () => {
  const readme = read('README.md');
  const installation = read('docs/agent-client-installation.md');
  const troubleshooting = read('docs/agent-client-troubleshooting.md');

  function shellCommands(markdown: string): string[] {
    const commands: string[] = [];
    for (const [, block] of markdown.matchAll(/```(?:ba)?sh\n([\s\S]*?)```/g)) {
      let logicalLine = '';
      for (const rawLine of block.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        logicalLine += `${logicalLine ? ' ' : ''}${line.replace(/\\$/, '').trim()}`;
        if (!line.endsWith('\\')) {
          commands.push(logicalLine.replace(/^"([^" ]+)"/, '$1'));
          logicalLine = '';
        }
      }
    }
    return commands;
  }

  it('leads with the Make happy path and links both detailed guides', () => {
    const happyPath = readme.match(
      /### Install for Codex and Claude Code\n[\s\S]*?```bash\n([\s\S]*?)```/
    )?.[1];
    expect(happyPath).toContain('npm ci');
    expect(happyPath).toContain('make install');
    expect(happyPath).toContain('make doctor');
    expect(readme).toContain('(docs/agent-client-installation.md)');
    expect(readme).toContain('(docs/agent-client-troubleshooting.md)');
    expect(existsSync(resolve(root, 'docs/agent-client-installation.md'))).toBe(true);
    expect(existsSync(resolve(root, 'docs/agent-client-troubleshooting.md'))).toBe(true);
    expect(readme).toContain('preserves diagrams by default');
  });

  it('documents the complete supported lifecycle and its automated verification owner', () => {
    for (const command of [
      'make install',
      'make install-codex',
      'make install-claude',
      'make update',
      'make doctor',
      'make uninstall',
      'PREFIX=',
      'MCP_BPMN_DIAGRAMS_PATH=',
      'PURGE_DIAGRAMS=',
      'CONFIRM_PURGE='
    ]) {
      expect(installation).toContain(command);
    }

    expect(installation).toContain('npm run test:installer');
    expect(installation).toContain('Uninstall preserves the configured diagram directory by default');
  });

  it('maps every documented shell command to automated or explicit smoke evidence', () => {
    const owners = [
      { command: /^(git clone|cd |npm ci$)/, evidence: 'checkout preparation' },
      { command: /^(pwd -P|command -v|node -p|export (PUPPETEER_EXECUTABLE_PATH|MCP_BPMN_BROWSER_ARGS)=)/,
        evidence: 'environment probes' },
      { command: /^make (install(?: |$)|install-codex|install-claude|update|doctor|uninstall)/,
        evidence: 'npm run test:installer' },
      { command: /^(codex mcp (list|get)|claude mcp (list|get))/,
        evidence: 'Explicit authenticated manual smoke' },
      { command: /^(codex mcp remove|claude mcp remove --scope user)/,
        evidence: 'option ordering' },
      { command: /^(artifact_dir=|consumer_dir=|npm (run build$|start$|pack |install |run build:bundle|run start:bundle)|\$consumer_dir\/)/,
        evidence: 'npm run test:package' },
      { command: /^npm run test:evaluations$/, evidence: 'npm run test:evaluations' },
      { command: /^npm run eval:(codex|claude)/, evidence: 'Explicit opt-in model smoke' }
    ];
    const commands = [
      ...shellCommands(readme.split('## 📚 API Reference')[0]),
      ...shellCommands(installation),
      ...shellCommands(troubleshooting)
    ];

    for (const command of commands) {
      const owner = owners.find(({ command: pattern }) => pattern.test(command));
      expect({ command, owner: owner?.evidence }).toEqual({
        command,
        owner: expect.any(String)
      });
      expect(installation.toLowerCase()).toContain(owner!.evidence.toLowerCase());
    }
  });

  it('pins real-client checks, selectors, and correct CLI option ordering', () => {
    for (const command of [
      'codex mcp list',
      'codex mcp get mcp-bpmn --json',
      'claude mcp list',
      'claude mcp get mcp-bpmn'
    ]) {
      expect(installation).toContain(command);
    }

    expect(installation).toContain('$bpmn-modeler');
    expect(installation).toContain('/bpmn-modeler');
    expect(installation).toContain('/mcp-bpmn:bpmn-modeler');
    expect(installation).toContain('Installation Smoke');
    expect(installation).toMatch(/Explicit authenticated manual smoke below/i);
    expect(troubleshooting).toContain('claude mcp remove --scope user mcp-bpmn');
  });

  it('keeps generic MCP, standalone skills, and unpublished plugins distinct', () => {
    expect(installation).toContain('Generic MCP only');
    expect(installation).toContain('A standalone skill does not install or start the MCP server');
    expect(installation).toContain('does not currently claim a published marketplace entry');
    expect(readme).toContain('Generic stdio setup');
    expect(readme).toMatch(/Public marketplace installation is a later distribution\s+path/);
  });

  it('documents WSL-native tools, autosave safety, browser fallback, and non-destructive recovery', () => {
    expect(installation).toContain('not `/mnt/c/...`');
    expect(installation).toContain("node -p 'process.platform");
    expect(installation).toContain('successful mutation autosave');
    expect(installation).toContain('exact filename and explicit intent');
    expect(installation).toContain('XML-only operation');
    expect(installation).toContain('PUPPETEER_EXECUTABLE_PATH');
    expect(installation).toContain('does not persist `PUPPETEER_EXECUTABLE_PATH`');
    // The root/sandbox failure mode is the one agent runtimes actually hit, and
    // it used to be reported as a missing browser.
    expect(readme).toContain('MCP_BPMN_BROWSER_ARGS');
    expect(readme).toContain('--no-sandbox --disable-setuid-sandbox');
    expect(troubleshooting).toContain('MCP_BPMN_BROWSER_ARGS');
    expect(troubleshooting).toContain('Running as root\nwithout --no-sandbox is not supported');
    expect(troubleshooting).toMatch(/Do not\s+hand-edit `~\/.codex\/config\.toml`/);
    expect(troubleshooting).toContain('make doctor PREFIX="$HOME/.local/share/mcp-bpmn-work"');
    expect(troubleshooting).toContain('make install-codex FORCE=1');
    expect(troubleshooting).toContain('does not rewrite other MCP entries or unrelated client settings');
  });
});
