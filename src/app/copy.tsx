import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, Copy } from 'lucide-preact';

/**
 * Copy text to the clipboard. `done` is on for a moment after a successful copy; each copy restarts
 * that moment. The confirmation goes to a polite live region, so the control keeps its own name.
 */
function useCopy(text: string) {
  const [done, setDone] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      clearTimeout(timer.current);
      setDone(true);
      timer.current = window.setTimeout(() => setDone(false), 1400);
    } catch {
      /* clipboard blocked: nothing to confirm */
    }
  };
  return { done, copy };
}

const Announce = ({ done }: { done: boolean }) => <span class="sr-only" role="status">{done ? 'Copied' : ''}</span>;

export function CopyIconButton({ text, label, small }: { text: string; label: string; small?: boolean }) {
  const { done, copy } = useCopy(text);
  const size = small ? 14 : 16;
  return (
    <>
      <button type="button" class={'icon-btn copy' + (small ? ' copy-sm' : '') + (done ? ' is-done' : '')} onClick={copy} aria-label={label} title={label}>
        {done ? <Check size={size} /> : <Copy size={size} />}
      </button>
      <Announce done={done} />
    </>
  );
}

export function CopyTextButton({ text, label, icon }: { text: string; label: string; icon: ComponentChildren }) {
  const { done, copy } = useCopy(text);
  return (
    <>
      <button type="button" class="btn btn-quiet" onClick={copy} aria-label={label}>
        {done ? <Check size={14} /> : icon} {done ? 'Copied' : label}
      </button>
      <Announce done={done} />
    </>
  );
}
