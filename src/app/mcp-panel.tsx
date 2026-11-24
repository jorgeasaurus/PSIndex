// "Use with AI agents": how to point a client at the public /mcp endpoint.
// Shapes checked against the vendors' docs in November 2026:
//   Cursor remote servers are ~/.cursor/mcp.json, top-level mcpServers, a url and no type.
//     https://cursor.com/docs/mcp
//   VS Code's Copilot harness reads workspace .mcp.json (or ~/.copilot/mcp-config.json),
//     top-level mcpServers, with type "http". .vscode/mcp.json and a top-level "servers"
//     object are the deprecated Local harness, which that harness does not read.
//     https://code.visualstudio.com/docs/agents/reference/mcp-configuration
//   Claude Desktop's claude_desktop_config.json is stdio only, so a remote URL goes through
//     npx mcp-remote. The official remote path is a custom connector with this URL and no sign-in.
//     https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
import { useEffect, useRef, useState } from 'preact/hooks';
import { Copy, Info, X } from 'lucide-preact';
import { CopyIconButton, CopyTextButton } from './copy';

const MCP_URL = 'https://psindex.vercel.app/mcp';

const SETUPS: { client: string; file: string; note?: string; label: string; config: unknown }[] = [
  {
    client: 'Cursor',
    file: '~/.cursor/mcp.json',
    label: 'Copy Cursor config',
    config: { mcpServers: { psindex: { url: MCP_URL } } },
  },
  {
    client: 'VS Code',
    file: '.mcp.json',
    note: 'Workspace file. The same JSON works in ~/.copilot/mcp-config.json.',
    label: 'Copy VS Code config',
    config: { mcpServers: { psindex: { type: 'http', url: MCP_URL } } },
  },
  {
    client: 'Claude Desktop',
    file: 'claude_desktop_config.json',
    note: 'Local config, via npx mcp-remote. A custom connector can use the endpoint with no sign-in.',
    label: 'Copy Claude Desktop config',
    config: {
      mcpServers: {
        psindex: { command: 'npx', args: ['-y', 'mcp-remote', MCP_URL] },
      },
    },
  },
];

const TOOLS: [string, string][] = [
  ['search_cmdlets', 'Search cmdlet names and descriptions, ranked the same way as this site.'],
  ['get_cmdlet', 'Read one cmdlet’s syntax, parameters, examples, and permissions.'],
  ['list_modules', 'List modules and how many cmdlets each one contains.'],
];

/** Header button and modal. The dialog element supplies the focus trap, Escape, and the backdrop. */
export function McpPanel() {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onClose = () => setOpen(false);
    el.addEventListener('close', onClose);
    return () => el.removeEventListener('close', onClose);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      if (!el.open) el.showModal();
      // Name the dialog for the focused element. showModal saved the trigger, and close() returns there.
      el.focus({ preventScroll: true });
    } else if (el.open) {
      el.close();
    }
  }, [open]);

  return (
    <>
      <button
        type="button"
        class="icon-btn"
        aria-label="Use with AI agents"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="mcp-panel"
        onClick={() => setOpen(true)}
      >
        <Info size={18} />
      </button>
      <dialog
        ref={ref}
        id="mcp-panel"
        class="mcp"
        aria-labelledby="mcp-title"
        aria-describedby="mcp-lede"
        aria-modal="true"
        // The page's own Escape handler would preventDefault and stop the dialog from closing.
        onKeyDown={(e) => { if (e.key === 'Escape') e.stopPropagation(); }}
        onClick={(e) => { if (e.target === e.currentTarget) ref.current?.close(); }}
      >
        <div class="mcp-head">
          <h2 id="mcp-title">Use with AI agents</h2>
          <button type="button" class="icon-btn" aria-label="Close" onClick={() => ref.current?.close()}><X size={18} /></button>
        </div>
        <div class="mcp-body">
          <p id="mcp-lede">Search PSIndex cmdlets over MCP, with no authentication and read-only tools.</p>

          <section class="mcp-block" aria-label="Endpoint">
            <h3>Endpoint</h3>
            <div class="mcp-endpoint">
              <code>{MCP_URL}</code>
              <CopyTextButton text={MCP_URL} label="Copy endpoint" icon={<Copy size={14} />} />
            </div>
          </section>

          <div class="mcp-setups">
            {SETUPS.map((setup) => {
              const text = JSON.stringify(setup.config, null, 2);
              return (
                <section class="mcp-block" key={setup.client} aria-label={setup.client}>
                  <h3>{setup.client}</h3>
                  <p class="mcp-file">{setup.file}</p>
                  {setup.note && <p class="mcp-note">{setup.note}</p>}
                  <div class="code">
                    <pre><code>{text}</code></pre>
                    <CopyIconButton text={text} label={setup.label} small />
                  </div>
                </section>
              );
            })}
          </div>

          <section class="mcp-block" aria-label="Tools">
            <h3>Tools</h3>
            <dl class="mcp-tools">
              {TOOLS.map(([name, desc]) => (
                <div key={name}>
                  <dt><code>{name}</code></dt>
                  <dd>{desc}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </dialog>
    </>
  );
}
