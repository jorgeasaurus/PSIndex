import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Check, Copy } from 'lucide-preact';

/** Copy text to the clipboard; `done` flips on for a moment after a successful copy. */
function useCopy(text: string) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1400);
    } catch {
      /* clipboard blocked: nothing to confirm */
    }
  };
  return { done, copy };
}

export function CopyIconButton({ text, label, small }: { text: string; label: string; small?: boolean }) {
  const { done, copy } = useCopy(text);
  const size = small ? 14 : 16;
  return (
    <button type="button" class={'icon-btn copy' + (small ? ' copy-sm' : '') + (done ? ' is-done' : '')} onClick={copy} aria-label={done ? 'Copied' : label} title={label}>
      {done ? <Check size={size} /> : <Copy size={size} />}
    </button>
  );
}

export function CopyTextButton({ text, label, icon }: { text: string; label: string; icon: ComponentChildren }) {
  const { done, copy } = useCopy(text);
  return (
    <button type="button" class="btn btn-quiet" onClick={copy}>
      {done ? <Check size={14} /> : icon} {done ? 'Copied' : label}
    </button>
  );
}
