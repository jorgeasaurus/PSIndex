// "Use with AI agents": how to point a client at the public /mcp endpoint. README ## MCP gives
// the same setups. Shapes checked against the vendors' docs in November 2026, except Cursor's,
// which is carried over from the earlier check (cursor.com could not be reached this time):
//   Cursor: ~/.cursor/mcp.json or .cursor/mcp.json, top-level mcpServers, a url and no type.
//     https://cursor.com/docs/mcp
//   VS Code (Copilot harness): workspace-root .mcp.json or ~/.copilot/mcp-config.json, top-level
//     mcpServers, type "http". .vscode/mcp.json with "servers" belongs to the deprecated Local harness.
//     https://code.visualstudio.com/docs/agents/reference/mcp-configuration
//   Claude Code: project .mcp.json, mcpServers with type "http" (an entry without type is stdio).
//     https://code.claude.com/docs/en/mcp
//   Claude Desktop and claude.ai: a custom connector. claude_desktop_config.json holds local servers only.
//     https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
import { useEffect, useRef, useState } from 'preact/hooks';
import { Copy, Info, X } from 'lucide-preact';
import { CopyIconButton, CopyTextButton } from './copy';

const MCP_URL = 'https://psindex.vercel.app/mcp';

const SETUPS: { client: string; where: string; note?: string; config?: object }[] = [
  { client: 'Cursor', where: '~/.cursor/mcp.json or .cursor/mcp.json', config: { mcpServers: { psindex: { url: MCP_URL } } } },
  {
    client: 'VS Code',
    where: '.mcp.json at the workspace root',
    note: 'The same JSON works in ~/.copilot/mcp-config.json for every workspace.',
    config: { mcpServers: { psindex: { type: 'http', url: MCP_URL } } },
  },
  {
    client: 'Claude Code',
    where: '.mcp.json in the project',
    note: `Or run: claude mcp add --transport http psindex ${MCP_URL}`,
    config: { mcpServers: { psindex: { type: 'http', url: MCP_URL } } },
  },
  {
    client: 'Claude Desktop and claude.ai',
    where: 'Customize → Connectors → Add custom connector',
    note: 'Enter the endpoint above. It needs no sign-in. claude_desktop_config.json holds local servers only.',
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
        onClick={(e) => {
          const el = ref.current;
          if (!el || e.target !== el) return;
          // A backdrop click targets the dialog but lands outside its box. The scrollbar is the
          // same target, and that point is inside the box, so it must stay open.
          const r = el.getBoundingClientRect();
          const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
          if (!inside) el.close();
        }}
      >
        <div class="mcp-head">
          <h2 id="mcp-title">Use with AI agents</h2>
          <button type="button" class="icon-btn" aria-label="Close" onClick={() => ref.current?.close()}><X size={18} /></button>
        </div>
        <div class="mcp-body">
          <p id="mcp-lede">Search Graph, Az, Entra, Exchange, and MECM cmdlets over MCP, with no authentication and read-only tools.</p>

          <section class="mcp-block" aria-label="Endpoint">
            <h3>Endpoint</h3>
            <div class="mcp-endpoint">
              <code>{MCP_URL}</code>
              <CopyTextButton text={MCP_URL} label="Copy endpoint" icon={<Copy size={14} />} />
            </div>
          </section>

          <div class="mcp-setups">
            {SETUPS.map((setup) => {
              const text = setup.config && JSON.stringify(setup.config, null, 2);
              return (
                <section class="mcp-block" key={setup.client} aria-label={setup.client}>
                  <h3>{setup.client}</h3>
                  <p class="mcp-file">{setup.where}</p>
                  {setup.note && <p class="mcp-note">{setup.note}</p>}
                  {text && <div class="code">
                    <pre><code>{text}</code></pre>
                    <CopyIconButton text={text} label={`Copy ${setup.client} config`} small />
                  </div>}
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
