// One inline text editor, shared by every "edit this field on the card" flow.
//
// The proxy editor and the alias editor differ only in their labels, value and
// save handler, so they share this instead of duplicating the input + save +
// cancel layout. Keeping it in its own module also keeps AccountsPanel under the
// file-size budget.
import { h } from '../react.ts';
import { S } from '../styles.ts';
import { Button } from '../ui/Button.ts';
import { Spinner } from '../ui/Spinner.ts';
import type { Translator } from '../hooks/useTranslation.ts';

export interface InlineEditorOptions {
  /** Stable key for the row, so the reconciler replaces rather than reuses it. */
  key: string;
  value: string;
  placeholder: string;
  ariaLabel: string;
  saveLabel: string;
  cancelLabel: string;
  /** Non-null while this editor's save is in flight (renders a spinner). */
  busy: boolean;
  onChange: (next: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function renderInlineEditor(t: Translator, opts: InlineEditorOptions): unknown {
  return h('div', {
    key: opts.key,
    style: {
      marginTop: '8px',
      padding: '10px 12px',
      background: 'var(--agy-bg-subbox)',
      borderRadius: '7px',
      border: '1px solid var(--agy-border-subbox)',
    },
  },
    h('div', { style: { display: 'flex', gap: '8px' } },
      h('input', {
        style: S.input,
        value: opts.value,
        placeholder: opts.placeholder,
        'aria-label': opts.ariaLabel,
        onChange: (e: { target: { value: string } }) => opts.onChange(e.target.value),
      }),
      h(Button, {
        variant: 'primary', className: 'agy-btn', disabled: opts.busy,
        onClick: () => opts.onSave(),
      }, ...(opts.busy ? [Spinner(), opts.saveLabel] : [opts.saveLabel])),
      h(Button, {
        variant: 'default', className: 'agy-btn',
        onClick: () => opts.onCancel(),
      }, opts.cancelLabel),
    ),
  );
}
